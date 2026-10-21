// POST /api/sign (sign without publishing) and the signing-key routes of a folder.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { parseContainer, readHeader, toHex } from '../src/goco';
import { parsePrivateKey, publicKeyHex } from '../src/keys';
import fixtures from './fixtures/goco/fixtures.json';
import { appId, call, ok, putManifest, spyBucket, unsignedContainer, upload, zlibPayload } from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('signing key of a folder', () => {
  test('generate: public key 130 hex, backup once (base64 + PEM of the same key), sealed in STATE', async () => {
    const id = appId('K');
    expect((await call('GET', `/api/folders/${id}/key`)).status).toBe(404);
    const made = await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    expect(made.publicKey).toMatch(/^04[0-9A-F]{128}$/);
    expect(made).toMatchObject({ source: 'generated', createdBy: 'jane.doe@gocontroll.com' });
    expect(made.backup.privateKeyB64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(publicKeyHex((await parsePrivateKey(made.backup.privateKeyB64)).publicKey)).toBe(made.publicKey);
    expect(publicKeyHex((await parsePrivateKey(made.backup.privateKeyPem)).publicKey)).toBe(made.publicKey);

    const shown = await ok('GET', `/api/folders/${id}/key`);
    expect(shown).toEqual({ publicKey: made.publicKey, source: 'generated', createdAt: made.createdAt, createdBy: made.createdBy });
    const stored = JSON.parse(await (await env.STATE.get(`keys/${id}.json`))!.text());
    expect(stored).toMatchObject({ app_id: id, public_key: made.publicKey, source: 'generated' });
    expect(stored.sealed_private_key).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(made.backup.privateKeyB64);
  });

  test('import: PEM, base64 or .cred; no backup comes back', async () => {
    const id = appId('K');
    const res = await ok('POST', `/api/folders/${id}/key`, { action: 'import', privateKey: JSON.stringify({ private_key: fixtures.key.private_pem_pkcs8 }) });
    expect(res).toMatchObject({ publicKey: fixtures.key.public_hex, source: 'imported' });
    expect(res.backup).toBeUndefined();
    const bad = await call('POST', `/api/folders/${appId('K')}/key`, { action: 'import', privateKey: 'nonsense' });
    expect(bad.status).toBe(422);
    expect(bad.body.field).toBe('privateKey');
  });

  test('a folder with a key: 409 unless replace + confirm with the App ID; the old key is retired, not deleted', async () => {
    const id = appId('K');
    const first = await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    const refused = await call('POST', `/api/folders/${id}/key`, { action: 'generate' });
    expect(refused.status).toBe(409);
    expect((await call('POST', `/api/folders/${id}/key`, { action: 'generate', replace: true, confirm: 'WRONG' })).status).toBe(409);
    const second = await ok('POST', `/api/folders/${id}/key`, { action: 'import', privateKey: fixtures.key.private_b64, replace: true, confirm: id });
    expect(second.publicKey).toBe(fixtures.key.public_hex);
    const retired = await env.STATE.list({ prefix: `keys-retired/${id}/` });
    expect(retired.objects.length).toBe(1);
    expect(JSON.parse(await (await env.STATE.get(retired.objects[0].key))!.text()).public_key).toBe(first.publicKey);
    // The same key again is no replacement.
    expect((await call('POST', `/api/folders/${id}/key`, { action: 'import', privateKey: fixtures.key.private_b64, replace: true, confirm: id })).status).toBe(422);
    const logs = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.includes(`-${id}-key-`));
    expect(logs.map((o) => o.key.replace(/^.*-(key-[a-z]+)\.json$/, '$1')).sort()).toEqual(['key-generate', 'key-replace']);
  });

  test('a Linux folder gets no key; a bad App ID is refused', async () => {
    const id = appId('L');
    await putManifest(id, { app_id: id, latest_version: '1.0.0', versions: [] });
    expect((await call('POST', `/api/folders/${id}/key`, { action: 'generate' })).status).toBe(422);
    expect((await call('POST', `/api/folders/${encodeURIComponent('a b')}/key`, { action: 'generate' })).status).toBe(400);
    expect((await call('POST', `/api/folders/${appId()}/key`, { action: 'other' })).status).toBe(400);
  });

  test('without a usable key-encryption key nothing is stored (503)', async () => {
    const id = appId('K');
    const res = await call('POST', `/api/folders/${id}/key`, { action: 'generate' }, { SIGNING_KEYS_KEY: '' });
    expect(res.status).toBe(503);
    const broken = { get: async () => { throw new Error('store down'); } };
    expect((await call('POST', `/api/folders/${id}/key`, { action: 'generate' }, { SIGNING_KEYS_KEY: broken })).status).toBe(503);
    expect(await env.STATE.head(`keys/${id}.json`)).toBeNull();
  });
});

describe('POST /api/sign', () => {
  async function folderWithKey() {
    const id = appId('S');
    const key = await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    return { id, publicKey: key.publicKey as string };
  }

  test('a payload comes back as a signed container download; nothing goes into the bucket', async () => {
    const { id, publicKey } = await folderWithKey();
    const { payload, rawSize } = await zlibPayload();
    const writes: string[] = [];
    const bucket = spyBucket(env.DEPLOY_BUCKET, async (method, args) => { if (method === 'put' || method === 'delete') writes.push(String(args[0])); });
    const res = await upload('/api/sign', { appId: id, version: '1.4.2', payload, rawSize: String(rawSize) }, { DEPLOY_BUCKET: bucket });
    expect(res.status).toBe(200);
    expect(res.res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.res.headers.get('content-disposition')).toBe(`attachment; filename="${id}-1.4.2.bin"`);
    const { header } = await parseContainer(res.bytes!);
    expect([header.headerVersion, header.appId, header.version, header.uncompressedSize]).toEqual([0x03, id, '1.4.2', rawSize]);
    expect(toHex(header.publicKey!).toUpperCase()).toBe(publicKey);
    expect(writes).toEqual([]);
    const logs = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-1.4.2.json`));
    expect(JSON.parse(await (await env.STATE.get(logs[0].key))!.text())).toMatchObject({ action: 'sign', app_id: id, version: '1.4.2', signed: true });
  });

  test('an unsigned container is re-wrapped: same payload, signed header', async () => {
    const { id, publicKey } = await folderWithKey();
    const container = await unsignedContainer(id, '2.0.0');
    const res = await upload('/api/sign', { appId: id, version: '2.0.0', container });
    expect(res.status).toBe(200);
    const signed = await parseContainer(res.bytes!);
    expect(toHex(signed.payload)).toBe(toHex(container.subarray(readHeader(container).headerSize)));
    expect(toHex(signed.header.publicKey!).toUpperCase()).toBe(publicKey);
  });

  test('wide App IDs get 0x05', async () => {
    const id = `WIDE-${appId('S')}-APP`;
    await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    const { payload, rawSize } = await zlibPayload();
    const res = await upload('/api/sign', { appId: id, version: '0.1.0', payload, rawSize: String(rawSize) });
    expect(readHeader(res.bytes!).headerVersion).toBe(0x05);
  });

  test('no key: 404; a container signed with another key, or for another App ID: 422', async () => {
    const { payload, rawSize } = await zlibPayload();
    expect((await upload('/api/sign', { appId: appId('S'), version: '1.0.0', payload, rawSize: String(rawSize) })).status).toBe(404);
    const c = fixtures.cases[2]; // ABCDEFGHI, signed by the fixture key
    await ok('POST', `/api/folders/${c.app_id}/key`, { action: 'generate' });
    const foreign = await upload('/api/sign', { appId: c.app_id, version: c.version, container: unb64(c.python_signed_b64) });
    expect(foreign.status).toBe(422);
    const { id } = await folderWithKey();
    expect((await upload('/api/sign', { appId: id, version: '1.0.0', container: await unsignedContainer(appId(), '1.0.0') })).status).toBe(422);
  });

  test('a container signed with the folder key itself is signed again with it', async () => {
    const c = fixtures.cases[3]; // the 32-character App ID, signed by the fixture key
    await ok('POST', `/api/folders/${c.app_id}/key`, { action: 'import', privateKey: fixtures.key.private_b64 });
    const res = await upload('/api/sign', { appId: c.app_id, version: c.version, container: unb64(c.python_signed_b64) });
    expect(res.status).toBe(200);
    const { header } = await parseContainer(res.bytes!);
    expect(toHex(header.publicKey!).toUpperCase()).toBe(fixtures.key.public_hex);
  });

  test('a key that does not open is a 503, never a signature with another key', async () => {
    const { id } = await folderWithKey();
    const otherKek = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const { payload, rawSize } = await zlibPayload();
    const res = await upload('/api/sign', { appId: id, version: '1.0.0', payload, rawSize: String(rawSize) }, { SIGNING_KEYS_KEY: otherKek });
    expect(res.status).toBe(503);
  });
});
