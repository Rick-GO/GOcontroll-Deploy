// Change set v2: new applications (POST /api/folders), folder settings (customer, controller),
// the controller type, the keys list, and the protected folder delete.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { resolveController } from '../src/status';
import { appId, call, controller, customer, ok, putManifest, spyBucket, upload, zlibPayload } from './helpers';

async function publish(id: string, version: string, extra: Record<string, string> = {}, envOverrides: Record<string, unknown> = {}) {
  const { payload, rawSize } = await zlibPayload(`${id} ${version} `.repeat(20));
  return upload('/api/releases', { appId: id, version, description: `Release ${version}`, payload, rawSize: String(rawSize), ...extra }, envOverrides);
}

const logsOf = async (id: string, action: string) => (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-${action}.json`));

describe('POST /api/folders', () => {
  test('creates settings only; the folder shows on the overview and its page, and its first release takes the chosen host', async () => {
    const id = appId('N');
    const cu = await customer(`New app customer ${id}`);
    expect(await ok('POST', '/api/folders', { appId: id, customerId: cu, controller: 'S1', distributionUrl: 'https://deploy.gocontroll.com' }, 201)).toEqual({ appId: id });
    expect((await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects).toEqual([]);
    const settings = JSON.parse(await (await env.STATE.get(`folders/${id}.json`))!.text());
    expect(settings).toMatchObject({ customer_id: cu, controller: 'S1', distribution_url: 'https://deploy.gocontroll.com', created_by: 'jane.doe@gocontroll.com' });
    expect(settings.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const overview = await ok('GET', '/api/overview');
    expect(overview.folders.find((f: any) => f.appId === id)).toMatchObject({
      kind: 's1', controller: 'S1', controllerSource: 'manual', latest: null, releases: 0, inBucket: false, hasKey: false,
      distributionUrl: 'https://deploy.gocontroll.com', customer: { id: cu, source: 'manual' },
    });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({
      appId: id, kind: 's1', controller: 'S1', controllerSource: 'manual', releases: [], key: null,
      distributionUrl: 'https://deploy.gocontroll.com', objects: { count: 0, bytes: 0 }, deleting: null,
    });

    // No distributionUrl field: the settings' host; a different one is ignored like for any existing folder.
    const first = await publish(id, '1.0.0', { distributionUrl: 'https://deploy.gocontroll.tech' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.binaryUrl.startsWith(`https://deploy.gocontroll.com/${id}/`)).toBe(true);
    expect((await logsOf(id, 'create-folder')).length).toBe(1);
  });

  test('the first DISTRIBUTION_URL is the default; one outside them is refused', async () => {
    const id = appId('N');
    await ok('POST', '/api/folders', { appId: id, customerId: null, controller: 'S1' }, 201);
    expect((await ok('GET', `/api/folders/${id}`)).distributionUrl).toBe('https://deploy.gocontroll.tech');
    const bad = await call('POST', '/api/folders', { appId: appId('N'), customerId: null, controller: 'S1', distributionUrl: 'https://evil.example' });
    expect([bad.status, bad.body.field]).toEqual([422, 'distributionUrl']);
  });

  test('409 when the App ID exists: objects in the bucket, a key, or settings', async () => {
    const inBucket = appId('E');
    expect((await publish(inBucket, '1.0.0')).status).toBe(200);
    const keyOnly = appId('E');
    await ok('POST', `/api/folders/${keyOnly}/key`, { action: 'generate' });
    const settingsOnly = appId('E');
    await ok('POST', '/api/folders', { appId: settingsOnly, customerId: null, controller: 'S1' }, 201);
    for (const id of [inBucket, keyOnly, settingsOnly]) {
      const res = await call('POST', '/api/folders', { appId: id, customerId: null, controller: 'S1' });
      expect([res.status, res.body.field, res.body.appId], id).toEqual([409, 'appId', id]);
    }
  });

  test('only S1; App ID rules as for publishing; the customer must exist', async () => {
    const lin = await call('POST', '/api/folders', { appId: appId('N'), customerId: null, controller: 'L4' });
    expect([lin.status, lin.body.error]).toEqual([422, 'Releases for Linux controllers are not published here.']);
    expect((await call('POST', '/api/folders', { appId: appId('N'), customerId: null, controller: 'X1' })).status).toBe(400);
    for (const bad of ['', 'has space', 'a/b', 'X'.repeat(33)]) {
      const res = await call('POST', '/api/folders', { appId: bad, customerId: null, controller: 'S1' });
      expect([res.status, res.body.field], bad).toEqual([400, 'appId']);
    }
    const ghost = await call('POST', '/api/folders', { appId: appId('N'), customerId: 999999, controller: 'S1' });
    expect([ghost.status, ghost.body.field]).toEqual([422, 'customerId']);
  });
});

describe('PUT /api/folders/:appId/settings', () => {
  test('customer and controller by hand; absent fields stay; null goes back to the derived value', async () => {
    const id = appId('S');
    expect((await publish(id, '1.0.0')).status).toBe(200);
    const cu = await customer(`Settings customer ${id}`);
    expect(await ok('PUT', `/api/folders/${id}/settings`, { customerId: cu })).toEqual({
      customer: { id: cu, name: `Settings customer ${id}`, source: 'manual' }, controller: 'S1', controllerSource: 'manifest',
    });
    const l4 = await ok('PUT', `/api/folders/${id}/settings`, { controller: 'L4' });
    expect(l4).toMatchObject({ customer: { id: cu, source: 'manual' }, controller: 'L4', controllerSource: 'manual' });
    expect((await ok('GET', `/api/folders/${id}`))).toMatchObject({ controller: 'L4', controllerSource: 'manual', customer: { id: cu } });
    const back = await ok('PUT', `/api/folders/${id}/settings`, { controller: null, customerId: null });
    expect(back).toEqual({ customer: null, controller: 'S1', controllerSource: 'manifest' });
    expect((await logsOf(id, 'settings')).length).toBe(3);
  });

  test('a folder set to a Linux controller gets no S1 release; unknown folder 404; bad values 400', async () => {
    const id = appId('S');
    await ok('POST', '/api/folders', { appId: id, customerId: null, controller: 'S1' }, 201);
    await ok('PUT', `/api/folders/${id}/settings`, { controller: 'M1' });
    expect((await publish(id, '1.0.0')).status).toBe(422);
    expect((await call('PUT', `/api/folders/${appId('N')}/settings`, { controller: 'S1' })).status).toBe(404);
    expect((await call('PUT', `/api/folders/${id}/settings`, { controller: 'S2' })).status).toBe(400);
    expect((await call('PUT', `/api/folders/${id}/settings`, { customerId: 'x' })).status).toBe(400);
  });

  test('settings written without the index (milestone 1, or put back by hand) are read from the object', async () => {
    const id = appId('S');
    expect((await publish(id, '1.0.0')).status).toBe(200);
    const cu = await customer(`Hand-put customer ${id}`);
    await env.STATE.put(`folders/${id}.json`, JSON.stringify({ customer_id: cu, controller: 'HMI1', updated_at: 'x', updated_by: 'y' }));
    expect((await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === id)).toMatchObject({
      customer: { id: cu, source: 'manual' }, controller: 'HMI1', controllerSource: 'manual',
    });
  });

  test('PUT …/customer still works and keeps the controller', async () => {
    const id = appId('S');
    await ok('POST', '/api/folders', { appId: id, customerId: null, controller: 'S1' }, 201);
    const cu = await customer(`Alias customer ${id}`);
    expect(await ok('PUT', `/api/folders/${id}/customer`, { customerId: cu })).toEqual({ customer: { id: cu, name: `Alias customer ${id}`, source: 'manual' } });
    expect((await ok('GET', `/api/folders/${id}`)).controller).toBe('S1');
  });
});

describe('controller type', () => {
  const g = (type: string | null, total = 1) => ({ app_id: 'X', app_version: null, client_id: null, distribution_url: null, controller_type: type, total, online: 0, up_to_date: 0, last_online: null });

  test('manual → S1 manifest → most common controller type (prefix "Moduline " off; ties alphabetical) → null', () => {
    expect(resolveController('s1', 'M1', [g('Moduline L4', 5)])).toEqual({ controller: 'M1', controllerSource: 'manual' });
    expect(resolveController('s1', null, [g('Moduline L4', 5)])).toEqual({ controller: 'S1', controllerSource: 'manifest' });
    expect(resolveController('unknown', null, [g('Moduline M2', 2), g('Moduline HMI1', 1)])).toEqual({ controller: 'M2', controllerSource: 'controllers' });
    expect(resolveController('unknown', null, [g('Moduline L4', 1), g('Moduline HMI1', 1)])).toEqual({ controller: 'HMI1', controllerSource: 'controllers' });
    expect(resolveController('unknown', null, [g(null, 3)])).toEqual({ controller: null, controllerSource: null });
    // A Linux manifest leaves the S1 rows out: one App ID can have both.
    expect(resolveController('linux', null, [g('Moduline S1', 3), g('Moduline L4', 1)])).toEqual({ controller: 'L4', controllerSource: 'controllers' });
    expect(resolveController('linux', null, [g('Moduline S1', 3)])).toEqual({ controller: null, controllerSource: null });
  });

  test('from gocontroll-db: controllers.controller_series_id → controller_series.controller_type', async () => {
    const id = appId('L');
    await putManifest(id, { app_id: id, latest_version: '1.0.0', versions: [] });
    await controller({ app_id: id, type: 'Moduline L4' });
    await controller({ app_id: id, type: 'Moduline S1' });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({ kind: 'linux', controller: 'L4', controllerSource: 'controllers' });
    const loose = appId('U');
    await env.DEPLOY_BUCKET.put(`${loose}/readme.txt`, 'x');
    await controller({ app_id: loose, type: 'Moduline M1' });
    const row = (await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === loose);
    expect(row).toMatchObject({ kind: 'unknown', controller: 'M1', controllerSource: 'controllers' });
  });
});

describe('GET /api/keys', () => {
  test('every key with customer, controller and whether the bucket holds the folder; S1 folders without a key', async () => {
    const keyed = appId('K');
    const cu = await customer(`Keys customer ${keyed}`);
    await ok('POST', '/api/folders', { appId: keyed, customerId: cu, controller: 'S1' }, 201);
    const key = await ok('POST', `/api/folders/${keyed}/key`, { action: 'generate' });
    const published = appId('W');
    expect((await publish(published, '1.0.0')).status).toBe(200);
    const created = appId('W');
    await ok('POST', '/api/folders', { appId: created, customerId: null, controller: 'S1' }, 201);
    const linux = appId('L');
    await putManifest(linux, { app_id: linux, latest_version: '1.0.0', versions: [] });

    const body = await ok('GET', '/api/keys');
    expect(body.keys.find((k: any) => k.appId === keyed)).toEqual({
      appId: keyed, publicKey: key.publicKey, source: 'generated', createdAt: key.createdAt, createdBy: 'jane.doe@gocontroll.com',
      inBucket: false, customer: { id: cu, name: `Keys customer ${keyed}`, source: 'manual' }, controller: 'S1',
    });
    expect(body.keys.some((k: any) => 'sealed_private_key' in k || 'sealedPrivateKey' in k)).toBe(false);
    const without = body.withoutKey.map((w: any) => w.appId);
    expect(without).toContain(published);
    expect(without).toContain(created);
    expect(without).not.toContain(keyed);
    expect(without).not.toContain(linux);
    expect(body.withoutKey.find((w: any) => w.appId === published)).toEqual({ appId: published, customer: null, controller: 'S1' });
  });
});

describe('DELETE /api/folders/:appId', () => {
  const del = (id: string, body: unknown, envOverrides: Record<string, unknown> = {}) => call('DELETE', `/api/folders/${id}`, body, envOverrides);
  const ok200 = { reason: 'Customer ended the project', acknowledgeControllers: false };

  test('refused without the exact App ID, without a reason, or without acknowledging the controllers', async () => {
    const id = appId('D');
    expect((await publish(id, '1.0.0')).status).toBe(200);
    const wrong = await del(id, { ...ok200, confirm: id.toLowerCase() });
    expect([wrong.status, wrong.body.field]).toEqual([400, 'confirm']);
    const short = await del(id, { confirm: id, reason: 'too short' });
    expect([short.status, short.body.field]).toEqual([400, 'reason']);
    await controller({ app_id: id, type: 'Moduline S1' });
    await controller({ app_id: id, type: 'Moduline S1' });
    const unacked = await del(id, { ...ok200, confirm: id });
    expect(unacked.status).toBe(409);
    expect(unacked.body).toMatchObject({ controllers: 2, field: 'acknowledgeControllers' });
    expect((await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects.length).toBe(2);
    expect((await del(appId('N'), { ...ok200, confirm: 'x' })).status).toBe(400);
    const nothing = appId('N');
    expect((await del(nothing, { ...ok200, confirm: nothing })).status).toBe(404);
  });

  test('archives every object (bytes and metadata) and the settings, deletes them, keeps the key, logs it', async () => {
    const id = appId('D');
    const cu = await customer(`Delete customer ${id}`);
    await ok('POST', '/api/folders', { appId: id, customerId: cu, controller: 'S1' }, 201);
    const key = await ok('POST', `/api/folders/${id}/key`, { action: 'generate' });
    expect((await publish(id, '1.0.0', { sign: '1' })).status).toBe(200);
    expect((await publish(id, '1.1.0', { sign: '1' })).status).toBe(200);
    await env.DEPLOY_BUCKET.put(`${id}/notes.txt`, 'left over', { httpMetadata: { contentType: 'text/plain' } });
    const before = new Map<string, { bytes: string; type?: string }>();
    for (const o of (await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects) {
      const got = (await env.DEPLOY_BUCKET.get(o.key))!;
      before.set(o.key, { bytes: btoa(String.fromCharCode(...new Uint8Array(await got.arrayBuffer()))), type: got.httpMetadata?.contentType });
    }
    await controller({ app_id: id, type: 'Moduline S1' });

    const res = await del(id, { confirm: id, reason: 'Replaced by a new application', acknowledgeControllers: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ done: true, deleted: 4, remaining: 0 });
    expect(res.body.archive).toMatch(new RegExp(`^deleted/${id}/\\d{4}-\\d{2}-\\d{2}T[^/]+/$`));

    expect((await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects).toEqual([]);
    for (const [k, v] of before) {
      const copy = await env.STATE.get(`${res.body.archive}${k}`);
      expect(copy, k).not.toBeNull();
      expect(btoa(String.fromCharCode(...new Uint8Array(await copy!.arrayBuffer()))), k).toBe(v.bytes);
      expect(copy!.httpMetadata?.contentType, k).toBe(v.type);
    }
    const archivedSettings = JSON.parse(await (await env.STATE.get(`${res.body.archive}folder-settings.json`))!.text());
    expect(archivedSettings).toMatchObject({ customer_id: cu, controller: 'S1' });
    expect(await env.STATE.head(`folders/${id}.json`)).toBeNull();
    expect(await env.STATE.head(`deleting/${id}.json`)).toBeNull();
    // The key stays: controllers in the field carry its public key.
    expect((await ok('GET', `/api/folders/${id}/key`)).publicKey).toBe(key.publicKey);

    const [log] = await logsOf(id, 'delete-folder');
    expect(JSON.parse(await (await env.STATE.get(log.key))!.text())).toMatchObject({
      action: 'delete-folder', actor: 'jane.doe@gocontroll.com', reason: 'Replaced by a new application', objects: 4, controllers: 1,
      archive: res.body.archive,
    });
  });

  test('the manifest is archived and deleted before any binary', async () => {
    const id = appId('D');
    expect((await publish(id, '1.0.0')).status).toBe(200);
    expect((await publish(id, '1.0.1')).status).toBe(200);
    const calls: string[] = [];
    const bucket = spyBucket(env.DEPLOY_BUCKET, async (method, args) => {
      if (method === 'get') calls.push(`get ${args[0]}`);
      if (method === 'delete') calls.push(`delete ${[args[0]].flat().join(',')}`);
    });
    expect((await del(id, { ...ok200, confirm: id }, { DEPLOY_BUCKET: bucket })).body.done).toBe(true);
    const firstDelete = calls.findIndex((c) => c.startsWith('delete'));
    expect(calls[firstDelete]).toBe(`delete ${id}/manifest.json`);
    expect(calls.slice(0, firstDelete).some((c) => c.includes('.bin'))).toBe(false);
    expect(calls.filter((c) => c.startsWith('delete')).length).toBe(2); // the manifest alone, then the binaries
  });

  test('at most 200 per call; repeating continues in the same archive, also after a failure', async () => {
    const id = appId('D');
    expect((await publish(id, '1.0.0')).status).toBe(200);
    const extra = Array.from({ length: 204 }, (_, i) => `${id}/v1.0.${i}/update.tar.gz`);
    for (const k of extra) await env.DEPLOY_BUCKET.put(k, `tarball ${k}`);
    const body = { ...ok200, confirm: id };

    // A run that fails on its second delete call: what was archived and deleted stays so.
    let deletes = 0;
    const flaky = spyBucket(env.DEPLOY_BUCKET, async (method) => {
      if (method === 'delete' && ++deletes === 2) throw new Error('R2 hiccup');
    });
    expect((await del(id, body, { DEPLOY_BUCKET: flaky })).status).toBe(500);
    const record = JSON.parse(await (await env.STATE.get(`deleting/${id}.json`))!.text());
    expect(record).toMatchObject({ actor: 'jane.doe@gocontroll.com', reason: ok200.reason });
    expect(await env.DEPLOY_BUCKET.head(`${id}/manifest.json`)).toBeNull();
    expect((await ok('GET', `/api/folders/${id}`)).deleting).toMatchObject({ startedAt: record.started_at });
    // Nothing new goes into a folder being deleted.
    expect((await publish(id, '2.0.0')).status).toBe(409);

    const first = await ok('DELETE', `/api/folders/${id}`, body);
    expect(first).toMatchObject({ done: false, deleted: 200, archive: `deleted/${id}/${record.started_at}/` });
    expect(first.remaining).toBeGreaterThan(0);
    const second = await ok('DELETE', `/api/folders/${id}`, body);
    expect(second).toMatchObject({ done: true, remaining: 0, archive: first.archive });
    expect((await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects).toEqual([]);
    const archived = await env.STATE.list({ prefix: first.archive, limit: 1000 });
    expect(archived.objects.length).toBe(206); // manifest + binary + 204 tarballs
    const [log] = await logsOf(id, 'delete-folder');
    expect(JSON.parse(await (await env.STATE.get(log.key))!.text()).objects).toBe(206);
  });

  test('a Linux folder can be deleted too (any kind)', async () => {
    const id = appId('L');
    await putManifest(id, { app_id: id, latest_version: '1.0.0', versions: [{ version: '1.0.0', tarball: 'v1.0.0/update.tar.gz' }] });
    await env.DEPLOY_BUCKET.put(`${id}/v1.0.0/update.tar.gz`, 'tar');
    expect(await ok('DELETE', `/api/folders/${id}`, { ...ok200, confirm: id })).toMatchObject({ done: true, deleted: 2 });
  });
});
