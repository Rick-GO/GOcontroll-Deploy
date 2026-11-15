// Which versions of an S1 application may be installed (src/policy.ts; cloud-r2-distribution.md §3,
// "Which versions can be installed"): PUT /api/folders/:appId/min-version ("Earlier versions") and
// PUT /api/folders/:appId/releases/:version/withdrawn (Withdraw / Restore), and what the page reads.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { appId, call, ok, putManifest, spyBucket } from './helpers';

const TECH = 'https://deploy.gocontroll.tech';

/** A manifest with three releases, a field Deploy does not know, and an entry field it does not know. */
function threeReleases(id: string, extra: Record<string, unknown> = {}) {
  return {
    application_id: id, latest: '0.0.10', note: { keep: 'me' }, ...extra,
    binaries: {
      '0.0.8': { url: `${TECH}/${id}/${id}-0.0.8.bin?v=0000000000000008`, release_date: '2026-01-08', description: 'Eight', extra: 1 },
      '0.0.9': { url: `${TECH}/${id}/${id}-0.0.9.bin?v=0000000000000009`, release_date: '2026-01-09', description: 'Nine' },
      '0.0.10': { url: `${TECH}/${id}/${id}-0.0.10.bin?v=0000000000000010`, release_date: '2026-01-10', description: 'Ten' },
    },
  };
}

async function manifestDoc(id: string) {
  return JSON.parse(await (await env.DEPLOY_BUCKET.get(`${id}/manifest.json`))!.text());
}

const minVersion = (id: string, value: string | null, envOverrides: Record<string, unknown> = {}) =>
  call('PUT', `/api/folders/${id}/min-version`, { minVersion: value }, envOverrides);
const withdrawn = (id: string, version: string, value: boolean, envOverrides: Record<string, unknown> = {}) =>
  call('PUT', `/api/folders/${id}/releases/${version}/withdrawn`, { withdrawn: value }, envOverrides);

const logsOf = async (id: string, suffix: string) =>
  (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-${suffix}.json`)).map((o) => o.key).sort();
const logEntry = async (key: string) => JSON.parse(await (await env.STATE.get(key))!.text());

/** A bucket that counts the manifest writes. */
function countingBucket() {
  const writes: string[] = [];
  const bucket = spyBucket(env.DEPLOY_BUCKET, async (method, args) => { if (method === 'put') writes.push(String(args[0])); });
  return { writes, bucket };
}

describe('Earlier versions (min_version)', () => {
  test('from a version: one write that adds min_version after latest and keeps everything else; null removes it again', async () => {
    const id = appId('P');
    const old = threeReleases(id);
    await putManifest(id, old);

    // Without min_version only the newest is installable (§3).
    const before = await ok('GET', `/api/folders/${id}`);
    expect(before).toMatchObject({ latest: '0.0.10', minVersion: null, manifestLatest: null });
    expect(before.releases.map((r: any) => [r.version, r.installable, r.withdrawn])).toEqual([['0.0.10', true, false], ['0.0.9', false, false], ['0.0.8', false, false]]);

    const { writes, bucket } = countingBucket();
    const set = await ok('PUT', `/api/folders/${id}/min-version`, { minVersion: '0.0.9' }, 200, { DEPLOY_BUCKET: bucket });
    expect(set).toEqual({ appId: id, minVersion: '0.0.9', latest: '0.0.10', previousLatest: '0.0.10', withdrawn: [], installable: ['0.0.10', '0.0.9'] });
    expect(writes).toEqual([`${id}/manifest.json`]);

    const text = await (await env.DEPLOY_BUCKET.get(`${id}/manifest.json`))!.text();
    expect(text.endsWith('}\n')).toBe(true);
    const doc = JSON.parse(text);
    expect(doc).toEqual({ ...old, min_version: '0.0.9' });
    expect(Object.keys(doc)).toEqual(['application_id', 'latest', 'min_version', 'note', 'binaries']);
    expect((await ok('GET', `/api/folders/${id}`)).releases.map((r: any) => r.installable)).toEqual([true, true, false]);

    // 0.0.10 > 0.0.9 > 0.0.8: numbers per part, not text.
    expect((await ok('PUT', `/api/folders/${id}/min-version`, { minVersion: '0.0.8' })).installable).toEqual(['0.0.10', '0.0.9', '0.0.8']);
    expect(Object.keys(await manifestDoc(id))).toEqual(['application_id', 'latest', 'min_version', 'note', 'binaries']);

    const back = await ok('PUT', `/api/folders/${id}/min-version`, { minVersion: null });
    expect(back).toMatchObject({ minVersion: null, installable: ['0.0.10'] });
    expect(await manifestDoc(id)).toEqual(old);

    // The way back is in the log, with the manifest as it stood.
    const logs = await logsOf(id, 'min-version');
    expect(logs.length).toBe(3);
    expect(await logEntry(logs[0])).toMatchObject({
      action: 'min-version', actor: 'jane.doe@gocontroll.com', min_version: '0.0.9', previous_min_version: null, latest: '0.0.10', previous_manifest: old,
    });
    expect(await logEntry(logs[2])).toMatchObject({ min_version: null, previous_min_version: '0.0.8' });
  });

  test('refused: a version that is not a release, not a version, the same setting again, a missing field; nothing written', async () => {
    const id = appId('P');
    const old = threeReleases(id, { min_version: '0.0.9' });
    await putManifest(id, old);
    const unknown = await minVersion(id, '0.0.7');
    expect([unknown.status, unknown.body.field]).toEqual([422, 'minVersion']);
    const shape = await minVersion(id, '1.2');
    expect([shape.status, shape.body.field]).toEqual([400, 'minVersion']);
    const same = await minVersion(id, '0.0.9');
    expect([same.status, same.body.field]).toEqual([422, 'minVersion']);
    const missing = await call('PUT', `/api/folders/${id}/min-version`, {});
    expect([missing.status, missing.body.field]).toEqual([400, 'minVersion']);
    expect(await manifestDoc(id)).toEqual(old);

    const plain = appId('P');
    await putManifest(plain, threeReleases(plain));
    expect((await minVersion(plain, null)).status).toBe(422);
  });

  test('refused: no manifest, a Linux folder, a manifest that cannot be read, a folder being deleted', async () => {
    expect((await minVersion(appId('P'), '1.0.0')).status).toBe(404);

    const linux = appId('L');
    const linuxDoc = { app_id: linux, latest_version: '1.0.0', versions: [{ version: '1.0.0', tarball: 'v1.0.0/update.tar.gz' }] };
    await putManifest(linux, linuxDoc);
    expect((await minVersion(linux, '1.0.0')).status).toBe(422);
    expect((await withdrawn(linux, '1.0.0', true)).status).toBe(422);
    expect(await manifestDoc(linux)).toEqual(linuxDoc);

    const broken = appId('P');
    await env.DEPLOY_BUCKET.put(`${broken}/manifest.json`, '{ not json');
    expect((await minVersion(broken, '1.0.0')).status).toBe(422);

    const deleting = appId('P');
    await putManifest(deleting, threeReleases(deleting));
    await env.STATE.put(`deleting/${deleting}.json`, JSON.stringify({ started_at: '2026-11-01T00:00:00Z', actor: 'x', reason: 'test' }));
    expect((await minVersion(deleting, '0.0.9')).status).toBe(409);
    expect((await withdrawn(deleting, '0.0.9', true)).status).toBe(409);
    await env.STATE.delete(`deleting/${deleting}.json`);
  });

  test('someone else writing the manifest meanwhile: 409, their manifest stays', async () => {
    const id = appId('P');
    const theirs = { application_id: id, latest: '9.9.9', binaries: {} };
    const racing = spyBucket(env.DEPLOY_BUCKET, async (method, args, target) => {
      if (method === 'put' && String(args[0]).endsWith('/manifest.json')) await target.put(args[0], JSON.stringify(theirs));
    });
    await putManifest(id, threeReleases(id));
    expect((await minVersion(id, '0.0.9', { DEPLOY_BUCKET: racing })).status).toBe(409);
    expect(await manifestDoc(id)).toEqual(theirs);
    await putManifest(id, threeReleases(id));
    expect((await withdrawn(id, '0.0.9', true, { DEPLOY_BUCKET: racing })).status).toBe(409);
    expect(await manifestDoc(id)).toEqual(theirs);
  });
});

describe('Withdraw and Restore', () => {
  test('withdrawing latest: one write, latest moves to the newest that is not withdrawn; restoring moves it back', async () => {
    const id = appId('W');
    const old = threeReleases(id, { min_version: '0.0.8' });
    await putManifest(id, old);

    const { writes, bucket } = countingBucket();
    const out = await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: true }, 200, { DEPLOY_BUCKET: bucket });
    expect(out).toEqual({ appId: id, minVersion: '0.0.8', latest: '0.0.9', previousLatest: '0.0.10', withdrawn: ['0.0.10'], installable: ['0.0.9', '0.0.8'] });
    expect(writes).toEqual([`${id}/manifest.json`]);
    const doc = await manifestDoc(id);
    expect(doc).toEqual({ ...old, latest: '0.0.9', binaries: { ...old.binaries, '0.0.10': { ...old.binaries['0.0.10'], withdrawn: true } } });

    const detail = await ok('GET', `/api/folders/${id}`);
    expect(detail).toMatchObject({ latest: '0.0.9', minVersion: '0.0.8', manifestLatest: null });
    expect(detail.releases.map((r: any) => [r.version, r.withdrawn, r.installable])).toEqual([['0.0.10', true, false], ['0.0.9', false, true], ['0.0.8', false, true]]);
    // The overview and the admin tools follow: latest is what update-to-latest installs.
    expect((await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === id)).toMatchObject({ latest: '0.0.9', manifestLatest: null });

    const restored = await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: false });
    expect(restored).toMatchObject({ latest: '0.0.10', previousLatest: '0.0.9', withdrawn: [] });
    // Restored: the flag is gone, not false; the manifest is as it was.
    expect(await manifestDoc(id)).toEqual(old);

    const [first, second] = await logsOf(id, '0.0.10');
    expect(await logEntry(first)).toMatchObject({ action: 'withdraw', version: '0.0.10', latest: '0.0.9', previous_latest: '0.0.10', previous_manifest: old });
    expect(await logEntry(second)).toMatchObject({ action: 'restore', version: '0.0.10', latest: '0.0.10', previous_latest: '0.0.9' });
  });

  test('withdrawing an older release leaves latest; without min_version only the newest stays installable', async () => {
    const id = appId('W');
    await putManifest(id, threeReleases(id));
    expect(await ok('PUT', `/api/folders/${id}/releases/0.0.9/withdrawn`, { withdrawn: true })).toMatchObject({ latest: '0.0.10', withdrawn: ['0.0.9'], installable: ['0.0.10'] });
    expect(await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: true })).toMatchObject({ latest: '0.0.8', withdrawn: ['0.0.10', '0.0.9'], installable: ['0.0.8'] });
  });

  test('the only release that is not withdrawn cannot be withdrawn', async () => {
    const id = appId('W');
    const one = {
      application_id: id, latest: '1.0.1',
      binaries: {
        '1.0.0': { url: `${TECH}/${id}/${id}-1.0.0.bin`, release_date: '', description: 'Old', withdrawn: true },
        '1.0.1': { url: `${TECH}/${id}/${id}-1.0.1.bin`, release_date: '', description: 'New' },
      },
    };
    await putManifest(id, one);
    const res = await withdrawn(id, '1.0.1', true);
    expect([res.status, res.body.field]).toEqual([422, 'version']);
    expect(res.body.error).toMatch(/only release/);
    expect(await manifestDoc(id)).toEqual(one);
  });

  test('refused: a version that is not a release, not a version, withdrawn already, not withdrawn, a body without the flag', async () => {
    const id = appId('W');
    const old = threeReleases(id);
    await putManifest(id, old);
    expect((await withdrawn(id, '0.0.7', true)).status).toBe(404);
    expect((await withdrawn(id, 'latest', true)).status).toBe(400);
    expect((await withdrawn(id, '0.0.9', false)).status).toBe(422);
    expect((await call('PUT', `/api/folders/${id}/releases/0.0.9/withdrawn`, { withdrawn: 'yes' })).status).toBe(400);
    expect(await manifestDoc(id)).toEqual(old);
    await ok('PUT', `/api/folders/${id}/releases/0.0.9/withdrawn`, { withdrawn: true });
    expect((await withdrawn(id, '0.0.9', true)).status).toBe(422);
  });
});

describe('a manifest written before the policy', () => {
  test('latest left on an older release (moved back to undo one): the page says so; latest is the newest that is not withdrawn', async () => {
    const id = appId('M');
    await putManifest(id, threeReleases(id, { latest: '0.0.9' }));
    const detail = await ok('GET', `/api/folders/${id}`);
    expect(detail).toMatchObject({ latest: '0.0.10', manifestLatest: '0.0.9' });
    expect(detail.releases.filter((r: any) => r.installable).map((r: any) => r.version)).toEqual(['0.0.10']);
    // Withdrawing the release that was undone that way makes the manifest agree again.
    expect(await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: true })).toMatchObject({ latest: '0.0.9', previousLatest: '0.0.9' });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({ latest: '0.0.9', manifestLatest: null });
  });

  test('a latest_only key and unknown fields stay through every change', async () => {
    const id = appId('M');
    await putManifest(id, threeReleases(id, { latest_only: true }));
    await ok('PUT', `/api/folders/${id}/min-version`, { minVersion: '0.0.9' });
    await ok('PUT', `/api/folders/${id}/releases/0.0.8/withdrawn`, { withdrawn: true });
    const doc = await manifestDoc(id);
    expect(doc).toMatchObject({ latest_only: true, note: { keep: 'me' }, min_version: '0.0.9' });
    expect(doc.binaries['0.0.8']).toMatchObject({ extra: 1, withdrawn: true });
  });
});
