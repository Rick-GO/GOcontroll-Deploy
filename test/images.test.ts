// The Images tab's API (src/images.ts): releases as drafts, files through an R2 multipart upload,
// publishing into manifest.json (what images.gocontroll.tech serves) and withdrawing again.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { PART_SIZE, expectedPartSize } from '../src/images';
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
