// The public key of an application (PUT/GET /api/folders/:appId/key), the scope the browser
// signs (POST /api/sign/scope) and signing without publishing (POST /api/sign). Since 0.7.0 the
// private key never reaches the Worker: these tests sign the way the page does (helpers.ts
// browserSignature, public/js/signing.js) and check that no private key is taken, kept or logged.

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildHeader, parseContainer, readHeader, toHex } from '../src/goco';
import { parsePublicKeyHex, sealScalar } from '../src/keys';
import { generateKeyPair, signerFor, toBase64 } from '../public/js/signing.js';
import fixtures from './fixtures/goco/fixtures.json';
import {
  TEST_KEK, appId, attachNewKey, browserSignature, call, ok, putManifest, spyBucket, unsignedContainer, upload, zlibPayload,
} from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Every object in STATE (keys, log, …) as text, to look for a private key in. */
async function stateText(): Promise<string> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ cursor, limit: 1000 });
    for (const o of page.objects) out.push(o.key, await (await env.STATE.get(o.key))!.text());
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('public key of an application', () => {
  test('attach: only the public key is stored (source attached), and the API never says more than that', async () => {
    const id = appId('K');
    expect((await call('GET', `/api/folders/${id}/key`)).status).toBe(404);
    const pair = await generateKeyPair();
    const made = await ok('PUT', `/api/folders/${id}/key`, { publicKey: pair.publicHex.toLowerCase() });
    expect(made).toMatchObject({ publicKey: pair.publicHex, source: 'attached', createdBy: 'jane.doe@gocontroll.com', sealedPrivateKey: false });
    expect(await ok('GET', `/api/folders/${id}/key`)).toEqual(made);
    const stored = JSON.parse(await (await env.STATE.get(`keys/${id}.json`))!.text());
    expect(stored).toEqual({ app_id: id, public_key: pair.publicHex, source: 'attached', created_at: made.createdAt, created_by: made.createdBy });
    const log = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-key-attach.json`));
    expect(log.length).toBe(1);
    const text = await stateText();
    expect(text).not.toContain(pair.privateB64);
    expect(text).not.toContain(pair.privatePem.split('\n')[1]);
  });

  test('not a P-256 public key: 422 on publicKey; a private key in the body: 400, nothing stored or logged', async () => {
    const id = appId('K');
    for (const bad of ['04ABCD', `04${'11'.repeat(64)}`, fixtures.key.private_b64]) {
      const res = await call('PUT', `/api/folders/${id}/key`, { publicKey: bad });
      expect(res.status, bad).toBe(422);
      expect(res.body.field).toBe('publicKey');
    }
    const errors = vi.spyOn(console, 'error');
    const logs = vi.spyOn(console, 'log');
    const warns = vi.spyOn(console, 'warn');
    const pair = await generateKeyPair();
    const res = await call('PUT', `/api/folders/${id}/key`, { publicKey: pair.publicHex, privateKey: pair.privatePem });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('privateKey');
    expect(JSON.stringify(res.body)).not.toContain(pair.privateB64);
    expect(await env.STATE.head(`keys/${id}.json`)).toBeNull();
    for (const spy of [errors, logs, warns]) expect(JSON.stringify(spy.mock.calls)).not.toContain(pair.privatePem.split('\n')[1]);
    expect(await stateText()).not.toContain(pair.privatePem.split('\n')[1]);
  });

  test('generating or importing in the Worker is gone: POST is 410 and reads nothing', async () => {
    const id = appId('K');
    const res = await call('POST', `/api/folders/${id}/key`, { action: 'import', privateKey: fixtures.key.private_pem_pkcs8 });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/Key generator/);
    expect((await call('POST', `/api/folders/${id}/key`, { action: 'generate' })).status).toBe(410);
    expect(await env.STATE.head(`keys/${id}.json`)).toBeNull();
    expect(await stateText()).not.toContain(fixtures.key.private_pem_pkcs8.split('\n')[1]);
  });

  test('a key there already: 409 unless replace + confirm with the App ID; the old key is retired, not deleted', async () => {
    const id = appId('K');
    const first = await attachNewKey(id);
    const second = await generateKeyPair();
    expect((await call('PUT', `/api/folders/${id}/key`, { publicKey: second.publicHex })).status).toBe(409);
    expect((await call('PUT', `/api/folders/${id}/key`, { publicKey: second.publicHex, replace: true, confirm: 'WRONG' })).status).toBe(409);
    expect((await call('PUT', `/api/folders/${id}/key`, { publicKey: first.publicKey, replace: true, confirm: id })).status).toBe(422); // the same key
    const replaced = await ok('PUT', `/api/folders/${id}/key`, { publicKey: second.publicHex, replace: true, confirm: id });
    expect(replaced.publicKey).toBe(second.publicHex);
    const retired = await env.STATE.list({ prefix: `keys-retired/${id}/` });
    expect(retired.objects.length).toBe(1);
    expect(JSON.parse(await (await env.STATE.get(retired.objects[0].key))!.text()).public_key).toBe(first.publicKey);
    const logs = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.includes(`-${id}-key-`));
    expect(logs.map((o) => o.key.replace(/^.*-(key-[a-z]+)\.json$/, '$1')).sort()).toEqual(['key-attach', 'key-replace']);
  });

  test('a Linux application can hold a public key (for provisioning); a new App ID must be a valid S1 App ID', async () => {
    const id = `linux-app-${appId('L').toLowerCase()}-with-a-name-longer-than-32`;
    await putManifest(id, { app_id: id, latest_version: '1.0.0', versions: [] });
    const pair = await generateKeyPair();
    expect((await ok('PUT', `/api/folders/${id}/key`, { publicKey: pair.publicHex })).publicKey).toBe(pair.publicHex);
    expect((await ok('GET', `/api/folders/${id}`)).kind).toBe('linux');
    expect((await call('PUT', `/api/folders/${encodeURIComponent('a b')}/key`, { publicKey: pair.publicHex })).status).toBe(400);
    expect((await call('PUT', `/api/folders/${appId()}/key`, {})).status).toBe(400);
  });

  test('a key of before 0.7.0 (private key sealed in STATE) shows as such; its sealed part never leaves', async () => {
    const id = appId('O');
    const sealed = await sealScalar(unb64(fixtures.key.private_b64), TEST_KEK, id);
    await env.STATE.put(`keys/${id}.json`, JSON.stringify({
      app_id: id, public_key: fixtures.key.public_hex, sealed_private_key: sealed, source: 'generated', created_at: '2026-10-29T06:51:45.206Z', created_by: 'x@gocontroll.com',
    }));
    const key = await ok('GET', `/api/folders/${id}/key`);
    expect(key).toEqual({ publicKey: fixtures.key.public_hex, source: 'generated', createdAt: '2026-10-29T06:51:45.206Z', createdBy: 'x@gocontroll.com', sealedPrivateKey: true });
    for (const path of [`/api/folders/${id}`, '/api/overview']) expect(JSON.stringify((await ok('GET', path)))).not.toContain(sealed.split('.')[2]);
    expect((await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === id)).toMatchObject({ hasKey: true, publicKey: fixtures.key.public_hex });
  });
});

describe('POST /api/sign/scope', () => {
  test('the scope of a payload and of an unsigned container; payloadOffset where the payload starts', async () => {
    const id = appId('S');
    const { publicKey } = await attachNewKey(id);
    const res = await ok('POST', '/api/sign/scope', { appId: id, version: '1.2.3', payload: { size: 100, rawSize: 400, sha256: 'ab'.repeat(32) } });
    expect(res).toMatchObject({ appId: id, version: '1.2.3', publicKey, payloadOffset: 0 });
    const scope = unb64(res.scope);
    expect(scope.length).toBe(56 + 65); // the common body of 0x03 and the public key
    expect(toHex(scope.subarray(56)).toUpperCase()).toBe(publicKey);
    const container = await unsignedContainer(id, '2.0.0');
    const c = await ok('POST', '/api/sign/scope', { appId: id, version: '2.0.0', containerHeader: toBase64(container.subarray(0, 211)) });
    expect(c.payloadOffset).toBe(readHeader(container).headerSize);
  });

  test('refused: no public key, another App ID or version in the container, a signed container, a private key in the body', async () => {
    const payload = { size: 100, rawSize: 400, sha256: 'ab'.repeat(32) };
    expect((await call('POST', '/api/sign/scope', { appId: appId('S'), version: '1.0.0', payload })).status).toBe(422);
    const id = appId('S');
    await attachNewKey(id);
    const other = await unsignedContainer(appId(), '1.0.0');
    expect((await call('POST', '/api/sign/scope', { appId: id, version: '1.0.0', containerHeader: toBase64(other.subarray(0, 211)) })).status).toBe(422);
    const mine = await unsignedContainer(id, '1.0.0');
    expect((await call('POST', '/api/sign/scope', { appId: id, version: '1.0.1', containerHeader: toBase64(mine.subarray(0, 211)) })).body.field).toBe('version');
    // A container signed already (here with the application's own key) needs no scope.
    const signedId = appId('S');
    const own = await attachNewKey(signedId);
    const { payload: p, rawSize } = await zlibPayload();
    const header = await buildHeader({ appId: signedId, version: '1.0.0', payload: p, rawSize, signer: { privateKey: own.signer, publicKey: parsePublicKeyHex(own.publicKey) } });
    const signedAlready = await call('POST', '/api/sign/scope', { appId: signedId, version: '1.0.0', containerHeader: toBase64(header) });
    expect(signedAlready.status).toBe(422);
    expect(signedAlready.body.error).toMatch(/needs no signature/);
    const leaked = await call('POST', '/api/sign/scope', { appId: id, version: '1.0.0', payload, privateKey: fixtures.key.private_b64 });
    expect(leaked.status).toBe(400);
    expect(leaked.body.field).toBe('privateKey');
  });

  test('a Linux application gets no scope', async () => {
    const id = appId('L').toLowerCase();
    await putManifest(id, { app_id: id, latest_version: '1.0.0', versions: [] });
    await attachNewKey(id);
    expect((await call('POST', '/api/sign/scope', { appId: id, version: '1.0.0', payload: { size: 1, rawSize: 1, sha256: '00'.repeat(32) } })).status).toBe(422);
  });
});

describe('POST /api/sign', () => {
  test('a payload signed in the browser comes back as a signed container; nothing goes into the bucket', async () => {
    const id = appId('S');
    const { publicKey, signer } = await attachNewKey(id);
    const { payload, rawSize } = await zlibPayload();
    const signature = await browserSignature(id, '1.4.2', signer, { payload, rawSize });
    const writes: string[] = [];
    const bucket = spyBucket(env.DEPLOY_BUCKET, async (method, args) => { if (method === 'put' || method === 'delete') writes.push(String(args[0])); });
    const res = await upload('/api/sign', { appId: id, version: '1.4.2', payload, rawSize: String(rawSize), signature }, { DEPLOY_BUCKET: bucket });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.res.headers.get('content-disposition')).toBe(`attachment; filename="${id}-1.4.2.bin"`);
    const { header } = await parseContainer(res.bytes!);
    expect([header.headerVersion, header.appId, header.version, header.uncompressedSize]).toEqual([0x03, id, '1.4.2', rawSize]);
    expect(toHex(header.publicKey!).toUpperCase()).toBe(publicKey);
    expect(writes).toEqual([]);
    const logs = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-1.4.2.json`));
    expect(JSON.parse(await (await env.STATE.get(logs[0].key))!.text())).toMatchObject({ action: 'sign', app_id: id, version: '1.4.2', signed: true });
  });

  test('an unsigned container is re-wrapped around the same payload; wide App IDs get 0x05', async () => {
    const id = appId('S');
    const { publicKey, signer } = await attachNewKey(id);
    const container = await unsignedContainer(id, '2.0.0');
    const signature = await browserSignature(id, '2.0.0', signer, { container });
    const res = await upload('/api/sign', { appId: id, version: '2.0.0', container, signature });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const signed = await parseContainer(res.bytes!);
    expect(toHex(signed.payload)).toBe(toHex(container.subarray(readHeader(container).headerSize)));
    expect(toHex(signed.header.publicKey!).toUpperCase()).toBe(publicKey);

    const wide = `WIDE-${appId('S')}-APP`;
    const k = await attachNewKey(wide);
    const { payload, rawSize } = await zlibPayload();
    const sig = await browserSignature(wide, '0.1.0', k.signer, { payload, rawSize });
    expect(readHeader((await upload('/api/sign', { appId: wide, version: '0.1.0', payload, rawSize: String(rawSize), signature: sig })).bytes!).headerVersion).toBe(0x05);
  });

  test('a signature by another private key is refused (422 signature), and so is none', async () => {
    const id = appId('S');
    await attachNewKey(id);
    const stranger = await generateKeyPair();
    const otherSigner = await signerFor(stranger.privatePem, stranger.publicHex);
    const { payload, rawSize } = await zlibPayload();
    // The scope names this application's public key; a stranger's signature over it does not verify.
    const forged = await browserSignature(id, '1.0.0', otherSigner, { payload, rawSize });
    const res = await upload('/api/sign', { appId: id, version: '1.0.0', payload, rawSize: String(rawSize), signature: forged });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('signature');
    expect(res.body.error).toMatch(/not this application's/);
    expect((await upload('/api/sign', { appId: id, version: '1.0.0', payload, rawSize: String(rawSize) })).status).toBe(422);
    expect((await upload('/api/sign', { appId: id, version: '1.0.0', payload, rawSize: String(rawSize), signature: 'abc' })).status).toBe(400);
  });

  test('no public key: 404; a private key in the form: 400 and not logged', async () => {
    const { payload, rawSize } = await zlibPayload();
    expect((await upload('/api/sign', { appId: appId('S'), version: '1.0.0', payload, rawSize: String(rawSize) })).status).toBe(404);
    const id = appId('S');
    await attachNewKey(id);
    const errors = vi.spyOn(console, 'error');
    const res = await upload('/api/sign', { appId: id, version: '1.0.0', payload, rawSize: String(rawSize), privateKey: fixtures.key.private_b64 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('privateKey');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(fixtures.key.private_b64);
    expect(await stateText()).not.toContain(fixtures.key.private_b64);
  });

  test('a container signed with the application\'s key already comes back as it is, without a signature', async () => {
    const c = fixtures.cases[3]; // the 32-character App ID, signed by the fixture key
    await ok('PUT', `/api/folders/${c.app_id}/key`, { publicKey: fixtures.key.public_hex });
    const res = await upload('/api/sign', { appId: c.app_id, version: c.version, container: unb64(c.python_signed_b64) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(toHex(res.bytes!)).toBe(toHex(unb64(c.python_signed_b64)));
  });
});
