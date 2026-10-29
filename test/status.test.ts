// The status pages: GET /api/overview, GET /api/folders/:appId, the customer of a folder.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { appId, attachNewKey, browserSignature, call, controller, customer, ok, project, putManifest, unsignedContainer, upload, zlibPayload } from './helpers';

/** Publish a release; with `signer`, signed in the browser's way (the key attached to `id`). */
async function publish(id: string, version: string, extra: Record<string, string> = {}, signer?: CryptoKey) {
  const { payload, rawSize } = await zlibPayload(`${id} ${version} `.repeat(20));
  const signature: Record<string, string> = signer ? { signature: await browserSignature(id, version, signer, { payload, rawSize }) } : {};
  const res = await upload('/api/releases', { appId: id, version, description: `Release ${version}`, payload, rawSize: String(rawSize), ...signature, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe('GET /api/overview', () => {
  test('folders with kind, latest, releases, bytes, key, customer and controllers; totals', async () => {
    const s1 = appId('O');
    const linux = appId('L');
    const keyOnly = appId('K');
    const acme = await customer(`Acme ${s1}`);
    await publish(s1, '1.0.0');
    await publish(s1, '1.1.0');
    await putManifest(linux, { app_id: linux, latest_version: '2.0.0', versions: [{ version: '2.0.0', released: '2026-05-05', description: 'Linux', tarball: 'v2.0.0/update.tar.gz', manifest: 'v2.0.0/manifest.json', size_bytes: 10, sha256: 'ab' }] });
    await env.DEPLOY_BUCKET.put(`${linux}/v2.0.0/update.tar.gz`, 'tarball!!!');
    const keyOnlyKey = await attachNewKey(keyOnly);
    await controller({ app_id: s1, app_version: '1.1.0', client_id: acme, online: 1 });
    await controller({ app_id: s1, app_version: '1.0.0', client_id: acme, online: 0 });
    await controller({ app_id: ` ${s1} `, app_version: '1.1.0', client_id: null, online: 1 });

    const body = await ok('GET', '/api/overview');
    const f = body.folders.find((x: any) => x.appId === s1);
    expect(f).toMatchObject({
      appId: s1, kind: 's1', latest: '1.1.0', releases: 2, distributionUrl: 'https://deploy.gocontroll.tech', hasKey: false,
      customer: { id: acme, name: `Acme ${s1}`, source: 'controllers' },
      controllers: { total: 3, online: 2, upToDate: 2 },
    });
    expect(f.bytes).toBeGreaterThan(0);
    expect(Date.parse(f.lastUpload)).toBeGreaterThan(Date.now() - 60_000);

    expect(body.folders.find((x: any) => x.appId === linux)).toMatchObject({ kind: 'linux', latest: '2.0.0', releases: 1, distributionUrl: null, hasKey: false });
    expect(body.folders.find((x: any) => x.appId === keyOnly)).toMatchObject({ kind: 's1', controller: null, controllerSource: null, latest: null, releases: 0, bytes: 0, lastUpload: null, hasKey: true, publicKey: keyOnlyKey.publicKey, inBucket: false });

    expect(body.customers).toContainEqual({ id: acme, name: `Acme ${s1}`, folders: [s1] });
    const names = body.customers.map((c: any) => c.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(body.totals.folders).toBe(body.folders.length);
    expect(body.totals.s1Folders).toBe(body.folders.filter((x: any) => x.kind === 's1').length);
    expect(body.totals.linuxFolders).toBe(body.folders.filter((x: any) => x.kind === 'linux').length);
    expect(body.totals.releases).toBe(body.folders.reduce((n: number, x: any) => n + x.releases, 0));
    expect(body.totals.controllers).toBe(body.folders.reduce((n: number, x: any) => n + x.controllers.total, 0));
    expect(body.downloads).toEqual({ configured: false, last7: null, last30: null });
    expect(body.distributionUrls).toEqual(['https://deploy.gocontroll.tech', 'https://deploy.gocontroll.com']);
  });

  test('customer: manual wins over controllers, controllers over project', async () => {
    const id = appId('C');
    const viaProject = await customer(`Project customer ${id}`);
    const viaControllers = await customer(`Controller customer ${id}`);
    const manual = await customer(`Manual customer ${id}`);
    await publish(id, '1.0.0');
    const p = await project(viaProject);
    await env.MODULINE_DB.prepare('INSERT INTO project_provisioning (project_id, app_id) VALUES (?1, ?2)').bind(p, id).run();
    const folder = async () => (await ok('GET', '/api/overview')).folders.find((x: any) => x.appId === id).customer;
    expect(await folder()).toEqual({ id: viaProject, name: `Project customer ${id}`, source: 'project' });

    await controller({ app_id: id, app_version: '1.0.0', client_id: viaControllers });
    expect(await folder()).toMatchObject({ id: viaControllers, source: 'controllers' });

    const put = await ok('PUT', `/api/folders/${id}/customer`, { customerId: manual });
    expect(put).toEqual({ customer: { id: manual, name: `Manual customer ${id}`, source: 'manual' } });
    expect(await folder()).toMatchObject({ id: manual, source: 'manual' });
    expect((await ok('GET', `/api/folders/${id}`)).customer).toMatchObject({ id: manual, source: 'manual' });

    const cleared = await ok('PUT', `/api/folders/${id}/customer`, { customerId: null });
    expect(cleared.customer).toMatchObject({ id: viaControllers, source: 'controllers' });
  });

  test('assigning: unknown customer 422, unknown folder 404, bad body 400', async () => {
    const id = appId('C');
    await publish(id, '1.0.0');
    expect((await call('PUT', `/api/folders/${id}/customer`, { customerId: 999999 })).status).toBe(422);
    expect((await call('PUT', `/api/folders/${appId('N')}/customer`, { customerId: null })).status).toBe(404);
    expect((await call('PUT', `/api/folders/${id}/customer`, { customerId: 'x' })).status).toBe(400);
  });

  test('GET /api/customers lists the business customers by name', async () => {
    const id = await customer('Aardvark first BV');
    const list = await ok('GET', '/api/customers');
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContainEqual({ id, name: 'Aardvark first BV' });
  });
});

describe('GET /api/folders/:appId', () => {
  test('releases with header (range read), digest and key checks; controllers per version; other objects', async () => {
    const id = appId('F');
    const key = await attachNewKey(id);
    await publish(id, '1.0.0', {}, key.signer);
    await publish(id, '1.1.0', {}, key.signer);
    await env.DEPLOY_BUCKET.put(`${id}/notes.txt`, 'left over');
    await controller({ app_id: id, app_version: '1.1.0', online: 1, distribution_url: 'https://deploy.gocontroll.tech' });
    await controller({ app_id: id, app_version: '1.0.0', online: 0, distribution_url: 'https://deploy.gocontroll.tech' });

    const body = await ok('GET', `/api/folders/${encodeURIComponent(id)}`);
    expect(body).toMatchObject({
      appId: id, kind: 's1', latest: '1.1.0', distributionUrl: 'https://deploy.gocontroll.tech', mixedHosts: false,
      key: { publicKey: key.publicKey, source: 'attached', createdBy: 'jane.doe@gocontroll.com', sealedPrivateKey: false },
      customer: null,
      controllers: { total: 2, online: 1, upToDate: 1, versions: [{ version: '1.1.0', count: 1 }, { version: '1.0.0', count: 1 }] },
      linuxVersions: [],
      otherObjects: [{ key: `${id}/notes.txt`, size: 9 }],
      downloads: { configured: false, days: [] },
    });
    expect(body.releases.map((r: any) => r.version)).toEqual(['1.1.0', '1.0.0']);
    const r = body.releases[0];
    expect(r).toMatchObject({
      objectKey: `${id}/${id}-1.1.0.bin`, description: 'Release 1.1.0', headerError: null, keyMatches: true, digestMatches: true, downloads: null,
      header: { headerVersion: 0x03, signed: true, appId: id, version: '1.1.0', publicKey: key.publicKey },
    });
    expect(r.size).toBe(r.header.compressedSize + 187);
    expect(r.header.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.url).toBe(`https://deploy.gocontroll.tech/${id}/${id}-1.1.0.bin?v=${r.header.sha256.slice(0, 16)}`);
  });

  test('a manifest that names a missing binary, a stale digest, mixed hosts, an unsigned release under a key', async () => {
    const id = appId('F');
    const container = await unsignedContainer(id, '1.0.0');
    await env.DEPLOY_BUCKET.put(`${id}/${id}-1.0.0.bin`, container);
    await putManifest(id, {
      application_id: id, latest: '1.0.0',
      binaries: {
        '1.0.0': { url: `https://deploy.gocontroll.com/${id}/${id}-1.0.0.bin?v=0000000000000000`, release_date: '2026-01-01', description: 'Stale' },
        '0.9.0': { url: `https://deploy.gocontroll.tech/${id}/${id}-0.9.0.bin`, release_date: '2025-12-01', description: 'Gone' },
        '0.8.0': { url: `https://elsewhere.example/${id}/x.bin`, release_date: '2025-11-01', description: 'Outside' },
      },
    });
    await attachNewKey(id);
    const body = await ok('GET', `/api/folders/${id}`);
    expect(body.mixedHosts).toBe(true);
    expect(body.distributionUrl).toBe('https://deploy.gocontroll.com');
    const [stale, gone, outside] = body.releases;
    expect(stale).toMatchObject({ version: '1.0.0', digestMatches: false, keyMatches: false, headerError: null, header: { signed: false } });
    expect(gone).toMatchObject({ version: '0.9.0', header: null, headerError: 'The binary is not in the bucket.', digestMatches: null, size: null });
    expect(outside).toMatchObject({ version: '0.8.0', objectKey: null, header: null });
  });

  test('a Linux folder: its versions, tarballs not counted as other objects', async () => {
    const id = appId('L');
    await putManifest(id, { app_id: id, latest_version: '1.0.1', versions: [{ version: '1.0.1', released: '2026-05-05', description: 'Test green', tarball: 'v1.0.1/update.tar.gz', manifest: 'v1.0.1/manifest.json', size_bytes: 117802, sha256: '1f74' }] });
    await env.DEPLOY_BUCKET.put(`${id}/v1.0.1/update.tar.gz`, 'x');
    await env.DEPLOY_BUCKET.put(`${id}/v1.0.1/manifest.json`, '{}');
    const body = await ok('GET', `/api/folders/${id}`);
    expect(body).toMatchObject({ kind: 'linux', latest: '1.0.1', releases: [], otherObjects: [], key: null });
    expect(body.linuxVersions).toEqual([{ version: '1.0.1', released: '2026-05-05', description: 'Test green', sizeBytes: 117802, sha256: '1f74' }]);
  });

  test('a folder that does not exist is 404', async () => {
    expect((await call('GET', `/api/folders/${appId('N')}`)).status).toBe(404);
    expect((await call('GET', `/api/folders/${encodeURIComponent(' lead')}`)).status).toBe(404);
  });
});
