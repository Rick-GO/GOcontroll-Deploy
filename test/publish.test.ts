// POST /api/releases: the rules of GOcontroll-Deployment-Tool/tools/r2.py publish(), plus the
// folder's signing key (cloud-r2-distribution.md §2-§4).

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { readHeader, toHex } from '../src/goco';
import fixtures from './fixtures/goco/fixtures.json';
import { appId, ok, putManifest, spyBucket, unsignedContainer, upload, zlibPayload } from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const today = () => new Date().toISOString().slice(0, 10);

async function release(id: string, version: string, extra: Record<string, string | Uint8Array> = {}, envOverrides: Record<string, unknown> = {}) {
  const { payload, rawSize } = await zlibPayload(`image ${id} ${version} `.repeat(30));
  return upload('/api/releases', { appId: id, version, description: `Release ${version}`, sign: '0', replace: '0', payload, rawSize: String(rawSize), ...extra }, envOverrides);
}

async function manifest(id: string) {
  const obj = await env.DEPLOY_BUCKET.get(`${id}/manifest.json`);
  return { obj, text: await obj!.text() };
}

describe('a new folder', () => {
  test('binary at <APP_ID>/<APP_ID>-<version>.bin, manifest with ?v= digest, indent 2 + newline', async () => {
    const id = appId();
    const res = await release(id, '1.0.0');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      binaryKey: `${id}/${id}-1.0.0.bin`, manifestKey: `${id}/manifest.json`, version: '1.0.0', releaseDate: today(),
      previousLatest: null, replaced: false, latestMovedBack: false, signed: false,
    });

    const bin = await env.DEPLOY_BUCKET.get(`${id}/${id}-1.0.0.bin`);
    expect(bin!.httpMetadata?.contentType).toBe('application/octet-stream');
    const data = new Uint8Array(await bin!.arrayBuffer());
    const h = readHeader(data);
    expect([h.headerVersion, h.appId, h.version, h.signed]).toEqual([0x02, id, '1.0.0', false]);

    const { obj, text } = await manifest(id);
    expect(obj!.httpMetadata?.contentType).toBe('application/json');
    expect(text.endsWith('}\n')).toBe(true);
    const doc = JSON.parse(text);
    expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    // A new folder gets the first DISTRIBUTION_URL.
    const url = `https://deploy.gocontroll.tech/${id}/${id}-1.0.0.bin?v=${toHex(h.sha256).slice(0, 16)}`;
    expect(res.body.binaryUrl).toBe(url);
    expect(doc).toEqual({ application_id: id, latest: '1.0.0', binaries: { '1.0.0': { url, release_date: today(), description: 'Release 1.0.0' } } });
  });

  test('a description of 500 characters (and more) is taken as it is', async () => {
    const id = appId();
    const text = 'Fixes and changes. '.repeat(27).slice(0, 500);
    expect((await release(id, '1.0.0', { description: text })).status).toBe(200);
    expect(JSON.parse((await manifest(id)).text).binaries['1.0.0'].description).toBe(text.trim());
  });

  test('another distribution URL of the bucket may be chosen; one outside it is refused', async () => {
    const id = appId();
    const res = await release(id, '1.0.0', { distributionUrl: 'https://deploy.gocontroll.com/' });
    expect(res.body.binaryUrl.startsWith(`https://deploy.gocontroll.com/${id}/`)).toBe(true);
    const bad = await release(appId(), '1.0.0', { distributionUrl: 'https://evil.example' });
    expect(bad.status).toBe(422);
  });

  test('description is mandatory; a payload must be zlib; version and App ID are checked', async () => {
    const id = appId();
    expect((await release(id, '1.0.0', { description: '  ' })).status).toBe(400);
    const notZlib = await release(id, '1.0.0', { payload: new Uint8Array([1, 2, 3, 4]) });
    expect([notZlib.status, notZlib.body.field]).toEqual([422, 'file']);
    expect((await release(id, '1.0.0', { description: '' })).body.field).toBe('description');
    expect((await release(id, '1.2')).body.field).toBe('version');
    expect((await release('', '1.0.0')).body.field).toBe('appId');
    expect((await release(id, '1.2')).status).toBe(400);
    expect((await release(id, '256.0.0')).status).toBe(400);
    expect((await release('bad/id', '1.0.0')).status).toBe(400);
    expect((await release('X'.repeat(33), '1.0.0')).status).toBe(400);
    expect((await release(id, '1.0.0', { rawSize: String(0x1f8001) })).status).toBe(422);
    expect(await env.DEPLOY_BUCKET.get(`${id}/manifest.json`)).toBeNull();
  });
});

describe('an existing folder', () => {
  test('a version already there is 409 without replace; with replace it is overwritten', async () => {
    const id = appId();
    await release(id, '1.0.0');
    const again = await release(id, '1.0.0');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already published/);
    const replaced = await release(id, '1.0.0', { replace: '1', description: 'Rebuilt' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.replaced).toBe(true);
    const doc = JSON.parse((await manifest(id)).text);
    expect(doc.binaries['1.0.0'].description).toBe('Rebuilt');
    expect(doc.binaries['1.0.0'].url).toBe(replaced.body.binaryUrl);
    // The way back: the replaced binary and the manifest before are kept in STATE.
    const kept = await env.STATE.list({ prefix: `replaced/${id}/${id}-1.0.0/` });
    expect(kept.objects.length).toBe(1);
    const log = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-1.0.0.json`)).map((o) => o.key).sort();
    const entry = JSON.parse(await (await env.STATE.get(log[1]))!.text());
    expect(entry.previous_binary).toBe(kept.objects[0].key);
    expect(entry.previous_manifest.binaries['1.0.0'].description).toBe('Release 1.0.0');
  });

  test('latest moves to the new version; an older one moves it back and says so', async () => {
    const id = appId();
    await release(id, '1.0.0');
    const next = await release(id, '1.1.0');
    expect(next.body).toMatchObject({ previousLatest: '1.0.0', latestMovedBack: false });
    const back = await release(id, '1.0.5');
    expect(back.body).toMatchObject({ previousLatest: '1.1.0', latestMovedBack: true });
    expect(JSON.parse((await manifest(id)).text).latest).toBe('1.0.5');
  });

  test('unknown manifest fields are kept; the host its URLs name is kept (never two hosts)', async () => {
    const id = appId();
    await putManifest(id, {
      application_id: id, latest: '0.0.1', latest_only: true, note: { keep: 'me' },
      binaries: { '0.0.1': { url: `https://deploy.gocontroll.com/${id}/${id}-0.0.1.bin`, release_date: '2026-01-01', description: 'Old', extra: 1 } },
    });
    const res = await release(id, '0.0.2', { distributionUrl: 'https://deploy.gocontroll.tech' });
    expect(res.status).toBe(200);
    expect(res.body.binaryUrl.startsWith('https://deploy.gocontroll.com/')).toBe(true);
    const doc = JSON.parse((await manifest(id)).text);
    expect(doc.latest_only).toBe(true);
    expect(doc.note).toEqual({ keep: 'me' });
    expect(doc.binaries['0.0.1']).toEqual({ url: `https://deploy.gocontroll.com/${id}/${id}-0.0.1.bin`, release_date: '2026-01-01', description: 'Old', extra: 1 });
  });

  test('a manifest naming a host outside the bucket, or one that cannot be read, is refused', async () => {
    const id = appId();
    await putManifest(id, { application_id: id, latest: '0.0.1', binaries: { '0.0.1': { url: `https://elsewhere.example/${id}/a.bin`, release_date: '', description: '' } } });
    expect((await release(id, '0.0.2')).status).toBe(422);
    const broken = appId();
    await env.DEPLOY_BUCKET.put(`${broken}/manifest.json`, '{ not json');
    expect((await release(broken, '0.0.2')).status).toBe(422);
    const noBinaries = appId();
    await putManifest(noBinaries, { application_id: noBinaries, latest: '1.0.0' });
    expect((await release(noBinaries, '1.0.1')).status).toBe(422);
  });

  test('a folder with a Linux manifest is refused (422) and left alone', async () => {
    const id = appId('L');
    const linux = { app_id: id, latest_version: '1.0.1', versions: [{ version: '1.0.1', tarball: 'v1.0.1/update.tar.gz' }] };
    await putManifest(id, linux);
    const res = await release(id, '2.0.0');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Linux/);
    expect(JSON.parse((await manifest(id)).text)).toEqual(linux);
    expect(await env.DEPLOY_BUCKET.head(`${id}/${id}-2.0.0.bin`)).toBeNull();
  });
});

describe('containers', () => {
  test('a ready-made container goes out unchanged; its App ID and version must match', async () => {
    const id = appId();
    const container = await unsignedContainer(id, '3.2.1');
    const res = await upload('/api/releases', { appId: id, version: '3.2.1', description: 'From CI', sign: '0', container });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = new Uint8Array(await (await env.DEPLOY_BUCKET.get(`${id}/${id}-3.2.1.bin`))!.arrayBuffer());
    expect(toHex(stored)).toBe(toHex(container));
    expect((await upload('/api/releases', { appId: id, version: '3.2.2', description: 'x', container })).status).toBe(422);
    expect((await upload('/api/releases', { appId: appId(), version: '3.2.1', description: 'x', container })).status).toBe(422);
  });

  test('without a typed version the container names its own', async () => {
    const id = appId();
    const res = await upload('/api/releases', { appId: id, description: 'From CI', container: await unsignedContainer(id, '4.0.0') });
    expect(res.body.version).toBe('4.0.0');
  });

  test('a damaged container is refused', async () => {
    const id = appId();
    const container = await unsignedContainer(id, '1.0.0');
    container[container.length - 1] ^= 1;
    expect((await upload('/api/releases', { appId: id, version: '1.0.0', description: 'x', container })).status).toBe(422);
    expect((await upload('/api/releases', { appId: id, version: '1.0.0', description: 'x', container: new TextEncoder().encode('ELF.....') })).status).toBe(422);
  });

  test('a Python-signed container (another key, no folder key) is published as it is', async () => {
    const c = fixtures.cases[0]; // App ID GOCO
    const res = await upload('/api/releases', { appId: c.app_id, version: c.version, description: 'Python', container: unb64(c.python_signed_b64) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.signed).toBe(true);
  });
});

describe('with a signing key', () => {
  async function withKey() {
    const id = appId('K');
    const key = await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    return { id, publicKey: key.publicKey as string };
  }

  test('unsigned is refused (422); signed with the folder key is written', async () => {
    const { id, publicKey } = await withKey();
    const unsigned = await release(id, '1.0.0');
    expect(unsigned.status).toBe(422);
    expect(unsigned.body.error).toMatch(/must be signed/);
    const signed = await release(id, '1.0.0', { sign: '1' });
    expect(signed.status).toBe(200);
    expect(signed.body.signed).toBe(true);
    const h = readHeader(new Uint8Array(await (await env.DEPLOY_BUCKET.get(`${id}/${id}-1.0.0.bin`))!.arrayBuffer()));
    expect(h.headerVersion).toBe(0x03);
    expect(toHex(h.publicKey!).toUpperCase()).toBe(publicKey);
  });

  test('an unsigned container is signed (payload taken over); one signed with another key is refused', async () => {
    const { id, publicKey } = await withKey();
    const container = await unsignedContainer(id, '2.0.0');
    const res = await upload('/api/releases', { appId: id, version: '2.0.0', description: 'CI', sign: '1', container });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = new Uint8Array(await (await env.DEPLOY_BUCKET.get(`${id}/${id}-2.0.0.bin`))!.arrayBuffer());
    const h = readHeader(stored);
    expect(toHex(h.publicKey!).toUpperCase()).toBe(publicKey);
    expect(toHex(stored.subarray(h.headerSize))).toBe(toHex(container.subarray(readHeader(container).headerSize)));

    // The Python-signed ABCDEFGH container is signed with the fixture key, not this folder's.
    const other = fixtures.cases[1];
    await ok('POST', `/api/folders/${other.app_id}/key`, { action: 'generate' });
    const foreign = await upload('/api/releases', { appId: other.app_id, version: other.version, description: 'x', sign: '1', container: unb64(other.python_signed_b64) });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error).toMatch(/another key/);
  });

  test('sign=1 without a key is refused', async () => {
    expect((await release(appId(), '1.0.0', { sign: '1' })).status).toBe(422);
  });
});

test('the binary is written before the manifest, and a manifest changed meanwhile is a 409', async () => {
  const id = appId();
  await release(id, '1.0.0');
  const puts: string[] = [];
  const racing = spyBucket(env.DEPLOY_BUCKET, async (method, args, target) => {
    if (method !== 'put') return;
    puts.push(args[0]);
    // Someone else writes the manifest between our read and our write.
    if (String(args[0]).endsWith('/manifest.json')) await target.put(args[0], JSON.stringify({ application_id: id, latest: '9.9.9', binaries: {} }));
  });
  const { payload, rawSize } = await zlibPayload('race');
  const raced = await upload('/api/releases', { appId: id, version: '1.2.0', description: 'Race', payload, rawSize: String(rawSize) }, { DEPLOY_BUCKET: racing });
  expect(puts).toEqual([`${id}/${id}-1.2.0.bin`, `${id}/manifest.json`]);
  expect(raced.status).toBe(409);
  expect(JSON.parse((await manifest(id)).text).latest).toBe('9.9.9');
});

test('a new folder whose manifest someone else creates meanwhile is a 409 too (if-none-match: *)', async () => {
  const id = appId();
  const racing = spyBucket(env.DEPLOY_BUCKET, async (method, args, target) => {
    if (method === 'put' && String(args[0]).endsWith('/manifest.json')) await target.put(args[0], '{"application_id":"x","latest":"0.0.1","binaries":{}}');
  });
  const res = await release(id, '1.0.0', {}, { DEPLOY_BUCKET: racing });
  expect(res.status).toBe(409);
  expect(JSON.parse((await manifest(id)).text).application_id).toBe('x');
});

test('publishing is logged in STATE and never deletes anything', async () => {
  const id = appId();
  const calls: string[] = [];
  const bucket = spyBucket(env.DEPLOY_BUCKET, async (method) => { calls.push(method); });
  await release(id, '1.0.0', {}, { DEPLOY_BUCKET: bucket });
  await release(id, '1.0.0', { replace: '1' }, { DEPLOY_BUCKET: bucket });
  expect(calls).toContain('put');
  expect(calls).not.toContain('delete');
  const month = new Date().toISOString().slice(0, 7).replace('-', '/');
  const logs = await env.STATE.list({ prefix: `log/${month}/` });
  const mine = logs.objects.filter((o) => o.key.includes(`-${id}-1.0.0`));
  expect(mine.length).toBe(2);
  const entry = JSON.parse(await (await env.STATE.get(mine[0].key))!.text());
  expect(entry).toMatchObject({ action: 'publish', app_id: id, version: '1.0.0', actor: 'jane.doe@gocontroll.com', signed: false });
  expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
});
