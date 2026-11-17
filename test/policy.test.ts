// Which versions of an S1 application may be installed (src/policy.ts; cloud-r2-distribution.md §3
// v0.22.0, "Which versions can be installed"): every release that is not withdrawn; PUT
// /api/folders/:appId/releases/:version/withdrawn (Withdraw / Restore), and what the page reads.
// PUT …/min-version ("Earlier versions", 0.14.x) is gone.

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

describe('which versions are installable (§3 v0.22.0)', () => {
  test('every release that is not withdrawn; a min_version in the manifest is ignored', async () => {
    const id = appId('P');
    await putManifest(id, threeReleases(id, { min_version: '0.0.10' }));
    const detail = await ok('GET', `/api/folders/${id}`);
    expect(detail).toMatchObject({ latest: '0.0.10', manifestLatest: null });
    expect(detail).not.toHaveProperty('minVersion');
    // 0.0.10 > 0.0.9 > 0.0.8: numbers per part, not text.
    expect(detail.releases.map((r: any) => [r.version, r.installable, r.withdrawn])).toEqual([['0.0.10', true, false], ['0.0.9', true, false], ['0.0.8', true, false]]);
  });

  test('Earlier versions is gone: PUT …/min-version is 410 and writes nothing', async () => {
    const id = appId('P');
    const old = threeReleases(id, { min_version: '0.0.9' });
    await putManifest(id, old);
    const { writes, bucket } = countingBucket();
    const res = await call('PUT', `/api/folders/${id}/min-version`, { minVersion: '0.0.8' }, { DEPLOY_BUCKET: bucket });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/not withdrawn/);
    expect(writes).toEqual([]);
    expect(await manifestDoc(id)).toEqual(old);
    expect(await logsOf(id, 'min-version')).toEqual([]);
  });

  test('refused: no manifest, a Linux folder, a manifest that cannot be read, a folder being deleted', async () => {
    expect((await withdrawn(appId('P'), '1.0.0', true)).status).toBe(404);

    const linux = appId('L');
    const linuxDoc = { app_id: linux, latest_version: '1.0.0', versions: [{ version: '1.0.0', tarball: 'v1.0.0/update.tar.gz' }] };
    await putManifest(linux, linuxDoc);
    expect((await withdrawn(linux, '1.0.0', true)).status).toBe(422);
    expect(await manifestDoc(linux)).toEqual(linuxDoc);

    const broken = appId('P');
    await env.DEPLOY_BUCKET.put(`${broken}/manifest.json`, '{ not json');
    expect((await withdrawn(broken, '1.0.0', true)).status).toBe(422);

    const deleting = appId('P');
    await putManifest(deleting, threeReleases(deleting));
    await env.STATE.put(`deleting/${deleting}.json`, JSON.stringify({ started_at: '2026-11-01T00:00:00Z', actor: 'x', reason: 'test' }));
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
    expect((await withdrawn(id, '0.0.9', true, { DEPLOY_BUCKET: racing })).status).toBe(409);
    expect(await manifestDoc(id)).toEqual(theirs);
  });
});

describe('Withdraw and Restore', () => {
  test('withdrawing latest: one write, latest moves to the newest that is not withdrawn; restoring moves it back', async () => {
    const id = appId('W');
    const old = threeReleases(id);
    await putManifest(id, old);

    const { writes, bucket } = countingBucket();
    const out = await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: true }, 200, { DEPLOY_BUCKET: bucket });
    expect(out).toEqual({ appId: id, latest: '0.0.9', previousLatest: '0.0.10', withdrawn: ['0.0.10'], installable: ['0.0.9', '0.0.8'] });
    expect(writes).toEqual([`${id}/manifest.json`]);
    const text = await (await env.DEPLOY_BUCKET.get(`${id}/manifest.json`))!.text();
    expect(text.endsWith('}\n')).toBe(true);
    const doc = JSON.parse(text);
    expect(doc).toEqual({ ...old, latest: '0.0.9', binaries: { ...old.binaries, '0.0.10': { ...old.binaries['0.0.10'], withdrawn: true } } });
    expect(Object.keys(doc)).toEqual(['application_id', 'latest', 'note', 'binaries']);

    const detail = await ok('GET', `/api/folders/${id}`);
    expect(detail).toMatchObject({ latest: '0.0.9', manifestLatest: null });
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

  test('withdrawing an older release leaves latest; the rest stays installable', async () => {
    const id = appId('W');
    await putManifest(id, threeReleases(id));
    expect(await ok('PUT', `/api/folders/${id}/releases/0.0.9/withdrawn`, { withdrawn: true })).toMatchObject({ latest: '0.0.10', withdrawn: ['0.0.9'], installable: ['0.0.10', '0.0.8'] });
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
    expect(detail.releases.filter((r: any) => r.installable).map((r: any) => r.version)).toEqual(['0.0.10', '0.0.9', '0.0.8']);
    // Withdrawing the release that was undone that way makes the manifest agree again.
    expect(await ok('PUT', `/api/folders/${id}/releases/0.0.10/withdrawn`, { withdrawn: true })).toMatchObject({ latest: '0.0.9', previousLatest: '0.0.9' });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({ latest: '0.0.9', manifestLatest: null });
  });

  test('a latest_only key and unknown fields stay through every change; min_version goes at the first write', async () => {
    const id = appId('M');
    await putManifest(id, threeReleases(id, { latest_only: true, min_version: '0.0.9' }));
    await ok('PUT', `/api/folders/${id}/releases/0.0.8/withdrawn`, { withdrawn: true });
    const doc = await manifestDoc(id);
    expect(doc).toMatchObject({ latest_only: true, note: { keep: 'me' } });
    expect(Object.keys(doc)).toEqual(['application_id', 'latest', 'note', 'latest_only', 'binaries']);
    expect(doc.binaries['0.0.8']).toMatchObject({ extra: 1, withdrawn: true });
  });
});
