// GET and HEAD of /files/<path>: one file of a published release, streamed from R2.
//
// Only a path that manifest.json names is served (findPublishedFile of ../../src/images-format.ts):
// a draft whose files are in the bucket already, the download log, manifest.json itself and
// anything else are 404. The path is never percent-decoded: every published path is plain ASCII
// (PRODUCT_RE, VERSION_RE, FILE_NAME_RE), so an escape is never needed, and %2F, %2e%2e and the
// like are simply not in the catalogue.
//
// Conditional requests (304/412) and byte ranges (206/416) as the public firmware Worker does them
// (moduline-firmware/worker/src/index.js): R2 evaluates the request's conditional headers. The
// Range header is parsed here (parseRange) and handed to R2 as an explicit range: R2 refuses an
// unsatisfiable explicit range (10039, answered with 416), while one passed as headers can be
// ignored silently (Miniflare sends the whole object). One range only; a malformed or multi-range
// header is ignored and the whole file sent (RFC 9110 §14.2). If-Range is honoured, so a resumed
// download of a file that changed in the meantime starts over instead of mixing two files. Every
// answer is an attachment with the file's name and is never cached (it is behind a sign-in).
//
// Each download is logged once (DownloadMeta in downloads/…): a GET that starts the file (the
// whole file, or a range from byte 0) and gets the bytes. Never a HEAD, a 304, or a range further
// into the file, so a resumed or chunked download counts once.

import { downloadLogKey, findPublishedFile, type Catalogue, type CatalogueFile, type CatalogueRelease, type DownloadMeta } from '../../src/images-format';
import type { Env } from './env';
import { secure } from './headers';
import { notFound, plainPage } from './respond';

export const FILES_PREFIX = '/files/';

/** The object key a /files/ URL asks for; null for anything that cannot be a published path. */
export function requestedPath(pathname: string): string | null {
  if (!pathname.startsWith(FILES_PREFIX)) return null;
  const path = pathname.slice(FILES_PREFIX.length);
  if (!path || path.includes('%') || !/^(images|tools)\//.test(path)) return null;
  return path;
}

/** One byte range of a Range header: from `start` (to `end`, inclusive), or the last `suffix` bytes. */
export type ByteRange = { start: number; end?: number } | { suffix: number };

/**
 * The single byte range a Range header asks for. Null when there is none to honour: no header, a
 * malformed one, another unit or several ranges (the whole file is sent then, RFC 9110 §14.2).
 */
export function parseRange(header: string | null): ByteRange | null {
  if (header === null) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const start = Number(m[1]);
  if (m[2] === '') return { start };
  const end = Number(m[2]);
  return end < start ? null : { start, end };
}

/** The range as R2 takes it. */
function r2Range(range: ByteRange): R2Range {
  if ('suffix' in range) return { suffix: range.suffix };
  return range.end === undefined ? { offset: range.start } : { offset: range.start, length: range.end - range.start + 1 };
}

/** True when a GET with this range starts the file: the whole file, or a range from byte 0. */
export const startsDownload = (range: ByteRange | null): boolean => range === null || ('start' in range && range.start === 0);

/** First and last byte of an R2 range in an object of `size` bytes. */
export function rangeBounds(range: R2Range, size: number): { start: number; end: number } {
  let start: number;
  let end: number;
  if ('suffix' in range && range.suffix !== undefined) {
    start = Math.max(size - range.suffix, 0);
    end = size - 1;
  } else {
    const r = range as { offset?: number; length?: number };
    start = r.offset ?? 0;
    end = r.length !== undefined ? start + r.length - 1 : size - 1;
  }
  return { start, end: Math.min(end, size - 1) };
}

function fileHeaders(object: R2Object, file: CatalogueFile): Headers {
  return secure(new Headers({
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${file.name}"`, // FILE_NAME_RE: no quotes, no path
    etag: object.httpEtag,
    'last-modified': object.uploaded.toUTCString(),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  }));
}

/** A published file that the catalogue names but the bucket does not hold: say so in the log. */
function missing(file: CatalogueFile): Response {
  console.warn(`files: ${file.path} is in manifest.json but not in the bucket`);
  return notFound(false);
}

export async function serveFile(request: Request, env: Env, ctx: ExecutionContext, email: string, catalogue: Catalogue, path: string): Promise<Response> {
  const hit = findPublishedFile(catalogue, path);
  if (!hit) return notFound(false);
  const { release, file } = hit;
  const bucket = env.IMAGES_BUCKET;

  if (request.method === 'HEAD') {
    const head = await bucket.head(file.path);
    if (!head) return missing(file);
    const headers = fileHeaders(head, file);
    headers.set('content-length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  let range = parseRange(request.headers.get('range'));
  const ifRange = request.headers.get('if-range');
  if (range && ifRange !== null) {
    // Resuming: only when the file is still the one the client has part of (strong ETag or date).
    const head = await bucket.head(file.path);
    if (!head) return missing(file);
    if (ifRange !== head.httpEtag && ifRange !== head.uploaded.toUTCString()) range = null;
  }

  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(file.path, { onlyIf: request.headers, ...(range ? { range: r2Range(range) } : {}) });
  } catch (err) {
    if (!range || !/10039|not satisfiable/i.test((err as Error).message)) throw err;
    const head = await bucket.head(file.path);
    if (!head) return missing(file);
    return plainPage(416, 'Range not satisfiable', 'The requested part of the file does not exist.', { 'content-range': `bytes */${head.size}` });
  }
  if (object === null) return missing(file);

  const headers = fileHeaders(object, file);
  if (!('body' in object) || !object.body) {
    // A precondition failed: If-None-Match / If-Modified-Since → 304, If-Match / If-Unmodified-Since → 412.
    const status = request.headers.has('if-match') || request.headers.has('if-unmodified-since') ? 412 : 304;
    return new Response(null, { status, headers });
  }

  if (startsDownload(range)) ctx.waitUntil(logDownload(env, request, email, release, file));

  if (range && object.range) {
    const { start, end } = rangeBounds(object.range, object.size);
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/** One empty object per download; who and what in its custom metadata (DownloadMeta). */
async function logDownload(env: Env, request: Request, email: string, release: CatalogueRelease, file: CatalogueFile): Promise<void> {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  const country = (request.cf as IncomingRequestCfProperties | undefined)?.country;
  const meta: DownloadMeta = {
    email,
    path: file.path,
    kind: release.kind,
    product: release.product,
    version: release.version,
    country: typeof country === 'string' ? country : '',
  };
  try {
    await env.IMAGES_BUCKET.put(downloadLogKey(new Date(), random), '', { customMetadata: { ...meta } });
  } catch (err) {
    // The download itself goes on; a missing log line is only a missing count.
    console.error(`download log: ${(err as Error).message}`);
  }
}
