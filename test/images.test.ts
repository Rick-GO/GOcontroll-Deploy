// The Images tab's API (src/images.ts): releases as drafts, files through an R2 multipart upload,
// publishing into manifest.json (what images.gocontroll.tech serves) and withdrawing again.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { PART_SIZE, expectedPartSize } from '../src/images';
import { STATS_PREFIX, collectFinishedMonths, imagesStats } from '../src/images-stats';
import { CATALOGUE_KEY, catalogueText, downloadLogKey, parseCatalogue, productOf, type ImageController } from '../src/images-format';
import worker from '../src/index';
import { call, ok } from './helpers';

const ORIGIN = 'http://localhost';
const ME = 'jane.doe@gocontroll.com';
const enc = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let n = 0;
const version = () => `2026.${++n}.0`;

function release(fields: Record<string, unknown> = {}) {
  return { controller: 'L4', version: version(), released: '2026-10-28', notes: 'First image.\nKernel 6.12.', ...fields };
}

/** A release's URL: its folder (controller + type) and version. */
const base = (r: { controller: string; type?: string; version: string }) =>
  `/api/images/releases/${productOf(r.controller as ImageController, r.type ?? '')}/${r.version}`;

async function putPart(id: string, partNumber: number, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/images/uploads/${id}/parts/${partNumber}`, {
    method: 'PUT', body: bytes, headers: { origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...headers },
  }), { ...env, DEV_USER_EMAIL: ME, DEV_USER_NAME: 'Jane Doe', DEV_USER_GROUPS: 'CF_Deploy' } as typeof env);
  return { status: res.status, body: await res.json<any>() };
}

/** Upload one small file (one part) into a draft; returns the file record. */
async function uploadFile(r: { controller: string; type?: string; version: string }, name: string, content: string, role = 'rootfs') {
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
  test('a draft is one controller and a version; no product, no title; made once', async () => {
    const r = release();
    const made = await ok('POST', '/api/images/releases', r, 201);
    expect(made).toMatchObject({ status: 'draft', files: [], controller: 'L4', version: r.version, created_by: ME });
    for (const gone of ['kind', 'product', 'title', 'controllers']) expect(made[gone], gone).toBeUndefined();
    // The product folder follows from the controller: the same keys as before.
    expect(await env.STATE.head(`images/releases/moduline-l4/${r.version}.json`)).not.toBeNull();
    expect((await call('POST', '/api/images/releases', r)).status).toBe(409);
    const none = await call('POST', '/api/images/releases', release({ controller: undefined }));
    expect(none.status).toBe(400);
    expect(none.body.field).toBe('controller');
    // A list of controllers (0.8.0) or a product is no controller.
    for (const fields of [{ controller: 'L5' }, { controller: undefined, controllers: ['L4'] }, { controller: undefined, product: 'moduline-l4' }]) {
      expect((await call('POST', '/api/images/releases', release(fields))).status, JSON.stringify(fields)).toBe(400);
    }
    // The URLs of 0.9.0 named the controller: no such folder.
    expect((await call('POST', `/api/images/releases/L4/${r.version}/publish`)).status).toBe(404);
    expect(made.type).toBe('');
    const m1 = release({ controller: 'M1' });
    expect(await ok('POST', '/api/images/releases', m1, 201)).toMatchObject({ controller: 'M1' });
    expect(await env.STATE.head(`images/releases/moduline-m1/${m1.version}.json`)).not.toBeNull();
    expect((await call('POST', '/api/images/releases', release({ version: '../x' }))).status).toBe(400);
    expect((await call('POST', '/api/images/releases', release({ released: '2026-13-01' }))).status).toBe(400);
  });

  test('upload, publish and withdraw: customers see only a published release, without e-mail addresses', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    expect((await call('POST', `${base(r)}/publish`)).status).toBe(409); // no files yet

    const content = 'rootfs image bytes '.repeat(50);
    const file = await uploadFile(r, 'rootfs13_headless.ext4.zst', content);
    expect(file).toMatchObject({ name: 'rootfs13_headless.ext4.zst', size: content.length, role: 'rootfs', path: `images/moduline-l4/${r.version}/rootfs13_headless.ext4.zst` });
    expect(file.sha256).toBe(hex(await crypto.subtle.digest('SHA-256', enc(content))));
    expect(await (await env.IMAGES_BUCKET.get(file.path))!.text()).toBe(content);
    expect((await catalogue())?.releases.find((x) => x.version === r.version)).toBeUndefined();

    const published = await ok('POST', `${base(r)}/publish`);
    expect(published).toMatchObject({ status: 'published', published_by: ME });
    const cat = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
    const text = await cat!.text();
    expect(text).not.toContain('@');
    for (const gone of ['kind', 'product', 'title', 'controllers']) expect(text).not.toContain(`"${gone}"`);
    expect(JSON.parse(text).format).toBe(4);
    const entry = parseCatalogue(text).releases.find((x) => x.version === r.version)!;
    expect(entry).toMatchObject({ controller: 'L4', notes: r.notes });
    expect(entry.files).toEqual([{ name: file.name, path: file.path, size: file.size, sha256: file.sha256, role: 'rootfs', platform: 'any' }]);

    // A published release keeps its files; its text can change, and the catalogue follows.
    expect((await call('DELETE', `${base(r)}/files/${file.name}`)).status).toBe(409);
    expect((await call('POST', `${base(r)}/files`, { name: 'extra.bin', size: 3, role: 'other' })).status).toBe(409);
    expect((await call('DELETE', base(r))).status).toBe(409);
    // Only the date and the notes change; a title or another controller is not part of a release.
    await ok('PATCH', base(r), { title: 'Renamed', controller: 'M1', released: '2026-10-29', notes: '' });
    expect((await catalogue())!.releases.find((x) => x.version === r.version)).toEqual(expect.objectContaining({ controller: 'L4', released: '2026-10-29', notes: '' }));
    expect((await catalogue())!.releases.find((x) => x.version === r.version)).not.toHaveProperty('title');

    const overview = await ok('GET', '/api/images');
    expect(overview.releases.find((x: { version: string }) => x.version === r.version)).toMatchObject({ controller: 'L4', product: 'moduline-l4', inCatalogue: true, status: 'published' });

    await ok('POST', `${base(r)}/withdraw`);
    expect((await catalogue())!.releases.find((x) => x.version === r.version)).toBeUndefined();
    expect(await env.IMAGES_BUCKET.head(file.path)).not.toBeNull(); // the files stay

    // A draft again: files can go, and so can the release.
    await ok('DELETE', `${base(r)}/files/${file.name}`);
    expect(await env.IMAGES_BUCKET.head(file.path)).toBeNull();
    await uploadFile(r, 'barebox.img', 'boot', 'bootloader');
    await ok('DELETE', base(r));
    expect((await env.IMAGES_BUCKET.list({ prefix: `images/moduline-l4/${r.version}/` })).objects).toHaveLength(0);
    expect((await call('GET', base(r))).status).toBe(404);

    const actions = (await env.STATE.list({ prefix: 'log/' })).objects.map((o) => o.key).filter((k) => k.includes(`-image-moduline-l4-${r.version}.json`));
    expect(actions.length).toBeGreaterThanOrEqual(6);
  });

  test('an unfinished upload of 0.8.0 (with a product) is listed and can be aborted', async () => {
    const id = 'ab'.repeat(16);
    await env.STATE.put(`images/uploads/${id}.json`, JSON.stringify({
      id, upload_id: 'not-a-real-upload', key: 'images/moduline-hmi1/1.0/x.zip', product: 'moduline-hmi1', version: '1.0', name: 'x.zip',
      size: 3, role: 'package', platform: 'any', part_size: PART_SIZE, parts: 1, started_at: '2026-10-29T12:00:00.000Z', started_by: ME,
    }));
    const up = (await ok('GET', '/api/images')).uploads.find((u: { id: string }) => u.id === id);
    // Read as the controller of its product, without a type; the overview adds the folder it belongs to.
    expect(up).toMatchObject({ controller: 'HMI1', type: '', product: 'moduline-hmi1', version: '1.0' });
    await ok('DELETE', `/api/images/uploads/${id}`);
    expect(await env.STATE.head(`images/uploads/${id}.json`)).toBeNull();
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

  test('file names without a path, roles and platforms from the list; the complete image is a package', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    for (const name of ['../x', '.hidden', 'a/b', 'a b']) {
      expect((await call('POST', `${base(r)}/files`, { name, size: 1, role: 'other' })).status).toBe(400);
    }
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 1, role: 'firmware' })).status).toBe(400);
    expect((await call('POST', `${base(r)}/files`, { name: 'x.exe', size: 1, role: 'tool' })).status).toBe(400); // a role until 0.7.0
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 1, role: 'other', platform: 'amiga' })).status).toBe(400);
    expect((await call('POST', `${base(r)}/files`, { name: 'x.bin', size: 0, role: 'other' })).status).toBe(400);
    const pkg = await uploadFile(r, 'moduline-l4-uuu.zip', 'zip with the image and the kernel script', 'package');
    expect(pkg).toMatchObject({ role: 'package', path: `images/moduline-l4/${r.version}/moduline-l4-uuu.zip` });
  });

  test('manifest.json of an older format is written as format 4; one of a newer format is never overwritten', async () => {
    const r = release();
    await ok('POST', '/api/images/releases', r, 201);
    await uploadFile(r, 'image.zip', 'zip', 'package');
    const before = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
    const kept = before ? await before.text() : null;
    try {
      await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText({ format: 5, updated: null, releases: [] }));
      const refused = await call('POST', `${base(r)}/publish`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/format 5/);
      expect(JSON.parse(await (await env.IMAGES_BUCKET.get(CATALOGUE_KEY))!.text()).format).toBe(5);

      await env.IMAGES_BUCKET.put(CATALOGUE_KEY, JSON.stringify({ format: 1, updated: null, releases: [] }));
      await ok('POST', `${base(r)}/publish`);
      const doc = JSON.parse(await (await env.IMAGES_BUCKET.get(CATALOGUE_KEY))!.text());
      expect(doc.format).toBe(4);
      expect(doc.releases.map((x: { version: string }) => x.version)).toContain(r.version);
    } finally {
      if (kept === null) await env.IMAGES_BUCKET.delete(CATALOGUE_KEY);
      else await env.IMAGES_BUCKET.put(CATALOGUE_KEY, kept);
    }
  });

  test('the L4 release of 0.8.0 (format 2, record with product, title and controllers) shows, withdraws and deletes', async () => {
    const v = '6.12.87';
    const name = 'moduline-l4-306-d_2026-10-29_6.12.87.zip';
    const path = `images/moduline-l4/${v}/${name}`;
    const sha = hex(await crypto.subtle.digest('SHA-256', enc('zip')));
    const file = { name, path, size: 3, sha256: sha, role: 'package', platform: 'any' };
    const old = {
      product: 'moduline-l4', title: 'Moduline L4', version: v, controllers: ['L4'], released: '2026-10-29', notes: '',
      files: [{ ...file, uploaded_at: '2026-10-29T12:51:41.533Z', uploaded_by: ME }],
      status: 'published', created_at: '2026-10-29T12:49:31.252Z', created_by: ME, updated_at: '2026-10-29T12:55:22.155Z', updated_by: ME,
      published_at: '2026-10-29T12:54:31.002Z', published_by: ME,
    };
    const before = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
    const kept = before ? await before.text() : null;
    try {
      await env.IMAGES_BUCKET.put(path, 'zip');
      await env.STATE.put(`images/releases/moduline-l4/${v}.json`, JSON.stringify(old));
      await env.IMAGES_BUCKET.put(CATALOGUE_KEY, JSON.stringify({ format: 2, updated: '2026-10-29T12:55:22.464Z', releases: [{
        product: 'moduline-l4', title: 'Moduline L4', version: v, controllers: ['L4'], released: '2026-10-29', notes: '', files: [file],
      }] }, null, 2));

      const shown = (await ok('GET', '/api/images')).releases.find((x: { version: string }) => x.version === v);
      expect(shown).toMatchObject({ controller: 'L4', product: 'moduline-l4', status: 'published', inCatalogue: true });
      for (const gone of ['title', 'controllers']) expect(shown[gone], gone).toBeUndefined();

      await ok('POST', `/api/images/releases/moduline-l4/${v}/withdraw`);
      const doc = JSON.parse(await (await env.IMAGES_BUCKET.get(CATALOGUE_KEY))!.text());
      expect(doc).toMatchObject({ format: 4, releases: [] });
      const record = JSON.parse(await (await env.STATE.get(`images/releases/moduline-l4/${v}.json`))!.text());
      expect(record).toMatchObject({ controller: 'L4', type: '', version: v, status: 'draft' });
      for (const gone of ['product', 'title', 'controllers']) expect(record[gone], gone).toBeUndefined();

      await ok('DELETE', `/api/images/releases/moduline-l4/${v}`);
      expect(await env.STATE.head(`images/releases/moduline-l4/${v}.json`)).toBeNull();
      expect(await env.IMAGES_BUCKET.head(path)).toBeNull();
    } finally {
      if (kept === null) await env.IMAGES_BUCKET.delete(CATALOGUE_KEY);
      else await env.IMAGES_BUCKET.put(CATALOGUE_KEY, kept);
    }
  });

  test('a type: its own folder and system; the same slug with other characters is refused; it cannot be edited', async () => {
    const v = `${version()}-t`;
    const av123 = await ok('POST', '/api/images/releases', release({ controller: 'HMI1', type: '  1.07   -  AV123 ', version: v }), 201);
    expect(av123).toMatchObject({ controller: 'HMI1', type: '1.07 - AV123', version: v });
    expect(await env.STATE.head(`images/releases/moduline-hmi1-107-av123/${v}.json`)).not.toBeNull();
    // Another type and no type are other systems: the same version is free for them.
    await ok('POST', '/api/images/releases', release({ controller: 'HMI1', type: '1.07 - AV101', version: v }), 201);
    await ok('POST', '/api/images/releases', release({ controller: 'HMI1', version: v }), 201);
    expect((await call('POST', '/api/images/releases', release({ controller: 'HMI1', type: '1.07 - AV123', version: v }))).status).toBe(409);
    // The same folder (slug) written differently: refused, naming the type that is there.
    const same = await call('POST', '/api/images/releases', release({ controller: 'HMI1', type: '1.07-AV123', version: `${v}.1` }));
    expect(same.status).toBe(409);
    expect(same.body.field).toBe('type');
    expect(same.body.error).toContain('moduline-hmi1-107-av123');
    expect(same.body.error).toContain('"1.07 - AV123"');
    for (const type of ['--', 'x'.repeat(41), 'AV123é', 'a\u0007b']) {
      const bad = await call('POST', '/api/images/releases', release({ controller: 'HMI1', type, version: `${v}.2` }));
      expect(bad.status, type).toBe(400);
      expect(bad.body.field, type).toBe('type');
    }

    const r = { controller: 'HMI1', type: '1.07 - AV123', version: v };
    const pkg = await uploadFile(r, 'moduline-hmi1-107-av123.zip', 'zip', 'package');
    expect(pkg.path).toBe(`images/moduline-hmi1-107-av123/${v}/moduline-hmi1-107-av123.zip`);
    await ok('POST', `${base(r)}/publish`);
    // Editing changes the date and the notes; the type is what the release is.
    await ok('PATCH', base(r), { type: 'other', released: '2026-10-30', notes: 'AV123 adapter board.' });
    const entry = (await catalogue())!.releases.find((x) => x.version === v && x.type === '1.07 - AV123');
    expect(entry).toMatchObject({ controller: 'HMI1', type: '1.07 - AV123', released: '2026-10-30', notes: 'AV123 adapter board.' });
    expect(entry!.files.map((f) => f.path)).toEqual([pkg.path]);
    const shown = (await ok('GET', '/api/images')).releases.filter((x: { version: string }) => x.version === v);
    expect(shown.map((x: { type: string; product: string }) => `${x.type}|${x.product}`)).toEqual([
      '|moduline-hmi1', '1.07 - AV101|moduline-hmi1-107-av101', '1.07 - AV123|moduline-hmi1-107-av123',
    ]);
    await ok('POST', `${base(r)}/withdraw`);
  });

  test('the releases live before 0.10.0 (format 3, no type) stay downloadable and can be withdrawn and deleted', async () => {
    const rec = (controller: string, v: string, name: string) => {
      const product = productOf(controller as ImageController);
      const file = { name, path: `images/${product}/${v}/${name}`, size: 3, sha256: 'c'.repeat(64), role: 'package', platform: 'any' };
      return {
        product, file, entry: { controller, version: v, released: '2026-10-29', notes: '', files: [file] },
        record: { controller, version: v, released: '2026-10-29', notes: '', files: [{ ...file, uploaded_at: '2026-10-29T13:40:00.000Z', uploaded_by: ME }],
          status: 'published', created_at: '2026-10-29T13:30:00.000Z', created_by: ME, updated_at: '2026-10-29T13:41:00.000Z', updated_by: ME,
          published_at: '2026-10-29T13:41:00.000Z', published_by: ME },
      };
    };
    const live = [
      rec('M1', 'live-6.12.87', 'moduline-m1-111_2026-10-29_6.12.87.zip'),
      rec('HMI1', 'AV123_6.12.87', 'moduline-hmi1-107-av123_2026-10-29_6.12.87.zip'),
      rec('HMI1', 'AV101_6.12.87', 'moduline-hmi1-107-av101_2026-10-29_6.12.87.zip'),
    ];
    const before = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
    const kept = before ? await before.text() : null;
    try {
      for (const l of live) {
        await env.IMAGES_BUCKET.put(l.file.path, 'zip');
        await env.STATE.put(`images/releases/${l.product}/${l.entry.version}.json`, JSON.stringify(l.record));
      }
      await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText({ format: 3, updated: '2026-10-29T13:43:36.525Z', releases: live.map((l) => l.entry) } as never));
      const parsed = (await catalogue())!;
      expect(parsed.releases.map((x) => `${x.controller}|${x.type}|${x.version}|${x.files.length}`)).toEqual([
        'M1||live-6.12.87|1', 'HMI1||AV123_6.12.87|1', 'HMI1||AV101_6.12.87|1',
      ]);
      const shown = (await ok('GET', '/api/images')).releases.filter((x: { version: string }) => live.some((l) => l.entry.version === x.version));
      expect(shown.every((x: { type: string; inCatalogue: boolean }) => x.type === '' && x.inCatalogue)).toBe(true);

      // What the owner does after the deploy: withdraw and delete the HMI1 releases named by version.
      await ok('POST', '/api/images/releases/moduline-hmi1/AV101_6.12.87/withdraw');
      const doc = JSON.parse(await (await env.IMAGES_BUCKET.get(CATALOGUE_KEY))!.text());
      expect(doc.format).toBe(4);
      expect(doc.releases.map((x: { controller: string; type: string; version: string }) => `${x.controller}|${x.type}|${x.version}`)).toEqual([
        'M1||live-6.12.87', 'HMI1||AV123_6.12.87',
      ]);
      await ok('DELETE', '/api/images/releases/moduline-hmi1/AV101_6.12.87');
      expect(await env.IMAGES_BUCKET.head(live[2].file.path)).toBeNull();
      expect(await env.IMAGES_BUCKET.head(live[1].file.path)).not.toBeNull();
    } finally {
      for (const l of live) {
        await env.STATE.delete(`images/releases/${l.product}/${l.entry.version}.json`);
        await env.IMAGES_BUCKET.delete(l.file.path);
      }
      if (kept === null) await env.IMAGES_BUCKET.delete(CATALOGUE_KEY);
      else await env.IMAGES_BUCKET.put(CATALOGUE_KEY, kept);
    }
  });

  test('the overview lists the downloads images.gocontroll.tech logged, newest first', async () => {
    const now = new Date();
    for (const [i, email] of ['a@example.com', 'b@example.com'].entries()) {
      await env.IMAGES_BUCKET.put(downloadLogKey(new Date(now.getTime() - (2 - i) * 60_000), `r${i}`), '', {
        customMetadata: { email, path: 'images/p/1/x.img', product: 'p', version: '1', country: 'NL' },
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
    const [, product, version] = /^images\/([^/]+)\/([^/]+)\//.exec(path)!;
    return env.IMAGES_BUCKET.put(downloadLogKey(at(iso), `r${Math.random().toString(16).slice(2, 8)}`), '', {
      customMetadata: { email, path, product, version, country },
    });
  };
  const A = 'images/stats-a/1.0/rootfs.img';
  const B = 'images/stats-b/2.0/stats-b.zip';

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
    expect(stats.releases.filter((r) => r.release.startsWith('stats-'))).toEqual([
      { release: 'stats-a/1.0', total: 4, thisMonth: 2, lastMonth: 0 },
      { release: 'stats-b/2.0', total: 1, thisMonth: 0, lastMonth: 1 },
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
    expect(early.releases.find((r) => r.release === 'stats-b/2.0')?.lastMonth).toBe(1);
    expect((await collectFinishedMonths(env, at('2032-02-01T02:17:00Z'))).stored).toContain('2032-01');
  });

  test('the overview carries the counts', async () => {
    const overview = await ok('GET', '/api/images');
    expect(overview.stats).toMatchObject({ months: expect.any(Array), releases: expect.any(Array), total: expect.any(Number) });
    expect(overview.stats.month).toBe(new Date().toISOString().slice(0, 7));
    expect(overview.stats.months.some((m: { month: string; final: boolean }) => m.month === overview.stats.month && !m.final)).toBe(true);
  });
});
