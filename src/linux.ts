// Linux applications (Moduline M1, L4, HMI1): go-deploy releases in the same bucket.
//
// The contract is GOcontroll-Architecture/cloudflare/linux-application/spec.md (bucket layout
// §1, root manifest §2, version manifest §3, tarball + go-deploy install §4); the producer this
// mirrors is the CI pipeline of the skill r2-application-deploy-setup (build-package.py,
// upload-r2.py). Layout, as upload-r2.py writes it:
//
//   <APP_ID>/v<version>/update.tar.gz   application/gzip: tar.gz of files/<name> (+ files/post-install.sh)
//   <APP_ID>/v<version>/manifest.json   the version manifest (build-package.py), stored as sent
//   <APP_ID>/manifest.json              root manifest { app_id, latest_version, versions[] }:
//                                       versions newest first by upload-r2.py's semver_key,
//                                       latest_version = versions[0] (the highest, not the newest),
//                                       json.dumps(indent=2) + "\n" (ASCII, \uXXXX escapes)
//
// The browser builds the tarball and the version manifest from the folder's package
// definition (or sends a CI-built dist/ as it is); the Worker checks the version manifest,
// computes the tarball's SHA-256 and size (streamed), and does not unpack it: the per-file
// SHA-256 values are the browser's or CI's, and go-deploy checks them when it installs. No
// signature: the go-deploy contract has none (integrity is the SHA-256 in the root manifest).

import { z } from 'zod';
import type { Env, User } from './env';
import { manifestKind, readManifest } from './bucket';
import { deleteUnderWay } from './delete';
import { nextRootManifest, pythonJson, type RootEntry } from './godeploy';
import { toHex } from './goco';
import { HttpError } from './lib/http';
import { audit, loadFolderSettings, type FolderSettings } from './state';

export const LINUX_CONTROLLERS = ['M1', 'L4', 'HMI1'] as const;
export const isLinuxController = (c: unknown): boolean => (LINUX_CONTROLLERS as readonly unknown[]).includes(c);

/** A new Linux App ID: config.schema.json's pattern, at most 64 characters. */
export const LINUX_APP_ID = /^[a-z0-9][a-z0-9._-]*$/;
export const LINUX_APP_ID_MAX = 64;
/** A version as upload-r2.py allows it: three numbers, optionally a pre-release suffix ("1.0.1-r"). */
export const LINUX_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const MAX_TARBALL = 100 * 1024 * 1024;
const MAX_VERSION_MANIFEST = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const MODE = /^[0-7]{3,4}$/;

const fail = (status: number, message: string, field?: string) => new HttpError(status, message, field);

// ── Package definition ───────────────────────────────────────────────────────

const account = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}\$?$/, 'A user or group is a Linux account name, e.g. root.');
const fileName = z.string()
  .refine((s) => /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(s) && !/[/\\]/.test(s), 'A file name is a plain name without / (printable ASCII).')
  .refine((s) => s !== '.' && s !== '..', 'A file name cannot be . or ..')
  .refine((s) => s !== 'post-install.sh', 'post-install.sh is the post-install script: choose another name.')
  .refine((s) => s.length <= 94, 'A file name is at most 94 characters (it goes into the tarball as files/<name>).');
const destination = z.string()
  .refine((s) => /^\/[^\0]*$/.test(s) && !/[\r\n\t]/.test(s), 'A destination is an absolute path on the controller (starting with /).')
  .refine((s) => !s.endsWith('/') && !s.split('/').includes('..'), 'A destination names a file, without .. or a trailing /.')
  .refine((s) => s.length <= 1024, 'A destination is at most 1024 characters.');
const service = z.string().regex(/^[A-Za-z0-9@._:-]{1,128}$/, 'A service is a systemd unit name such as nodered.');

export const PackageSchema = z.object({
  owner: account.optional(),
  group: account.optional(),
  files: z.array(z.object({
    name: fileName,
    destination,
    mode: z.string().regex(MODE, 'A mode is octal, such as 0644 or 0755.'),
    owner: account.optional(),
    group: account.optional(),
  }), { message: 'List the files of the package.' }).min(1, 'A package holds at least one file.').max(100, 'A package holds at most 100 files.'),
  post_install: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }),
    z.object({ mode: z.literal('services'), services: z.array(service).min(1, 'Name at least one service.').max(32) }),
    z.object({ mode: z.literal('script'), script: z.string().refine((s) => s.trim().length > 0, 'The script is empty.').refine((s) => s.length <= 65536, 'The script is at most 64 KB.') }),
  ], { message: 'Choose no post-install, restarting services, or a script.' }).optional(),
});

export type PackageDefinition = {
  owner: string;
  group: string;
  files: { name: string; destination: string; mode: string; owner?: string; group?: string }[];
  post_install: { mode: 'none' } | { mode: 'services'; services: string[] } | { mode: 'script'; script: string };
};

/** The definition with its defaults (root:root, no post-install); 400 on what zod refuses, names and destinations unique. */
export function normalisePackage(input: z.infer<typeof PackageSchema>): PackageDefinition {
  const names = new Set<string>();
  const destinations = new Set<string>();
  input.files.forEach((f, i) => {
    if (names.has(f.name)) throw fail(400, `${f.name} is in the package twice.`, `files.${i}.name`);
    if (destinations.has(f.destination)) throw fail(400, `Two files go to ${f.destination}.`, `files.${i}.destination`);
    names.add(f.name);
    destinations.add(f.destination);
  });
  const post = input.post_install ?? { mode: 'none' as const };
  if (post.mode === 'services' && new Set(post.services).size !== post.services.length) throw fail(400, 'A service is listed twice.', 'post_install.services');
  return {
    owner: input.owner ?? 'root',
    group: input.group ?? 'root',
    files: input.files.map((f) => ({ name: f.name, destination: f.destination, mode: f.mode, ...(f.owner ? { owner: f.owner } : {}), ...(f.group ? { group: f.group } : {}) })),
    post_install: post,
  };
}

// ── The folder ───────────────────────────────────────────────────────────────

/** Why a folder cannot take Linux releases, or null when it can. */
export function linuxRefusal(appId: string, rootKind: string, hasRoot: boolean, settings: FolderSettings | null): string | null {
  if (rootKind === 's1' || settings?.controller === 'S1') return `The folder ${appId} holds S1 firmware; Linux releases cannot go into it.`;
  if (hasRoot && rootKind !== 'linux') return `The manifest of ${appId} is not a go-deploy root manifest (no versions list); Deploy does not write into it.`;
  if (!hasRoot && !isLinuxController(settings?.controller)) {
    return `${appId} is not a Linux application yet: make it a new application with controller M1, L4 or HMI1 first.`;
  }
  return null;
}

/** The root manifest's entry for a version, or null. */
export function rootEntry(doc: Record<string, unknown> | null | undefined, version: string): Record<string, unknown> | null {
  const versions = Array.isArray(doc?.versions) ? (doc!.versions as unknown[]) : [];
  return (versions.find((v) => v && typeof v === 'object' && (v as Record<string, unknown>).version === version) as Record<string, unknown>) ?? null;
}

/** A path from the root manifest (relative to the folder) as an object key inside the folder, or null. */
export function folderKey(appId: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  return `${appId}/${rel}`;
}

// ── Version manifest ─────────────────────────────────────────────────────────

export interface VersionManifest { released: string; files: number; postInstall: boolean }

/**
 * Check a version manifest (build-package.py's shape) against the release: app_id, version,
 * released, description, files[] (source files/<name>, absolute destination, octal mode,
 * sha256) and post_install. 422 with field "manifest".
 */
export function checkVersionManifest(text: string, appId: string, version: string, description: string): VersionManifest {
  const bad = (message: string) => fail(422, message, 'manifest');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw bad('The version manifest is not valid JSON.');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('The version manifest is not a JSON object.');
  const m = doc as Record<string, unknown>;
  if (m.manifest_version !== undefined && m.manifest_version !== 1) throw bad(`The version manifest has manifest_version ${JSON.stringify(m.manifest_version)}; go-deploy reads version 1.`);
  if (m.app_id !== appId) throw bad(`The version manifest is for ${JSON.stringify(m.app_id ?? null)}, not ${appId}.`);
  if (m.version !== version) throw bad(`The version manifest is for version ${JSON.stringify(m.version ?? null)}, not ${version}.`);
  if (typeof m.released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.released)) throw bad('The version manifest has no release date (released: YYYY-MM-DD).');
  if (typeof m.description !== 'string' || m.description.trim() !== description) {
    throw bad('The description in the version manifest differs from the one given for the release.');
  }
  if (!Array.isArray(m.files)) throw bad('The version manifest has no files list.');
  const sources = new Set<string>();
  m.files.forEach((f, i) => {
    const at = `files[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(`${at} of the version manifest is not an object.`);
    const e = f as Record<string, unknown>;
    if (typeof e.source !== 'string' || !/^files\/[^/]+$/.test(e.source) || e.source === 'files/post-install.sh') throw bad(`${at}.source must be files/<name>.`);
    if (sources.has(e.source)) throw bad(`${e.source} is in the version manifest twice.`);
    sources.add(e.source);
    if (typeof e.destination !== 'string' || !e.destination.startsWith('/')) throw bad(`${at}.destination must be an absolute path.`);
    if (typeof e.mode !== 'string' || !MODE.test(e.mode)) throw bad(`${at}.mode must be an octal string such as 0644.`);
    if (typeof e.sha256 !== 'string' || !HEX64.test(e.sha256)) throw bad(`${at}.sha256 must be 64 lower-case hex characters.`);
    for (const k of ['owner', 'group']) if (e[k] !== undefined && typeof e[k] !== 'string') throw bad(`${at}.${k} must be a string.`);
  });
  const post = m.post_install;
  if (post !== undefined && post !== null) {
    if (typeof post !== 'object' || Array.isArray(post)) throw bad('post_install of the version manifest is not an object.');
    const p = post as Record<string, unknown>;
    if (p.source !== 'files/post-install.sh') throw bad('post_install.source must be files/post-install.sh.');
    if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) throw bad('post_install.sha256 must be 64 lower-case hex characters.');
    if (p.interpreter !== undefined && typeof p.interpreter !== 'string') throw bad('post_install.interpreter must be a string.');
  }
  if (!m.files.length && (post === undefined || post === null)) throw bad('The version manifest lists no files and no post-install script.');
  return { released: m.released, files: m.files.length, postInstall: post !== undefined && post !== null };
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface LinuxPublishResult {
  tarballKey: string;
  manifestKey: string;
  rootManifestKey: string;
  version: string;
  released: string;
  sha256: string;
  sizeBytes: number;
  previousLatest: string | null;
  latestVersion: string;
  replaced: boolean;
}

const isFile = (v: unknown): v is File => typeof v === 'object' && v !== null && typeof (v as File).arrayBuffer === 'function';

/** SHA-256 of a file without holding a second copy of it (a stream into DigestStream). */
async function streamedSha256(file: Blob): Promise<string> {
  const digest = new crypto.DigestStream('SHA-256');
  await file.stream().pipeTo(digest);
  return toHex(new Uint8Array(await digest.digest));
}

export async function publishLinux(env: Env, user: User, form: FormData): Promise<LinuxPublishResult> {
  const rawId = form.get('appId');
  const appId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!appId || !/^[\x21-\x2e\x30-\x7e]{1,200}$/.test(appId)) throw fail(400, 'Fill in the App ID.', 'appId');
  const rawVersion = form.get('version');
  const version = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  if (!LINUX_VERSION.test(version) || version.length > 64) throw fail(400, 'A version is major.minor.patch, optionally with a suffix such as 1.0.1-r.', 'version');
  const rawDescription = form.get('description');
  const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
  if (!description) throw fail(400, 'Describe what changed: the root manifest needs a description for every release.', 'description');
  if (description.length > 2000) throw fail(400, 'The description is at most 2000 characters.', 'description');
  const replace = form.get('replace') === '1';

  const tarball = form.get('tarball');
  if (!isFile(tarball) || tarball.size === 0) throw fail(400, 'Add the package (update.tar.gz).', 'tarball');
  if (tarball.size > MAX_TARBALL) throw fail(413, 'A package is at most 100 MB.', 'tarball');
  const rawManifest = form.get('manifest');
  if (isFile(rawManifest) && rawManifest.size > MAX_VERSION_MANIFEST) throw fail(413, 'The version manifest is at most 1 MB.', 'manifest');
  const manifestText = isFile(rawManifest) ? await rawManifest.text() : typeof rawManifest === 'string' ? rawManifest : '';
  if (!manifestText.trim()) throw fail(400, 'Add the version manifest (manifest.json).', 'manifest');
  if (manifestText.length > MAX_VERSION_MANIFEST) throw fail(413, 'The version manifest is at most 1 MB.', 'manifest');

  const [root, settings, deleting] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId), loadFolderSettings(env, appId), deleteUnderWay(env, appId),
  ]);
  if (deleting) throw new HttpError(409, `The folder ${appId} is being deleted. Finish or wait for that first.`);
  if (root?.error) throw fail(422, `The folder ${appId} holds a manifest.json that cannot be read (${root.error}); fix it before publishing.`);
  const refusal = linuxRefusal(appId, manifestKind(root?.doc), Boolean(root), settings);
  if (refusal) throw fail(422, refusal);
  const versions = Array.isArray(root?.doc?.versions) ? (root!.doc!.versions as unknown[]) : [];
  if (versions.some((v) => !v || typeof v !== 'object' || typeof (v as Record<string, unknown>).version !== 'string')) {
    throw fail(422, `The root manifest of ${appId} has a versions entry without a version; fix it before publishing.`);
  }
  const standing = rootEntry(root?.doc, version);
  if (standing && !replace) {
    throw new HttpError(409, `Version ${version} is already published (${standing.released || 'date unknown'}: ${standing.description || 'no description'}). Raise the version number, or replace it on purpose.`, 'version');
  }

  const checked = checkVersionManifest(manifestText, appId, version, description);
  const head = new Uint8Array(await tarball.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) throw fail(422, 'The package is not a gzip file (update.tar.gz).', 'tarball');
  const sha256 = await streamedSha256(tarball);

  // Anything already at this version's keys (a replaced version, or a leftover) is archived first.
  const tarballKey = `${appId}/v${version}/update.tar.gz`;
  const manifestKey = `${appId}/v${version}/manifest.json`;
  const rootManifestKey = `${appId}/manifest.json`;
  const stamp = new Date().toISOString();
  const kept: string[] = [];
  for (const [key, name] of [[tarballKey, 'update.tar.gz'], [manifestKey, 'manifest.json']] as const) {
    const old = await env.DEPLOY_BUCKET.get(key);
    if (!old) continue;
    const copyKey = `replaced/${appId}/v${version}/${stamp}/${name}`;
    const copy = await env.STATE.put(copyKey, old.body, {
      httpMetadata: old.httpMetadata,
      customMetadata: { ...old.customMetadata, 'archived-etag': old.etag, 'archived-uploaded': old.uploaded.toISOString() },
    });
    if (!copy || copy.size !== old.size) throw new HttpError(500, `Archiving the old ${key} failed, so nothing was written. Try again.`);
    kept.push(copyKey);
  }

  // Tarball, version manifest, then the root manifest: a root manifest never names what is not there.
  const put = await env.DEPLOY_BUCKET.put(tarballKey, tarball, { httpMetadata: { contentType: 'application/gzip' }, sha256 });
  if (put.size !== tarball.size) throw new HttpError(500, 'The package was not stored whole. Try again.');
  await env.DEPLOY_BUCKET.put(manifestKey, manifestText, { httpMetadata: { contentType: 'application/json' } });

  const entry: RootEntry = {
    version, released: checked.released, description,
    tarball: `v${version}/update.tar.gz`, manifest: `v${version}/manifest.json`, size_bytes: tarball.size, sha256,
  };
  const previousLatest = typeof root?.doc?.latest_version === 'string' && root.doc.latest_version ? root.doc.latest_version : null;
  const next = nextRootManifest(root?.doc ?? null, appId, entry);
  const written = await env.DEPLOY_BUCKET.put(rootManifestKey, pythonJson(next), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: root ? { etagMatches: root.etag } : new Headers({ 'if-none-match': '*' }),
  });
  if (!written) {
    throw new HttpError(409, `Someone else changed the root manifest of ${appId} a moment ago. The package was uploaded but the root manifest does not list it; reload and publish again.`);
  }

  const latestVersion = String(next.latest_version);
  try {
    await audit(env, {
      action: 'publish-linux', app_id: appId, version, actor: user.email, sha256, size: tarball.size, description,
      replaced: Boolean(standing), latest_version: latestVersion, previous_latest: previousLatest,
      files: checked.files, post_install: checked.postInstall,
      previous_manifest: root?.doc ?? null, ...(kept.length ? { previous_objects: kept } : {}),
    });
  } catch (err) {
    console.error(`audit of publish-linux ${appId} ${version} failed`, err);
  }
  return {
    tarballKey, manifestKey, rootManifestKey, version, released: checked.released, sha256, sizeBytes: tarball.size,
    previousLatest, latestVersion, replaced: Boolean(standing),
  };
}
