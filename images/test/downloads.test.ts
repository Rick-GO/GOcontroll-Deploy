// The catalogue API and the downloads: only published files, with conditional and range
// requests, and one log entry per download.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CATALOGUE_KEY, catalogueText, parseCatalogue } from '../../src/images-format';
import { parseRange, rangeBounds, requestedPath, startsDownload } from '../src/files';
import { SECURITY_HEADERS } from '../src/headers';
import {
  DRAFT, downloadLog, EMPTY, emptyBucket, HOST, OLD_ROOTFS, PACKAGE, publishSample, ROOTFS, ROOTFS_BYTES, run, sampleCatalogue, sessionCookieHeader, signedIn,
} from './helpers';

beforeEach(async () => {
  // No call leaves the Worker while signed in: no Access, no identity lookup.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => { throw new Error(`unexpected fetch ${String(input)}`); });
  await emptyBucket();
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/catalogue', () => {
  test('no manifest.json yet: the empty catalogue', async () => {
    const res = await signedIn('/api/catalogue');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ email: 'customer@example.com', catalogue: EMPTY });
  });

  test('the published catalogue, parsed and sorted as the contract says', async () => {
    await publishSample();
    const res = await signedIn('/api/catalogue');
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.email).toBe('customer@example.com');
    expect(body.catalogue).toEqual(parseCatalogue(catalogueText(sampleCatalogue())));
    expect(body.catalogue.format).toBe(3);
    expect(body.catalogue.releases.map((r: any) => `${r.controller} ${r.version}`)).toEqual([
      'L4 2026.11.0', 'L4 2026.10.0', 'HMI1 2026.11.0',
    ]);
    for (const r of body.catalogue.releases) expect(Object.keys(r).sort()).toEqual(['controller', 'files', 'notes', 'released', 'version']);
    expect(body.catalogue.releases[2].files[0]).toMatchObject({ path: PACKAGE, role: 'package' });
  });

  test('a broken entry is left out; a manifest that is not JSON is a 503, never a guess', async () => {
    const doc = sampleCatalogue() as any;
    doc.releases.push({ product: '../etc', version: '1', files: [] }, { controller: 'L5', version: '1', files: [] }, { controller: 'L4', version: '../x', files: [] });
    doc.releases[0].files.push({ name: 'x.bin', path: 'downloads/x.bin', size: 1, sha256: '', role: 'rootfs', platform: 'any' });
    await env.IMAGES_BUCKET.put(CATALOGUE_KEY, JSON.stringify(doc));
    const body = await (await signedIn('/api/catalogue')).json<any>();
    expect(body.catalogue.releases).toHaveLength(3);
    expect(body.catalogue.releases[0].files.map((f: any) => f.path)).toEqual([ROOTFS]);

    await env.IMAGES_BUCKET.put(CATALOGUE_KEY, '{ not json');
    const broken = await signedIn('/api/catalogue');
    expect(broken.status).toBe(503);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(broken.headers.get(k)).toBe(v);
  });

  test('a newer format than this reader knows: nothing at all; a tool of format 1 has no files here', async () => {
    await publishSample({ ...sampleCatalogue(), format: 4 });
    const newer = await (await signedIn('/api/catalogue')).json<any>();
    expect(newer.catalogue).toMatchObject({ format: 4, releases: [] });
    expect((await signedIn(`/files/${ROOTFS}`)).status).toBe(404);

    // Format 1 also had tool releases under tools/ (never published): such a file is never served.
    const old = { format: 1, updated: null, releases: [{ kind: 'tool', product: 'flash-tools', title: 'Flash tools', version: '1.4.2', controllers: [], released: '', notes: '',
      files: [{ name: 'flash.ps1', path: 'tools/flash-tools/1.4.2/flash.ps1', size: 3, sha256: '', role: 'tool', platform: 'windows' }] }] };
    await env.IMAGES_BUCKET.put(CATALOGUE_KEY, JSON.stringify(old));
    await env.IMAGES_BUCKET.put('tools/flash-tools/1.4.2/flash.ps1', 'ps1');
    const parsed = await (await signedIn('/api/catalogue')).json<any>();
    expect(parsed.catalogue.releases).toEqual([]);
    expect((await signedIn('/files/tools/flash-tools/1.4.2/flash.ps1')).status).toBe(404);
    expect((await signedIn('/download/tools/flash-tools/1.4.2/flash.ps1')).status).toBe(404);
  });

  test('a release of format 2 (product, title, controllers) is read as the image of its controller and served', async () => {
    const path = 'images/moduline-l4/6.12.87/moduline-l4-306-d_2026-10-29_6.12.87.zip';
    await env.IMAGES_BUCKET.put(path, 'zip');
    await env.IMAGES_BUCKET.put(CATALOGUE_KEY, JSON.stringify({ format: 2, updated: '2026-10-29T12:55:22.464Z', releases: [
      { product: 'moduline-l4', title: 'Moduline L4', version: '6.12.87', controllers: ['L4'], released: '2026-10-29', notes: '',
        files: [{ name: 'moduline-l4-306-d_2026-10-29_6.12.87.zip', path, size: 3, sha256: 'b'.repeat(64), role: 'package', platform: 'any' }] },
      { product: 'moduline-headless', title: 'Not a controller', version: '1', controllers: ['L4'], released: '', notes: '', files: [] },
    ] }));
    const body = await (await signedIn('/api/catalogue')).json<any>();
    expect(body.catalogue.format).toBe(2);
    expect(body.catalogue.releases).toEqual([{ controller: 'L4', version: '6.12.87', released: '2026-10-29', notes: '',
      files: [{ name: 'moduline-l4-306-d_2026-10-29_6.12.87.zip', path, size: 3, sha256: 'b'.repeat(64), role: 'package', platform: 'any' }] }]);
    expect(await (await signedIn(`/files/${path}`)).text()).toBe('zip');
    expect((await downloadLog()).at(-1)?.customMetadata).toMatchObject({ path, product: 'moduline-l4', version: '6.12.87' });
  });
});

describe('GET /files/<path>', () => {
  beforeEach(async () => { await publishSample(); });

  test('a published file: the bytes, as an attachment, never cached', async () => {
    const res = await signedIn(`/files/${ROOTFS}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ROOTFS_BYTES);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rootfs.ext4.zst"');
    expect(res.headers.get('content-length')).toBe('20');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get('last-modified')).toMatch(/GMT$/);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    expect((await signedIn(`/files/${OLD_ROOTFS}`)).status).toBe(200);
    expect(await (await signedIn(`/files/${PACKAGE}`)).text()).toBe('zip');
  });

  test('a draft, the log, manifest.json, unknown paths and path tricks are 404', async () => {
    await env.IMAGES_BUCKET.put('downloads/2026/10/x.json', '');
    const paths = [
      DRAFT, CATALOGUE_KEY, 'downloads/2026/10/x.json', 'images/moduline-l4/2026.11.0/', 'images/moduline-l4/2026.11.0/nope.bin',
      '', 'images', ROOTFS.toUpperCase(), `${ROOTFS}/`, `${ROOTFS}%00`,
      ROOTFS.replace(/\//g, '%2F'), ROOTFS.replace('rootfs', '%72ootfs'), `images/moduline-l4/2026.11.0/..%2F..%2F..%2F${CATALOGUE_KEY}`,
      `images/moduline-l4/2026.11.0/%2e%2e/2026.12.0/rootfs.ext4.zst`, `images/x/../../${CATALOGUE_KEY}`,
    ];
    for (const path of paths) {
      const res = await signedIn(`/files/${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-disposition'), path).toBeNull();
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), `${path} ${k}`).toBe(v);
    }
    expect((await signedIn(`/files`)).status).toBe(404);
    expect((await signedIn(`/${ROOTFS}`)).status).toBe(404);
    expect((await signedIn(`/${CATALOGUE_KEY}`)).status).toBe(404);
    expect(await downloadLog()).toHaveLength(1); // only the object put above: nothing was logged
  });

  test('a withdrawn release stops being served at once (no cache of manifest.json)', async () => {
    expect((await signedIn(`/files/${OLD_ROOTFS}`)).status).toBe(200);
    const doc = sampleCatalogue();
    doc.releases = doc.releases.filter((r) => r.version !== '2026.10.0');
    await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText(doc));
    expect((await signedIn(`/files/${OLD_ROOTFS}`)).status).toBe(404);
  });

  test('in the catalogue but not in the bucket: 404', async () => {
    await env.IMAGES_BUCKET.delete(PACKAGE);
    expect((await signedIn(`/files/${PACKAGE}`)).status).toBe(404);
    expect((await signedIn(`/files/${PACKAGE}`, { method: 'HEAD' })).status).toBe(404);
  });

  test('HEAD: the headers and the size, no body', async () => {
    const res = await signedIn(`/files/${ROOTFS}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('20');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rootfs.ext4.zst"');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(res.body).toBeNull();
    expect((await signedIn(`/files/${DRAFT}`, { method: 'HEAD' })).status).toBe(404);
  });

  test('Range: 206 with Content-Range; a range past the end is 416', async () => {
    const res = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/20');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');

    const open = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=15-' } });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 15-19/20');
    expect(await open.text()).toBe('fghij');

    const suffix = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 17-19/20');
    expect(await suffix.text()).toBe('hij');

    for (const range of ['bytes=50-60', 'bytes=20-', 'bytes=-0']) {
      const bad = await signedIn(`/files/${ROOTFS}`, { headers: { range } });
      expect(bad.status, range).toBe(416);
      expect(bad.headers.get('content-range'), range).toBe('bytes */20');
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(bad.headers.get(k), `${range} ${k}`).toBe(v);
    }

    // A range that cannot be honoured (malformed, several ranges) is ignored: the whole file.
    for (const range of ['bytes=5-2', 'bytes=0-1, 5-6', 'lines=1-2']) {
      const whole = await signedIn(`/files/${ROOTFS}`, { headers: { range } });
      expect(whole.status, range).toBe(200);
      expect(await whole.text(), range).toBe(ROOTFS_BYTES);
    }
  });

  test('If-Range: the range only while the file is unchanged, else the whole file', async () => {
    const head = await signedIn(`/files/${ROOTFS}`, { method: 'HEAD' });
    const etag = head.headers.get('etag')!;
    const resumed = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=10-', 'if-range': etag } });
    expect(resumed.status).toBe(206);
    expect(await resumed.text()).toBe('abcdefghij');
    const byDate = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=10-', 'if-range': head.headers.get('last-modified')! } });
    expect(byDate.status).toBe(206);
    await byDate.arrayBuffer();
    const changed = await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=10-', 'if-range': '"an-older-file"' } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(ROOTFS_BYTES);
  });

  test('If-None-Match with the current ETag: 304; If-Match with another: 412', async () => {
    const etag = (await signedIn(`/files/${ROOTFS}`)).headers.get('etag')!;
    const same = await signedIn(`/files/${ROOTFS}`, { headers: { 'if-none-match': etag } });
    expect(same.status).toBe(304);
    expect(same.headers.get('etag')).toBe(etag);
    expect(same.body).toBeNull();
    expect((await signedIn(`/files/${ROOTFS}`, { headers: { 'if-none-match': '"other"' } })).status).toBe(200);
    expect((await signedIn(`/files/${ROOTFS}`, { headers: { 'if-match': '"other"' } })).status).toBe(412);
  });
});

describe('the download log', () => {
  beforeEach(async () => { await publishSample(); });

  test('one empty object per download, with who and what in its custom metadata', async () => {
    const res = await run(new Request(`${HOST}/files/${ROOTFS}`, {
      headers: { cookie: await sessionCookieHeader() },
      cf: { country: 'NL' },
    } as RequestInit));
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const log = await downloadLog();
    expect(log).toHaveLength(1);
    expect(log[0].key).toMatch(/^downloads\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{12}\.json$/);
    expect(log[0].key.slice(10, 17)).toBe(new Date().toISOString().slice(0, 7).replace('-', '/'));
    expect(log[0].size).toBe(0);
    expect(log[0].customMetadata).toEqual({
      email: 'customer@example.com', path: ROOTFS, product: 'moduline-l4', version: '2026.11.0', country: 'NL',
    });

    await signedIn(`/files/${PACKAGE}`);
    const pkg = (await downloadLog()).find((o) => o.customMetadata?.path === PACKAGE);
    expect(pkg?.customMetadata).toEqual({
      email: 'customer@example.com', path: PACKAGE, product: 'moduline-hmi1', version: '2026.11.0', country: '',
    });
  });

  test('a download that is resumed or fetched in chunks counts once; HEAD, 304 and refusals never', async () => {
    const etag = (await signedIn(`/files/${ROOTFS}`, { method: 'HEAD' })).headers.get('etag')!;
    await signedIn(`/files/${ROOTFS}`, { headers: { 'if-none-match': etag } });
    await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=50-60' } });
    await signedIn(`/files/${DRAFT}`);
    await signedIn(`/files/${ROOTFS}`, { auth: false });
    expect(await downloadLog()).toHaveLength(0);

    // A download manager: the first chunk from byte 0, then the rest.
    expect((await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=0-9' } })).status).toBe(206);
    expect((await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=10-19' } })).status).toBe(206);
    expect((await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=-5' } })).status).toBe(206);
    expect(await downloadLog()).toHaveLength(1);

    // A browser: the whole file, then a resume after a broken connection.
    await signedIn(`/files/${ROOTFS}`);
    await signedIn(`/files/${ROOTFS}`, { headers: { range: 'bytes=12-' } });
    expect(await downloadLog()).toHaveLength(2);
  });
});

describe('helpers', () => {
  test('requestedPath: only images/, never an escape', () => {
    expect(requestedPath(`/files/${ROOTFS}`)).toBe(ROOTFS);
    expect(requestedPath(`/files/${PACKAGE}`)).toBe(PACKAGE);
    for (const p of ['/files/', '/files/manifest.json', '/files/downloads/x', '/files/tools/flash-tools/1.4.2/flash.ps1', `/files/${ROOTFS.replace('/', '%2F')}`, '/other/images/x']) {
      expect(requestedPath(p), p).toBeNull();
    }
  });

  test('parseRange: one range; malformed, other units and several ranges are ignored', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('bytes=0-')).toEqual({ start: 0 });
    expect(parseRange('bytes=2-5')).toEqual({ start: 2, end: 5 });
    expect(parseRange(' Bytes = 7 - ')).toEqual({ start: 7 });
    expect(parseRange('bytes=-500')).toEqual({ suffix: 500 });
    for (const h of ['bytes=', 'bytes=-', 'bytes=5-2', 'bytes=0-1, 5-6', 'items=0-1', 'bytes=a-b', '0-1']) expect(parseRange(h), h).toBeNull();
  });

  test('startsDownload: the whole file, or a range from byte 0', () => {
    expect([null, { start: 0 }, { start: 0, end: 99 }].map(startsDownload)).toEqual([true, true, true]);
    expect([{ start: 1 }, { start: 10, end: 20 }, { suffix: 5 }].map(startsDownload)).toEqual([false, false, false]);
  });

  test('rangeBounds: offset/length, open-ended and suffix ranges', () => {
    expect(rangeBounds({ offset: 0, length: 4 }, 10)).toEqual({ start: 0, end: 3 });
    expect(rangeBounds({ offset: 6 }, 10)).toEqual({ start: 6, end: 9 });
    expect(rangeBounds({ suffix: 3 }, 10)).toEqual({ start: 7, end: 9 });
    expect(rangeBounds({ suffix: 30 }, 10)).toEqual({ start: 0, end: 9 });
  });
});
