// Moving an S1 application to another distribution host (PUT /api/folders/:appId/distribution,
// src/distribution.ts; cloud-r2-distribution.md §2.1, step 2).

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { appId, call, controller, ok, putManifest, spyBucket, upload, zlibPayload } from './helpers';

const COM = 'https://deploy.gocontroll.com';
const TECH = 'https://deploy.gocontroll.tech';

const move = (id: string, distributionUrl: string, envOverrides: Record<string, unknown> = {}) =>
  call('PUT', `/api/folders/${id}/distribution`, { distributionUrl }, envOverrides);

async function manifestDoc(id: string) {
  return JSON.parse(await (await env.DEPLOY_BUCKET.get(`${id}/manifest.json`))!.text());
}

async function release(id: string, version: string) {
  const { payload, rawSize } = await zlibPayload(`image ${id} ${version} `.repeat(30));
  return upload('/api/releases', { appId: id, version, description: `Release ${version}`, replace: '0', payload, rawSize: String(rawSize) });
}

const logsOf = async (id: string) => (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-distribution.json`));

describe('PUT /api/folders/:appId/distribution', () => {
  test('moves every URL of the manifest to the new host; path, ?v= and other fields stay; the next release follows', async () => {
    const id = appId('H');
    const old = {
      application_id: id, latest: '0.0.2', note: { keep: 'me' },
      binaries: {
        '0.0.1': { url: `${COM}/${id}/${id}-0.0.1.bin`, release_date: '2026-01-01', description: 'One', extra: 1 },
        '0.0.2': { url: `${COM}/${id}/${id}-0.0.2.bin?v=0123456789abcdef`, release_date: '2026-02-01', description: 'Two' },
      },
    };
    await putManifest(id, old);
    await controller({ app_id: id, app_version: '0.0.2', distribution_url: COM });

    expect(await ok('PUT', `/api/folders/${id}/distribution`, { distributionUrl: `${TECH}/` })).toEqual({ appId: id, distributionUrl: TECH, previous: COM, moved: 2 });
    const doc = await manifestDoc(id);
    expect(doc).toEqual({
      ...old,
      binaries: {
        '0.0.1': { ...old.binaries['0.0.1'], url: `${TECH}/${id}/${id}-0.0.1.bin` },
        '0.0.2': { ...old.binaries['0.0.2'], url: `${TECH}/${id}/${id}-0.0.2.bin?v=0123456789abcdef` },
      },
    });

    // The way back is in the log.
    const log = await logsOf(id);
    expect(log.length).toBe(1);
    const entry = JSON.parse(await (await env.STATE.get(log[0].key))!.text());
    expect(entry).toMatchObject({ action: 'distribution', actor: 'jane.doe@gocontroll.com', from: COM, to: TECH, moved: 2, previous_manifest: old });

    const detail = await ok('GET', `/api/folders/${id}`);
    expect(detail).toMatchObject({ distributionUrl: TECH, mixedHosts: false, distributionUrls: [TECH, COM] });
    expect(detail.controllers.hosts).toEqual([{ url: COM, count: 1 }]);

    const next = await release(id, '0.0.3');
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.binaryUrl.startsWith(`${TECH}/${id}/`)).toBe(true);

    // Moving back works the same way.
    expect((await ok('PUT', `/api/folders/${id}/distribution`, { distributionUrl: COM })).moved).toBe(3);
    expect(Object.values((await manifestDoc(id)).binaries).every((b: any) => b.url.startsWith(`${COM}/`))).toBe(true);
  });

  test('a manifest with two hosts ends up on one', async () => {
    const id = appId('H');
    await putManifest(id, {
      application_id: id, latest: '1.0.1',
      binaries: {
        '1.0.0': { url: `${TECH}/${id}/${id}-1.0.0.bin`, release_date: '', description: '' },
        '1.0.1': { url: `${COM}/${id}/${id}-1.0.1.bin`, release_date: '', description: '' },
      },
    });
    expect((await ok('GET', `/api/folders/${id}`)).mixedHosts).toBe(true);
    expect((await ok('PUT', `/api/folders/${id}/distribution`, { distributionUrl: TECH })).moved).toBe(1);
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({ distributionUrl: TECH, mixedHosts: false });
  });

  test('refused: the host it is on, a host outside DISTRIBUTION_URLS, a URL outside the bucket, a Linux folder; nothing written', async () => {
    const id = appId('H');
    await putManifest(id, { application_id: id, latest: '1.0.0', binaries: { '1.0.0': { url: `${TECH}/${id}/${id}-1.0.0.bin`, release_date: '', description: '' } } });
    const same = await move(id, TECH);
    expect([same.status, same.body.field]).toEqual([422, 'distributionUrl']);
    const evil = await move(id, 'https://evil.example');
    expect([evil.status, evil.body.field]).toEqual([422, 'distributionUrl']);

    const outside = appId('H');
    const foreign = { application_id: outside, latest: '1.0.0', binaries: { '1.0.0': { url: `https://elsewhere.example/${outside}/a.bin`, release_date: '', description: '' } } };
    await putManifest(outside, foreign);
    expect((await move(outside, TECH)).status).toBe(422);
    expect(await manifestDoc(outside)).toEqual(foreign);

    const linux = appId('L');
    await ok('POST', '/api/folders', { appId: linux.toLowerCase(), customerId: null, controller: 'M1' }, 201);
    expect((await move(linux.toLowerCase(), TECH)).status).toBe(422);

    expect((await move(appId('X'), TECH)).status).toBe(404);
    expect(await logsOf(id)).toEqual([]);
  });

  test('a folder without releases: the host its first release takes', async () => {
    const id = appId('H');
    await ok('POST', '/api/folders', { appId: id, customerId: null, controller: 'S1', distributionUrl: COM }, 201);
    expect(await ok('PUT', `/api/folders/${id}/distribution`, { distributionUrl: TECH })).toEqual({ appId: id, distributionUrl: TECH, previous: COM, moved: 0 });
    expect((await ok('GET', `/api/folders/${id}`)).distributionUrl).toBe(TECH);
    const first = await release(id, '1.0.0');
    expect(first.body.binaryUrl.startsWith(`${TECH}/${id}/`)).toBe(true);
  });

  test('someone else writing the manifest meanwhile: 409, their manifest stays', async () => {
    const id = appId('H');
    await putManifest(id, { application_id: id, latest: '1.0.0', binaries: { '1.0.0': { url: `${COM}/${id}/${id}-1.0.0.bin`, release_date: '', description: '' } } });
    const theirs = { application_id: id, latest: '9.9.9', binaries: {} };
    const racing = spyBucket(env.DEPLOY_BUCKET, async (method, args, target) => {
      if (method === 'put' && String(args[0]).endsWith('/manifest.json')) await target.put(args[0], JSON.stringify(theirs));
    });
    expect((await move(id, TECH, { DEPLOY_BUCKET: racing })).status).toBe(409);
    expect(await manifestDoc(id)).toEqual(theirs);
  });
});
