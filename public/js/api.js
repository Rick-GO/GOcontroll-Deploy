// @ts-check
// Talking to the Worker: JSON calls, and multipart uploads (Publish, Sign) with upload
// progress. An error always becomes an ApiError whose message can be shown as it is:
// the Worker's own { error } text, or what went wrong on the way.
//
// The shapes below are the API of src/ (see the README); the Worker is the authority.

/**
 * @typedef {{ email: string, name: string, groups: string[] }} Me
 * @typedef {{ id: number, name: string, source: 'manual' | 'controllers' | 'project' }} FolderCustomer
 * @typedef {{ total: number, online: number, upToDate: number }} ControllerCounts
 * @typedef {'manual' | 'manifest' | 'controllers'} ControllerSource
 * @typedef {{ appId: string, kind: 's1' | 'linux' | 'unknown', latest: string | null, releases: number, bytes: number,
 *   lastUpload: string | null, distributionUrl: string | null, hasKey: boolean, customer: FolderCustomer | null,
 *   controller?: string | null, controllerSource?: ControllerSource | null, controllers: ControllerCounts }} FolderSummary
 *   controller: S1, M1, L4, HMI1 (by hand) or a derived controller type such as M2
 * @typedef {{ configured: boolean, last7: number | null, last30: number | null, error?: string }} DownloadTotals
 * @typedef {{ folders: FolderSummary[], customers: { id: number, name: string, folders: string[] }[],
 *   totals: { folders: number, s1Folders: number, linuxFolders: number, releases: number, bytes: number, controllers: number },
 *   downloads: DownloadTotals, distributionUrls?: string[] }} Overview
 *   distributionUrls: the Worker's DISTRIBUTION_URLS, the first the default for a new application
 * @typedef {{ publicKey: string, source: 'generated' | 'imported', createdAt: string, createdBy: string }} KeyInfo
 * @typedef {{ privateKeyB64: string, privateKeyPem: string }} KeyBackup
 * @typedef {{ headerVersion: number, signed: boolean, appId: string, version: string | number[], compressedSize: number,
 *   uncompressedSize: number, sha256: string, publicKey: string | null }} ReleaseHeader
 * @typedef {{ version: string, url: string, releaseDate: string | null, description: string | null, objectKey: string,
 *   size: number | null, uploaded: string | null, header: ReleaseHeader | null, headerError: string | null,
 *   keyMatches: boolean | null, digestMatches: boolean | null, downloads: number | null }} Release
 * @typedef {{ version: string, released: string | null, description: string | null, sizeBytes: number | null, sha256: string | null }} LinuxVersion
 * @typedef {{ day: string, downloads: number | null, headerReads: number | null, manifestReads: number | null, unavailable?: boolean }} DownloadDay
 * @typedef {{ configured: boolean, days: DownloadDay[], error?: string }} Downloads
 * @typedef {{ appId: string, kind: 's1' | 'linux' | 'unknown', latest: string | null, distributionUrl: string | null,
 *   mixedHosts: boolean, key: KeyInfo | null, customer: FolderCustomer | null,
 *   controller?: string | null, controllerSource?: ControllerSource | null,
 *   controllers: ControllerCounts & { versions: { version: string | null, count: number }[] },
 *   releases: Release[], linuxVersions: LinuxVersion[], otherObjects: { key: string, size: number, uploaded: string | null }[],
 *   downloads: Downloads, manifestError?: string, distributionUrls?: string[],
 *   package?: import('./package.js').PackageDefinition | null, packageSource?: 'manual' | null,
 *   latestVersionManifest?: any, latestVersionManifestError?: string | null }} FolderDetail
 *   distributionUrl: the host of the manifest's binary URLs, or the one chosen at New application
 *   package: a Linux application's package definition; latestVersionManifest: the parsed v<latest>/manifest.json
 * @typedef {{ tarballKey: string, manifestKey: string, rootManifestKey: string, version: string, released: string,
 *   sha256: string, sizeBytes: number, previousLatest: string | null, latestVersion: string, replaced: boolean }} LinuxPublishResult
 * @typedef {{ customer: FolderCustomer | null, controller: string | null, controllerSource: ControllerSource | null }} FolderSettings
 * @typedef {{ appId: string, publicKey: string, source: 'generated' | 'imported', createdAt: string, createdBy: string, inBucket: boolean,
 *   customer: FolderCustomer | null, controller: string | null }} KeyListEntry
 * @typedef {{ keys: KeyListEntry[], withoutKey: { appId: string, customer: FolderCustomer | null, controller: string | null }[] }} KeyList
 * @typedef {{ done: boolean, deleted: number, remaining: number, archive: string }} DeleteStep
 * @typedef {{ binaryKey: string, binaryUrl: string, manifestKey: string, version: string, releaseDate: string,
 *   previousLatest: string | null, replaced: boolean, latestMovedBack: boolean, signed: boolean }} PublishResult
 */

export class ApiError extends Error {
  /** @param {string} message @param {number} status @param {string} [field] @param {any} [body] */
  constructor(message, status, field, body) {
    super(message);
    this.status = status;
    this.field = field;
    this.body = body;
  }
}

/** The message of an error, for a toast or a form. @param {unknown} err */
export const errorText = (err) => (err instanceof Error ? err.message : String(err));

// Access answers an expired session with a redirect to its login page on another origin,
// which a fetch cannot follow: that ends as a network error too.
const NO_CONNECTION = 'No connection, or your session has expired. Check your network, or reload the page to sign in again.';
const SESSION_EXPIRED = 'Your session has expired. Reload the page to sign in again.';

/** An ApiError from a failed response's JSON body. @param {number} status @param {any} data */
const failure = (status, data) => new ApiError(
  (data && typeof data.error === 'string' && data.error) || `Something went wrong (HTTP ${status}).`, status, data?.field, data,
);

/** "/folders/GOCO%2FX" for an App ID. @param {string} appId */
export const folderPath = (appId) => `/folders/${encodeURIComponent(appId)}`;

/**
 * JSON API call.
 * @param {string} method @param {string} path  under /api @param {unknown} [body]
 * @returns {Promise<any>}
 */
export async function api(method, path, body) {
  /** @type {RequestInit} */
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    /** @type {Record<string, string>} */ (init.headers)['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(NO_CONNECTION, 0);
  }
  if (res.redirected || (res.headers.get('content-type') || '').includes('text/html')) throw new ApiError(SESSION_EXPIRED, 401);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(res.status, data);
  return data;
}

/**
 * GET a file (the tarball of a Linux release, for the post-install import).
 * @param {string} path  under /api
 * @returns {Promise<Uint8Array>}
 */
export async function getBinary(path) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { accept: 'application/octet-stream, application/json' }, credentials: 'same-origin' });
  } catch {
    throw new ApiError(NO_CONNECTION, 0);
  }
  const type = res.headers.get('content-type') || '';
  if (res.redirected || type.includes('text/html')) throw new ApiError(SESSION_EXPIRED, 401);
  if (!res.ok) throw failure(res.status, await res.json().catch(() => ({})));
  return new Uint8Array(await res.arrayBuffer());
}

/** The filename in a Content-Disposition header, or null. @param {string | null} header */
function dispositionName(header) {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through to filename= */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * POST a multipart form (FormData: files and fields). An XMLHttpRequest and not a fetch,
 * for its upload progress. `binary` takes the answer as a file (Sign: the signed
 * container); otherwise it is JSON.
 * @param {string} path  under /api
 * @param {FormData} form
 * @param {{ onProgress?: (fraction: number) => void, binary?: boolean }} [opts]
 * @returns {Promise<any>}  JSON, or with binary { blob: Blob, filename: string | null }
 */
export function postForm(path, form, opts = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.responseType = opts.binary ? 'blob' : 'text';
    xhr.setRequestHeader('accept', opts.binary ? 'application/octet-stream, application/json' : 'application/json');
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); });
    xhr.upload.addEventListener('load', () => opts.onProgress?.(1));
    xhr.addEventListener('error', () => reject(new ApiError(NO_CONNECTION, 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('The upload was stopped.', 0)));
    xhr.addEventListener('load', async () => {
      try {
        const type = xhr.getResponseHeader('content-type') || '';
        const landed = xhr.responseURL ? new URL(xhr.responseURL).pathname : `/api${path}`;
        if (type.includes('text/html') || landed !== `/api${path}`) throw new ApiError(SESSION_EXPIRED, 401);
        const ok = xhr.status >= 200 && xhr.status < 300;
        if (ok && opts.binary && !type.includes('application/json')) {
          resolve({ blob: /** @type {Blob} */ (xhr.response), filename: dispositionName(xhr.getResponseHeader('content-disposition')) });
          return;
        }
        const text = opts.binary ? await /** @type {Blob} */ (xhr.response).text() : /** @type {string} */ (xhr.response);
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON: the status says enough */ }
        if (!ok) throw failure(xhr.status, data);
        if (opts.binary) throw new ApiError('The Worker sent no file back.', xhr.status);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
    xhr.send(form);
  });
}
