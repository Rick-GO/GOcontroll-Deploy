// The Images tab's API (src/images.ts): releases as drafts, files through an R2 multipart upload,
// publishing into manifest.json (what images.gocontroll.tech serves) and withdrawing again.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { PART_SIZE, expectedPartSize } from '../src/images';
import { STATS_PREFIX, collectFinishedMonths, imagesStats } from '../src/images-stats';
import { CATALOGUE_KEY, downloadLogKey, parseCatalogue } from '../src/images-format';
import worker from '../src/index';
import { call, ok } from './helpers';

const ORIGIN = 'http://localhost';
const ME = 'jane.doe@gocontroll.com';
const enc = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let n = 0;
const version = () => `2026.${++n}.0`;

function release(fields: Record<string, unknown> = {}) {
  return {
    kind: 'image', product: 'moduline-headless', title: 'Moduline Debian trixie (headless)', version: version(),
    controllers: ['M1', 'L4'], released: '2026-10-28', notes: 'First image.\nFor L4 and M1.', ...fields,
  };
}

const base = (r: { kind: string; product: string; version: string }) => `/api/images/releases/${r.kind}/${r.product}/${r.version}`;

async function putPart(id: string, partNumber: number, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/images/uploads/${id}/parts/${partNumber}`, {
    method: 'PUT', body: bytes, headers: { origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...headers },
  }), { ...env, DEV_USER_EMAIL: ME, DEV_USER_NAME: 'Jane Doe', DEV_USER_GROUPS: 'CF_Deploy' } as typeof env);
  return { status: res.status, body: await res.json<any>() };
}

/** Upload one small file (one part) into a draft; returns the file record. */
async function uploadFile(r: { kind: string; product: string; version: string }, name: string, content: string, role = 'rootfs') {
  const bytes = enc(content);
  const start = await ok('POST', `${base(r)}/files`, { name, size: bytes.length, role, platform: 'any' }, 201);
  expect(start).toMatchObject({ partSize: PART_SIZE, parts: 1 });
  const part = await putPart(start.id, 1, bytes);
  expect(part.status, JSON.stringify(part.body)).toBe(200);
  return ok('POST', `/api/images/uploads/${start.id}/complete`, { parts: [part.body] });
}

async function catalogue() {
  const obj = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
  return obj ? parseCatalogue(await obj.text()) : null;
}

describe('releases', () => {
  test('a draft is made once; an image needs its controllers', async () => {
    const r = release();
    const made = await ok('POST', '/api/images/releases', r, 201);
    expect(made).toMatchObject({ status: 'draft', files: [], controllers: ['L4', 'M1'], created_by: ME });
    expect((await call('POST', '/api/images/releases', r)).status).toBe(409);
    const none = await call('POST', '/api/images/releases', release({ controllers: [] }));
    expect(none.status).toBe(400);
    expect(none.body.field).toBe('controllers');
    expect((await call('POST', '/api/images/releases', release({ kind: 'tool', product: 'flash-tools', controllers: [] }))).status).toBe(201);
    expect((await call('POST', '/api/images/releases', release({ product: 'Bad Name' }))).status).toBe(400);
    expect((await call('POST', '/api/images/releases', release({ version: '../x' }))).status).toBe(400);
    expect((await call('POST', '/api/images/releases', release({ released: '2026-13-01' }))).status).toBe(400);
  });

  test('upload, publish and withdraw: customers see only a published release, without e-mail addresses', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    expect((await call('POST', `${base(r)}/publish`)).status).toBe(409); // no files yet

    const content = 'rootfs image bytes '.repeat(50);
    const file = await uploadFile(r, 'rootfs13_headless.ext4.zst', content);
    expect(file).toMatchObject({ name: 'rootfs13_headless.ext4.zst', size: content.length, role: 'rootfs', path: `images/moduline-headless/${r.version}/rootfs13_headless.ext4.zst` });
    expect(file.sha256).toBe(hex(await crypto.subtle.digest('SHA-256', enc(content))));
    expect(await (await env.IMAGES_BUCKET.get(file.path))!.text()).toBe(content);
    expect((await catalogue())?.releases.find((x) => x.version === r.version)).toBeUndefined();

    const published = await ok('POST', `${base(r)}/publish`);
    expect(published).toMatchObject({ status: 'published', published_by: ME });
    const cat = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
    const text = await cat!.text();
    expect(text).not.toContain('@');
    const entry = parseCatalogue(text).releases.find((x) => x.version === r.version)!;
    expect(entry).toMatchObject({ kind: 'image', product: 'moduline-headless', controllers: ['L4', 'M1'], notes: r.notes });
    expect(entry.files).toEqual([{ name: file.name, path: file.path, size: file.size, sha256: file.sha256, role: 'rootfs', platform: 'any' }]);

    // A published release keeps its files; its text can change, and the catalogue follows.
    expect((await call('DELETE', `${base(r)}/files/${file.name}`)).status).toBe(409);
    expect((await call('POST', `${base(r)}/files`, { name: 'extra.bin', size: 3, role: 'other' })).status).toBe(409);
    expect((await call('DELETE', base(r))).status).toBe(409);
    await ok('PATCH', base(r), { title: 'Renamed', controllers: ['L4'], released: '2026-10-29', notes: '' });
    expect((await catalogue())!.releases.find((x) => x.version === r.version)).toMatchObject({ title: 'Renamed', controllers: ['L4'], released: '2026-10-29' });

    const overview = await ok('GET', '/api/images');
    expect(overview.releases.find((x: { version: string }) => x.version === r.version)).toMatchObject({ inCatalogue: true, status: 'published' });

    await ok('POST', `${base(r)}/withdraw`);
    expect((await catalogue())!.releases.find((x) => x.version === r.version)).toBeUndefined();
    expect(await env.IMAGES_BUCKET.head(file.path)).not.toBeNull(); // the files stay

    // A draft again: files can go, and so can the release.
    await ok('DELETE', `${base(r)}/files/${file.name}`);
    expect(await env.IMAGES_BUCKET.head(file.path)).toBeNull();
    await uploadFile(r, 'barebox.img', 'boot', 'bootloader');
    await ok('DELETE', base(r));
    expect((await env.IMAGES_BUCKET.list({ prefix: `images/moduline-headless/${r.version}/` })).objects).toHaveLength(0);
    expect((await call('GET', base(r))).status).toBe(404);

    const actions = (await env.STATE.list({ prefix: 'log/' })).objects.map((o) => o.key).filter((k) => k.includes(`-image-moduline-headless-${r.version}.json`));
    expect(actions.length).toBeGreaterThanOrEqual(6);
  });

  test('parts must have their exact size, raw bytes, from this origin; an upload can be aborted', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    const start = await ok('POST', `${base(r)}/files`, { name: 'kernel.img', size: 10, role: 'kernel' }, 201);
    expect((await call('POST', `${base(r)}/files`, { name: 'kernel.img', size: 10, role: 'kernel' })).status).toBe(409);
    expect((await putPart(start.id, 1, enc('short'))).status).toBe(400);
    expect((await putPart(start.id, 2, enc('0123456789'))).status).toBe(404);
    expect((await putPart(start.id, 1, enc('0123456789'), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await putPart(start.id, 1, enc('0123456789'), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', `/api/images/uploads/${start.id}/complete`, { parts: [] })).status).toBe(400);

    const overview = await ok('GET', '/api/images');
    const up = overview.uploads.find((u: { id: string }) => u.id === start.id);
    expect(up).toMatchObject({ name: 'kernel.img', size: 10, parts: 1 });
    expect(up.upload_id).toBeUndefined();
    expect((await call('POST', `${base(r)}/publish`)).status).toBe(409); // nothing complete yet

    await ok('DELETE', `/api/images/uploads/${start.id}`);
    expect((await call('POST', `/api/images/uploads/${start.id}/complete`, { parts: [] })).status).toBe(404);
  });

  test('the part sizes: every part PART_SIZE, the last the rest', () => {
    expect(expectedPartSize(10, 1)).toBe(10);
    expect(expectedPartSize(PART_SIZE, 1)).toBe(PART_SIZE);
    expect(expectedPartSize(PART_SIZE * 2 + 5, 1)).toBe(PART_SIZE);
    expect(expectedPartSize(PART_SIZE * 2 + 5, 3)).toBe(5);
  });

  test('file names without a path, roles and platforms from the list', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    for (const name of ['../x', '.hidden', 'a/b', 'a b']) {
      expect((await call('POST', `${base(r)}/files`, { name, size: 1, role: 'other' })).status).toBe(400);
    }
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 1, role: 'firmware' })).status).toBe(400);
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 1, role: 'tool', platform: 'amiga' })).status).toBe(400);
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 0, role: 'tool' })).status).toBe(400);
  });

  test('the overview lists the downloads images.gocontroll.tech logged, newest first', async () => {
    const now = new Date();
    for (const [i, email] of ['a@example.com', 'b@example.com'].entries()) {
      await env.IMAGES_BUCKET.put(downloadLogKey(new Date(now.getTime() - (2 - i) * 60_000), `r${i}`), '', {
        customMetadata: { email, path: 'images/p/1/x.img', kind: 'image', product: 'p', version: '1', country: 'NL' },
      });
    }
    const overview = await ok('GET', '/api/images');
    expect(overview.downloads.slice(0, 2).map((d: { email: string }) => d.email)).toEqual(['b@example.com', 'a@example.com']);
    expect(overview.downloads[0]).toMatchObject({ path: 'images/p/1/x.img', country: 'NL' });
    expect(overview.downloads[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(overview.publicUrl).toBe('https://images.gocontroll.tech');
  });
});

describe('download counts (src/images-stats.ts)', () => {
  // A year of its own, after today: the overview of the other tests never stores these months.
  const at = (iso: string) => new Date(iso);
  const log = (iso: string, email: string, path: string, country = 'NL') => {
    const [, kind, product, version] = /^(images|tools)\/([^/]+)\/([^/]+)\//.exec(path)!;
    return env.IMAGES_BUCKET.put(downloadLogKey(at(iso), `r${Math.random().toString(16).slice(2, 8)}`), '', {
      customMetadata: { email, path, kind: kind === 'images' ? 'image' : 'tool', product, version, country },
    });
  };
  const A = 'images/stats-a/1.0/rootfs.img';
  const B = 'tools/stats-b/2.0/flash.sh';

  test('finished months are summed once without addresses and kept after the log expires; the month under way is live', async () => {
    await log('2031-08-03T10:00:00Z', 'a@example.com', A);
    await log('2031-08-20T10:00:00Z', 'A@example.com', A);
    await log('2031-09-01T00:00:01Z', 'b@example.com', B, 'DE');
    await log('2031-10-02T09:00:00Z', 'a@example.com', A);
    await log('2031-10-03T09:00:00Z', 'c@example.com', A, '');

    const stats = await imagesStats(env, at('2031-10-15T12:00:00Z'));
    expect(stats.error).toBeUndefined();
    expect(stats.month).toBe('2031-10');
    // Other tests log downloads too (in the real month under way): only this year's months here.
    const ours = (m: { month: string }) => m.month.startsWith('2031-');
    expect(stats.months.filter(ours).map((m) => [m.month, m.downloads, m.addresses, m.final])).toEqual([
      ['2031-10', 2, 2, false], ['2031-09', 1, 1, true], ['2031-08', 2, 1, true],
    ]);
    expect(stats.months[0].countries).toEqual({ NL: 1, '': 1 });
    expect(stats.months[2].files).toEqual({ [A]: 2 });
    expect(stats.releases.filter((r) => r.release.includes('/stats-'))).toEqual([
      { release: 'image/stats-a/1.0', total: 4, thisMonth: 2, lastMonth: 0 },
      { release: 'tool/stats-b/2.0', total: 1, thisMonth: 0, lastMonth: 1 },
    ]);
    expect(stats.months.filter(ours).reduce((n, m) => n + m.downloads, 0)).toBe(5);

    // Stored: the finished months only, with no e-mail address in them.
    const stored = await env.STATE.list({ prefix: STATS_PREFIX });
    expect(stored.objects.map((o) => o.key).filter((k) => k.includes('2031'))).toEqual(['images/stats/2031-08.json', 'images/stats/2031-09.json']);
    const august = await (await env.STATE.get('images/stats/2031-08.json'))!.text();
    expect(august).not.toContain('@');

    // The log of August expires (13 months): its counts stay.
    const aug = await env.IMAGES_BUCKET.list({ prefix: 'downloads/2031/08/' });
    await env.IMAGES_BUCKET.delete(aug.objects.map((o) => o.key));
    const later = await imagesStats(env, at('2031-10-16T12:00:00Z'));
    expect(later.months.find((m) => m.month === '2031-08')?.downloads).toBe(2);
    expect(later.total).toBe(stats.total);
  });

  test('just after a month ends it is still counted live; an hour later it is stored', async () => {
    await log('2032-01-31T23:59:00Z', 'd@example.com', B);
    expect((await collectFinishedMonths(env, at('2032-02-01T00:30:00Z'))).stored).not.toContain('2032-01');
    const early = await imagesStats(env, at('2032-02-01T00:30:00Z'));
    expect(early.months.find((m) => m.month === '2032-01')).toMatchObject({ downloads: 1, final: false });
    expect(early.releases.find((r) => r.release === 'tool/stats-b/2.0')?.lastMonth).toBe(1);
    expect((await collectFinishedMonths(env, at('2032-02-01T02:17:00Z'))).stored).toContain('2032-01');
  });

  test('the overview carries the counts', async () => {
    const overview = await ok('GET', '/api/images');
    expect(overview.stats).toMatchObject({ months: expect.any(Array), releases: expect.any(Array), total: expect.any(Number) });
    expect(overview.stats.month).toBe(new Date().toISOString().slice(0, 7));
    expect(overview.stats.months.some((m: { month: string; final: boolean }) => m.month === overview.stats.month && !m.final)).toBe(true);
  });
});
