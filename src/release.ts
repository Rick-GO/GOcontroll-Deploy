// Signing and publishing a release: the steps of GOcontroll-Deployment-Tool/tools/r2.py
// publish(). The private key is the colleague's, never Deploy's (since 0.7.0).
//
// The browser does the heavy part (small uploads, little Worker CPU): it reads the .bin/.srec,
// compresses it with CompressionStream('deflate') (a zlib stream) and sends the compressed
// payload with its raw size; or it sends a ready-made GOCO container unchanged. Here the
// payload is hashed and put behind a header (src/goco.ts), never inflated.
//
// Signing, for an application with a public key (STATE keys/<APP_ID>.json):
//   1. POST /api/sign/scope (signingScope): the Worker answers the header bytes a signature
//      covers (goco.ts signedScope(): the signed header's common body + the public key), from
//      the payload's size, raw size and SHA-256, or from the header of an unsigned container;
//   2. the browser signs scope + payload with the private key the colleague gave
//      (public/js/signing.js; it first checks that key against the public key);
//   3. the upload carries the 64-byte signature (`signature`, base64) and nothing else of the key.
//      Here the scope is built again from what was uploaded, and the signature must verify
//      against the folder's public key before anything is written (422, field `signature`).
// A form or body that carries a private key is refused unread (400): Deploy keeps none, logs none.

import type { Env, User } from './env';
import {
  binaryKey, binaryUrl, compareVersions, distributionUrls, folderDistribution, latestOf, manifestKey, manifestKind,
  putBinary, readManifest, s1Entries, writeManifest,
} from './bucket';
import { z } from 'zod';
import {
  GocoError, STM32_APP_MAX_SIZE, buildHeader, equalBytes, fromHex, headerWithSignature, isContainer, looksLikeZlib, parseContainer,
  readHeader, sha256, signedScope, toHex, verifySignature, type GocoHeader,
} from './goco';
import { parsePublicKeyHex } from './keys';
import { HttpError, parse } from './lib/http';
import { s1AppId, versionField } from './lib/validate';
import { deleteUnderWay } from './delete';
import { audit, loadFolderSettings, loadKey } from './state';

/** Largest compressed payload accepted: a raw image that fills the flash, plus zlib's worst-case overhead. */
const MAX_PAYLOAD = STM32_APP_MAX_SIZE + 0x10000;

/** What the browser sent: a compressed payload with its raw size, or a whole container. */
export type Source =
  | { kind: 'payload'; payload: Uint8Array<ArrayBuffer>; rawSize: number }
  | { kind: 'container'; data: Uint8Array<ArrayBuffer> };

export interface Prepared {
  header: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
  payloadSha256: Uint8Array;
  signed: boolean;
  publicKey: string | null;
}

const fail = (status: number, message: string, field?: string) => new HttpError(status, message, field);

/** The answer to a request that carries a private key. The key is not read, kept or logged. */
const NO_PRIVATE_KEYS = 'Deploy does not take private keys: the page signs in your browser and sends only the signature. Reload the page and try again.';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * The signature the browser made (`signature`: 64 bytes, base64), or null when there is none.
 * A form with a private key field is refused before anything else is read.
 */
export function readSignature(form: FormData): Uint8Array | null {
  if (form.has('privateKey') || form.has('private_key')) throw fail(400, NO_PRIVATE_KEYS, 'privateKey');
  const value = form.get('signature');
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.trim())) throw fail(400, 'The signature must be 64 bytes, base64.', 'signature');
  return Uint8Array.from(atob(value.trim()), (ch) => ch.charCodeAt(0));
}

/** The message when a signature does not verify against the application's public key. */
const mismatch = (appId: string) => `The signature does not verify against the public key of ${appId}: the private key that signed it is not this application's. Nothing was written.`;

/** Read `payload` + `rawSize` or `container` from the form; exactly one of them. */
export async function readSource(form: FormData): Promise<Source> {
  const payload = form.get('payload');
  const container = form.get('container');
  const isFile = (v: unknown): v is File => typeof v === 'object' && v !== null && typeof (v as File).arrayBuffer === 'function';
  if (isFile(payload) && isFile(container)) throw fail(400, 'Send either a payload or a container, not both.', 'file');
  if (isFile(container)) {
    if (container.size > MAX_PAYLOAD + 211) throw fail(413, 'The container is larger than the S1 flash can hold.', 'file');
    const data = new Uint8Array(await container.arrayBuffer());
    if (!isContainer(data)) throw fail(422, 'This file does not start with GOCO, so it is not a GOcontroll container.', 'file');
    return { kind: 'container', data };
  }
  if (!isFile(payload)) throw fail(400, 'Choose a firmware file.', 'file');
  if (payload.size === 0) throw fail(422, 'The firmware file is empty.', 'file');
  if (payload.size > MAX_PAYLOAD) throw fail(413, 'The compressed image is larger than the S1 flash can hold.', 'file');
  const rawText = form.get('rawSize');
  const rawSize = typeof rawText === 'string' && /^\d{1,10}$/.test(rawText.trim()) ? Number(rawText.trim()) : NaN;
  if (!Number.isSafeInteger(rawSize) || rawSize <= 0) throw fail(400, 'The raw size of the image is missing.', 'file');
  if (rawSize > STM32_APP_MAX_SIZE) {
    throw fail(422, `The image is ${rawSize} bytes; at most ${STM32_APP_MAX_SIZE} fits before the protected flash region at 0x081F8000.`, 'file');
  }
  const bytes = new Uint8Array(await payload.arrayBuffer());
  if (!looksLikeZlib(bytes)) throw fail(422, 'The payload is not a zlib stream (compress it with deflate, not deflate-raw or gzip).', 'file');
  return { kind: 'payload', payload: bytes, rawSize };
}

/**
 * The container to write or hand out: header + payload, checked against the folder.
 * `signature` given (with the folder's `publicKey`): the result is signed with it, built here
 * around the payload (an unsigned container is re-wrapped, its payload taken over) and checked
 * against the public key; one that does not verify is refused. `publicKey` without a signature:
 * a container signed with another key is refused, one signed with this key goes as it is.
 */
export async function prepare(source: Source, appId: string, version: string, publicKey: Uint8Array | null, signature: Uint8Array | null): Promise<Prepared> {
  if (signature && !publicKey) throw fail(422, `${appId} has no public key to check a signature against.`, 'signature');
  if (source.kind === 'payload') {
    const digest = await sha256(source.payload);
    if (signature) return signedWith(appId, version, source.payload, source.rawSize, digest, publicKey!, signature);
    const header = await buildHeader({ appId, version, payload: source.payload, rawSize: source.rawSize, payloadSha256: digest });
    return { header, payload: source.payload, payloadSha256: digest, signed: false, publicKey: null };
  }

  let parsed;
  try {
    parsed = await parseContainer(source.data);
  } catch (err) {
    if (err instanceof GocoError) throw fail(422, `The container is not valid: ${err.message}.`, 'file');
    throw err;
  }
  const h = parsed.header;
  if (h.appId !== appId) throw fail(422, `The container is for App ID ${h.appId}, not ${appId}.`, 'file');
  if (h.version !== version) throw fail(422, `The container holds version ${h.version}, not ${version}.`, 'version');
  if (h.uncompressedSize > STM32_APP_MAX_SIZE) throw fail(422, `The image is ${h.uncompressedSize} bytes; at most ${STM32_APP_MAX_SIZE} fits before the protected flash region.`, 'file');
  if (h.signed && publicKey && !equalBytes(h.publicKey, publicKey)) {
    throw fail(422, 'The container is signed with another key than the public key of this application.', 'file');
  }
  const payload = source.data.subarray(h.headerSize) as Uint8Array<ArrayBuffer>;
  // A container signed already (with this key, when the folder has one) goes as it is.
  if (signature && !h.signed) return signedWith(appId, version, payload, h.uncompressedSize, h.sha256, publicKey!, signature);
  return {
    header: source.data.subarray(0, h.headerSize) as Uint8Array<ArrayBuffer>,
    payload,
    payloadSha256: h.sha256,
    signed: h.signed,
    publicKey: h.publicKey ? toHex(h.publicKey).toUpperCase() : null,
  };
}

/** A signed header around `payload` with the browser's signature, refused unless it verifies against `publicKey`. */
async function signedWith(appId: string, version: string, payload: Uint8Array<ArrayBuffer>, rawSize: number, digest: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): Promise<Prepared> {
  let header: Uint8Array<ArrayBuffer>;
  try {
    header = headerWithSignature(signedScope({ appId, version, compressedSize: payload.length, rawSize, payloadSha256: digest, publicKey }), signature);
  } catch (err) {
    if (err instanceof GocoError) throw fail(422, `The signature cannot be used: ${err.message}.`, 'signature');
    throw err;
  }
  if (!(await verifySignature(readHeader(header), header, payload))) throw fail(422, mismatch(appId), 'signature');
  return { header, payload, payloadSha256: digest, signed: true, publicKey: toHex(publicKey).toUpperCase() };
}

/** The header of a container without the checks of prepare(), or null. */
function peekHeader(source: Source): GocoHeader | null {
  if (source.kind !== 'container') return null;
  try {
    return readHeader(source.data);
  } catch {
    return null; // prepare() says what is wrong with it
  }
}

/** The common fields of /api/sign and /api/releases. A container names its own version when none is typed. */
export function readFields(form: FormData, source: Source): { appId: string; version: string } {
  const appId = s1AppId(form.get('appId'));
  const raw = form.get('version');
  const typed = typeof raw === 'string' ? raw.trim() : '';
  const fromHeader = typed ? null : peekHeader(source)?.version;
  return { appId, version: versionField(fromHeader ?? typed) };
}

// ── The scope a signature covers ─────────────────────────────────────────────

const ScopeBody = z.object({
  appId: z.string({ message: 'Fill in the App ID.' }),
  version: z.string({ message: 'Fill in the version (major.minor.patch).' }),
  payload: z.object({
    size: z.number().int().positive(),
    rawSize: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'The SHA-256 of the payload is 64 hex characters.'),
  }, { message: 'Send the size, raw size and SHA-256 of the payload, or the header of the container.' }).optional(),
  containerHeader: z.string().max(400).optional(),  // base64 of the first bytes (at most 211) of an unsigned container
});

/**
 * POST /api/sign/scope: the bytes the browser signs, followed by the payload (goco.ts
 * signedScope()), for an S1 application with a public key. `payloadOffset`: where the payload
 * starts in what the browser holds (0 for a compressed image, the header size for a container).
 */
export async function signingScope(env: Env, body: unknown) {
  if (body && typeof body === 'object' && ('privateKey' in body || 'private_key' in body)) throw fail(400, NO_PRIVATE_KEYS, 'privateKey');
  const b = parse(ScopeBody, body);
  const appId = s1AppId(b.appId);
  const version = versionField(b.version);
  const [key, settings, manifest] = await Promise.all([loadKey(env, appId), loadFolderSettings(env, appId), readManifest(env.DEPLOY_BUCKET, appId)]);
  if (manifestKind(manifest?.doc ?? {}) === 'linux' || (settings?.controller && settings.controller !== 'S1')) {
    throw fail(422, `${appId} is not an S1 application: only S1 firmware is signed.`);
  }
  if (!key) throw fail(422, `The application ${appId} has no public key, so there is nothing to sign with. Attach one, or publish unsigned.`, 'signature');
  const publicKey = parsePublicKeyHex(key.value.public_key);

  let compressedSize: number, rawSize: number, digest: Uint8Array, payloadOffset: number;
  if (b.containerHeader !== undefined) {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(b.containerHeader), (ch) => ch.charCodeAt(0)); } catch { throw fail(400, 'The container header is not base64.', 'file'); }
    let h: GocoHeader;
    try { h = readHeader(bytes); } catch (err) {
      if (err instanceof GocoError) throw fail(422, `The container is not valid: ${err.message}.`, 'file');
      throw err;
    }
    if (h.appId !== appId) throw fail(422, `The container is for App ID ${h.appId}, not ${appId}.`, 'file');
    if (h.version !== version) throw fail(422, `The container holds version ${h.version}, not ${version}.`, 'version');
    if (h.signed) {
      throw fail(422, equalBytes(h.publicKey, publicKey)
        ? 'The container is signed with this application\u2019s key already: it needs no signature.'
        : 'The container is signed with another key than the public key of this application.', 'file');
    }
    if (h.uncompressedSize > STM32_APP_MAX_SIZE) throw fail(422, `The image is ${h.uncompressedSize} bytes; at most ${STM32_APP_MAX_SIZE} fits before the protected flash region.`, 'file');
    ({ compressedSize, uncompressedSize: rawSize, sha256: digest, headerSize: payloadOffset } = h);
  } else if (b.payload) {
    if (b.payload.size > MAX_PAYLOAD) throw fail(413, 'The compressed image is larger than the S1 flash can hold.', 'file');
    if (b.payload.rawSize > STM32_APP_MAX_SIZE) throw fail(422, `The image is ${b.payload.rawSize} bytes; at most ${STM32_APP_MAX_SIZE} fits before the protected flash region at 0x081F8000.`, 'file');
    compressedSize = b.payload.size;
    rawSize = b.payload.rawSize;
    digest = fromHex(b.payload.sha256);
    payloadOffset = 0;
  } else {
    throw fail(400, 'Send the size, raw size and SHA-256 of the payload, or the header of the container.', 'file');
  }
  const scope = signedScope({ appId, version, compressedSize, rawSize, payloadSha256: digest, publicKey });
  return { appId, version, publicKey: key.value.public_key, scope: b64(scope), payloadOffset };
}

// ── Sign ─────────────────────────────────────────────────────────────────────

export async function signOnly(env: Env, user: User, form: FormData): Promise<{ body: Blob; filename: string; size: number }> {
  const signature = readSignature(form);
  const source = await readSource(form);
  const { appId, version } = readFields(form, source);
  const key = await loadKey(env, appId);
  if (!key) throw fail(404, `The application ${appId} has no public key. Attach one first (Key generator, or its page).`);
  const publicKey = parsePublicKeyHex(key.value.public_key);
  const peek = peekHeader(source);
  if (!signature && !(peek?.signed && equalBytes(peek.publicKey, publicKey))) {
    throw fail(422, `Sign it with the private key of ${appId} (step 2): the page signs in your browser and sends the signature.`, 'signature');
  }
  const prepared = await prepare(source, appId, version, publicKey, signature);
  const size = prepared.header.length + prepared.payload.length;
  // Logged before the file leaves: no signature without its audit entry.
  await audit(env, { action: 'sign', app_id: appId, version, actor: user.email, signed: true, sha256: toHex(prepared.payloadSha256), size });
  return { body: new Blob([prepared.header, prepared.payload]), filename: `${appId}-${version}.bin`, size };
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishResult {
  binaryKey: string;
  binaryUrl: string;
  manifestKey: string;
  version: string;
  releaseDate: string;
  previousLatest: string | null;
  replaced: boolean;
  latestMovedBack: boolean;
  signed: boolean;
}

export async function publish(env: Env, user: User, form: FormData): Promise<PublishResult> {
  const signature = readSignature(form);
  const description = typeof form.get('description') === 'string' ? (form.get('description') as string).trim() : '';
  const source = await readSource(form);
  const { appId, version } = readFields(form, source);
  if (!description) throw fail(400, 'Describe what changed: the manifest needs a description for every release.', 'description');
  if (description.length > 2000) throw fail(400, 'The description is at most 2000 characters.', 'description');
  const replace = form.get('replace') === '1';
  const bases = distributionUrls(env.DISTRIBUTION_URLS);

  // A folder being deleted gets nothing new; one set to a Linux controller gets no S1 release.
  const [manifest, settings, deleting] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId), loadFolderSettings(env, appId), deleteUnderWay(env, appId),
  ]);
  if (deleting) throw new HttpError(409, `The folder ${appId} is being deleted. Finish or wait for that first.`);
  if (settings?.controller && settings.controller !== 'S1') {
    throw fail(422, `The folder ${appId} is for ${settings.controller} controllers: publish a Linux release (go-deploy package) there, not S1 firmware.`);
  }

  // The manifest as it stands: a folder in another format is never written into.
  if (manifest?.error) throw fail(422, `The folder ${appId} holds a manifest.json that cannot be read (${manifest.error}); fix it before publishing.`);
  const doc: Record<string, unknown> = manifest?.doc ? structuredClone(manifest.doc) : {};
  const kind = manifestKind(doc);
  if (kind === 'linux') throw fail(422, `The folder ${appId} holds a manifest for Linux controllers (go-deploy tarballs), not S1 releases. Check the App ID.`);
  if (manifest && Object.keys(doc).length && kind !== 's1') throw fail(422, `The manifest of ${appId} has no field "binaries"; Deploy does not write into it.`);
  const binaries = (kind === 's1' ? doc.binaries : {}) as Record<string, unknown>;

  const standing = binaries[version];
  const exists = Boolean(standing) && typeof standing === 'object';
  if (exists && !replace) {
    const s = standing as Record<string, unknown>;
    throw new HttpError(409, `Version ${version} is already published (${s.release_date || 'date unknown'}: ${s.description || 'no description'}). Raise the version number, or replace it on purpose.`, 'version');
  }

  // Never two hosts in one manifest (§2.1): an existing folder keeps the host it names.
  const entries = s1Entries(doc);
  let distribution: string;
  if (entries.length) {
    const named = folderDistribution(entries, latestOf(doc, 's1')).distributionUrl;
    if (!named || !bases.includes(named)) {
      throw fail(422, `The manifest of ${appId} names ${named ?? 'no valid URL'}, which is not one of this bucket’s distribution URLs (${bases.join(', ')}).`);
    }
    distribution = named;
  } else if (settings?.distribution_url && bases.includes(settings.distribution_url)) {
    // A folder made here (POST /api/folders) chose its host then.
    distribution = settings.distribution_url;
  } else {
    const field = form.get('distributionUrl');
    const asked = typeof field === 'string' ? field.trim().replace(/\/+$/, '') : '';
    if (asked && !bases.includes(asked)) {
      throw fail(422, `The distribution URL must be one of ${bases.join(', ')}.`, 'distributionUrl');
    }
    distribution = asked || bases[0];
    if (!distribution) throw fail(503, 'No distribution URL is configured (DISTRIBUTION_URLS).');
  }

  // Signing: an application with a public key only gets releases signed with its private key:
  // signed in the browser (the signature is checked here, in prepare()), or a container signed
  // with that key already. Without a public key there is nothing to check a signature against.
  const key = await loadKey(env, appId);
  if (signature && !key) throw fail(422, `The application ${appId} has no public key. Attach one, or publish unsigned.`, 'signature');
  const activePublic = key ? parsePublicKeyHex(key.value.public_key) : null;
  const peek = peekHeader(source);
  if (key && !signature && !peek?.signed) {
    throw fail(422, `The application ${appId} has a public key, so a release must be signed with its private key (step 2).`, 'signature');
  }
  const prepared = await prepare(source, appId, version, activePublic, signature);

  // The binary first: a manifest that survived a failed upload would point at nothing. A
  // binary already at that key (a version replaced on purpose, or a leftover) is kept in STATE
  // first: nothing that was published is ever lost.
  const bKey = binaryKey(appId, version);
  const keptAs = await keepOldBinary(env, bKey);
  await putBinary(env.DEPLOY_BUCKET, bKey, prepared.header, prepared.payload);

  const releaseDate = new Date().toISOString().slice(0, 10);
  const url = binaryUrl(distribution, appId, version, prepared.payloadSha256);
  const previousLatest = typeof doc.latest === 'string' && doc.latest ? doc.latest : null;
  binaries[version] = { url, release_date: releaseDate, description };
  doc.application_id = appId;
  doc.latest = version;
  doc.binaries = binaries;

  const written = await writeManifest(env.DEPLOY_BUCKET, appId, doc, manifest?.etag ?? null);
  if (!written) {
    throw new HttpError(409, `Someone else changed the manifest of ${appId} a moment ago. The binary was uploaded but the manifest does not list it; reload and publish again.`);
  }

  const result: PublishResult = {
    binaryKey: bKey,
    binaryUrl: url,
    manifestKey: manifestKey(appId),
    version,
    releaseDate,
    previousLatest,
    replaced: exists,
    latestMovedBack: Boolean(previousLatest) && compareVersions(previousLatest!, version) > 0,
    signed: prepared.signed,
  };
  try {
    await audit(env, {
      action: 'publish', app_id: appId, version, actor: user.email, signed: prepared.signed, replaced: exists,
      sha256: toHex(prepared.payloadSha256), size: prepared.header.length + prepared.payload.length, description,
      url, previous_latest: previousLatest, public_key: prepared.publicKey,
      // The way back: the manifest as it stood, and where a replaced binary went.
      previous_manifest: manifest?.doc ?? null, ...(keptAs ? { previous_binary: keptAs } : {}),
    });
  } catch (err) {
    console.error(`audit of publish ${appId} ${version} failed`, err);
  }
  return result;
}

/** Copy the object at `key` (if any) to STATE replaced/<key minus .bin>/<timestamp>.bin; returns where. */
async function keepOldBinary(env: Env, key: string): Promise<string | null> {
  const old = await env.DEPLOY_BUCKET.get(key);
  if (!old) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = `replaced/${key.replace(/\.bin$/, '')}/${stamp}.bin`;
  await env.STATE.put(copy, await old.arrayBuffer(), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { from: key, etag: old.etag, uploaded: old.uploaded.toISOString() },
  });
  return copy;
}
