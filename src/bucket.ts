// The distribution bucket DEPLOY_BUCKET (gocontroll-deploy): reading folders and manifests,
// and the writes of a release. Layout and manifest are normative in the S1 knowledge base,
// cloud-r2-distribution.md §2 (layout), §2.1 (two hosts), §3 (manifest, `?v=` digest); the
// steps of a publish follow GOcontroll-Deployment-Tool/tools/r2.py publish().
//
//   <APP_ID>/manifest.json            { application_id, latest, binaries: { <version>: { url, release_date, description } } }
//   <APP_ID>/<APP_ID>-<version>.bin   the GOCO container
//
// A folder can hold a manifest for Linux controllers instead (go-deploy tarballs:
// app_id / latest_version / versions[]); Deploy shows it and never writes into it.

import { GocoError, MAX_HEADER_SIZE, readHeader, toHex, type GocoHeader } from './goco';
import { listAll } from './state';

export const URL_DIGEST_PARAM = 'v';
export const URL_DIGEST_LEN = 16;

export type FolderKind = 's1' | 'linux' | 'unknown';

export const manifestKey = (appId: string) => `${appId}/manifest.json`;
export const binaryKey = (appId: string, version: string) => `${appId}/${appId}-${version}.bin`;

/** "https://a,https://b" → normalised bases without a trailing slash. */
export function distributionUrls(value: string | undefined): string[] {
  return (value || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** Sort key that puts 0.0.10 after 0.0.9; shapes that are not three numbers sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = /^\d+\.\d+\.\d+$/.test(a) ? a.split('.').map(Number) : null;
  const pb = /^\d+\.\d+\.\d+$/.test(b) ? b.split('.').map(Number) : null;
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }
  if (pa) return 1;
  if (pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface ManifestRead {
  doc: Record<string, unknown> | null; // null when the object is not a JSON object
  etag: string;
  uploaded: string;
  error: string | null;
}

/** The manifest as it stands, or null when the folder has none. */
export async function readManifest(bucket: R2Bucket, appId: string): Promise<ManifestRead | null> {
  const obj = await bucket.get(manifestKey(appId));
  if (!obj) return null;
  const meta = { etag: obj.etag, uploaded: obj.uploaded.toISOString() };
  try {
    const doc = JSON.parse(await obj.text());
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, ...meta, error: 'manifest.json is not a JSON object' };
    return { doc, ...meta, error: null };
  } catch {
    return { doc: null, ...meta, error: 'manifest.json is not valid JSON' };
  }
}

export function manifestKind(doc: Record<string, unknown> | null | undefined): FolderKind {
  if (!doc) return 'unknown';
  if (doc.binaries && typeof doc.binaries === 'object' && !Array.isArray(doc.binaries)) return 's1';
  if (Array.isArray(doc.versions)) return 'linux';
  return 'unknown';
}

export interface S1Entry { version: string; url: string; releaseDate: string; description: string }

/** The S1 releases of a manifest, newest first. */
export function s1Entries(doc: Record<string, unknown> | null | undefined): S1Entry[] {
  const binaries = doc?.binaries;
  if (!binaries || typeof binaries !== 'object' || Array.isArray(binaries)) return [];
  return Object.entries(binaries as Record<string, unknown>)
    .filter((e): e is [string, Record<string, unknown>] => Boolean(e[1]) && typeof e[1] === 'object' && !Array.isArray(e[1]))
    .map(([version, e]) => ({ version, url: str(e.url), releaseDate: str(e.release_date), description: str(e.description) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

export interface LinuxVersion { version: string; released: string | null; description: string | null; sizeBytes: number | null; sha256: string | null; tarball: string | null; manifest: string | null }

/** The releases of a Linux (go-deploy) manifest, newest first. */
export function linuxEntries(doc: Record<string, unknown> | null | undefined): LinuxVersion[] {
  const versions = doc?.versions;
  if (!Array.isArray(versions)) return [];
  return versions
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .map((v) => ({
      version: str(v.version),
      released: strOrNull(v.released),
      description: strOrNull(v.description),
      sizeBytes: typeof v.size_bytes === 'number' ? v.size_bytes : null,
      sha256: strOrNull(v.sha256),
      tarball: strOrNull(v.tarball),
      manifest: strOrNull(v.manifest),
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function latestOf(doc: Record<string, unknown> | null | undefined, kind: FolderKind): string | null {
  if (!doc) return null;
  const v = kind === 'linux' ? doc.latest_version : kind === 's1' ? doc.latest : null;
  return typeof v === 'string' && v ? v : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

// ── URLs ─────────────────────────────────────────────────────────────────────

/** The origin of a URL ("https://host"), or null when it is not an http(s) URL. */
export function urlBase(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The distribution URL a folder's manifest names: the base of the latest release's URL
 * (else of the newest), and whether its entries name more than one host (§2.1 says never).
 */
export function folderDistribution(entries: S1Entry[], latest: string | null): { distributionUrl: string | null; mixedHosts: boolean } {
  const bases = new Set(entries.map((e) => urlBase(e.url)).filter((b): b is string => Boolean(b)));
  const main = entries.find((e) => e.version === latest && urlBase(e.url)) ?? entries.find((e) => urlBase(e.url));
  return { distributionUrl: main ? urlBase(main.url) : null, mixedHosts: bases.size > 1 };
}

/** The object key a manifest URL points at, when its base is one of the bucket's own; else null. */
export function objectKeyForUrl(url: string, bases: string[]): string | null {
  const base = urlBase(url);
  if (!base || !bases.includes(base)) return null;
  try {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return key || null;
  } catch {
    return null;
  }
}

/** The `?v=` of a manifest URL, lower case, or null. */
export function urlDigest(url: string): string | null {
  try {
    const v = new URL(url).searchParams.get(URL_DIGEST_PARAM);
    return v ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The URL the manifest gets for a release: `<dist>/<key>?v=<first 16 hex of the payload SHA-256>` (§3). */
export function binaryUrl(distributionUrl: string, appId: string, version: string, payloadSha256: Uint8Array): string {
  return `${distributionUrl.replace(/\/+$/, '')}/${binaryKey(appId, version)}?${URL_DIGEST_PARAM}=${toHex(payloadSha256).slice(0, URL_DIGEST_LEN)}`;
}

// ── Objects ──────────────────────────────────────────────────────────────────

/**
 * Every object in the bucket, all pages; the overview groups them by folder. One listing
 * (a page per 1000 objects) instead of a delimiter listing plus one listing per folder:
 * fewer Class A operations and subrequests.
 */
export async function listBucket(bucket: R2Bucket): Promise<R2Object[]> {
  return listAll(bucket, {});
}

/** The objects of one folder. */
export async function listFolder(bucket: R2Bucket, appId: string): Promise<R2Object[]> {
  return listAll(bucket, { prefix: `${appId}/` });
}

/**
 * The header of a stored container, from a range read of its first bytes (the binary itself
 * is not read). `size` is the object size from a listing, so the range never reaches past
 * the end of a small object.
 */
export async function readStoredHeader(bucket: R2Bucket, key: string, size: number): Promise<{ header: GocoHeader | null; error: string | null }> {
  const length = Math.min(MAX_HEADER_SIZE, size);
  if (length <= 0) return { header: null, error: 'the object is empty' };
  const obj = await bucket.get(key, { range: { offset: 0, length } });
  if (!obj) return { header: null, error: 'the object is not in the bucket' };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    return { header: readHeader(bytes), error: null };
  } catch (err) {
    if (err instanceof GocoError) return { header: null, error: err.message };
    throw err;
  }
}

/** The manifest as R2 gets it: JSON with indent 2 and a newline, like r2.py (keeps every field). */
export function manifestText(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Write the manifest only over the version that was read (its etag), or only where none is
 * yet. False when someone else wrote it meanwhile.
 */
export async function writeManifest(bucket: R2Bucket, appId: string, doc: Record<string, unknown>, etag: string | null): Promise<boolean> {
  const result = await bucket.put(manifestKey(appId), manifestText(doc), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: etag ? { etagMatches: etag } : new Headers({ 'if-none-match': '*' }),
  });
  return result !== null;
}

/** Write a container: header and payload as one body, without copying in JavaScript. */
export async function putBinary(bucket: R2Bucket, key: string, header: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>): Promise<R2Object> {
  return bucket.put(key, new Blob([header, payload]), { httpMetadata: { contentType: 'application/octet-stream' } });
}
