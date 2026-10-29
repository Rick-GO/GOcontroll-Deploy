// Linux (go-deploy) releases: POST /api/linux-releases against the CI producer, upload-r2.py
// of the skill r2-application-deploy-setup. test/fixtures/linux/root-manifests.json holds what
// upload-r2.py's own upload() wrote for each case (scripts/linux-root-fixtures.py); the Worker
// must write the same root manifest, byte for byte, in the same order of objects.

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { compareSemver, pythonJson } from '../src/godeploy';
import fixtures from './fixtures/linux/root-manifests.json';
import { call, ok, putManifest, spyBucket, upload, zlibPayload } from './helpers';

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = async (key: string) => (await env.DEPLOY_BUCKET.get(key))?.text() ?? null;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let n = 0;
/** A fresh Linux App ID. */
const linuxId = () => `lx-${Date.now().toString(36)}-${++n}`;

/** A tiny gzip stream (not a real tar: the Worker never unpacks). */
async function gzip(content: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A version manifest as build-package.py writes it. */
function versionManifest(appId: string, version: string, description: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    manifest_version: 1, app_id: appId, version, released: '2026-10-21', description,
    files: [{ source: 'files/app.elf', destination: '/usr/simulink/app.elf', owner: 'root', group: 'root', mode: '0755', sha256: 'ab'.repeat(32) }],
    ...extra,
  }, null, 2)}\n`;
}

async function newLinuxApp(id = linuxId(), controller = 'L4') {
  await ok('POST', '/api/folders', { appId: id, customerId: null, controller }, 201);
  return id;
}

async function release(id: string, version: string, extra: Record<string, string | Uint8Array> = {}, envOverrides: Record<string, unknown> = {}) {
  const description = typeof extra.description === 'string' ? extra.description : `Release ${version}`;
  return upload('/api/linux-releases', {
    appId: id, version, description, replace: '0',
    tarball: await gzip(`package ${id} ${version}`), manifest: versionManifest(id, version, description), ...extra,
  }, envOverrides);
}

describe('the root manifest as upload-r2.py writes it', () => {
  test.each(fixtures.cases)('$name', async (c) => {
    if (c.root_before === null) await newLinuxApp(c.app_id);
    else await env.DEPLOY_BUCKET.put(`${c.app_id}/manifest.json`, c.root_before, { httpMetadata: { contentType: 'application/json' } });
    if ((c as { replace?: boolean }).replace) {
      await env.DEPLOY_BUCKET.put(`${c.app_id}/v${c.version}/update.tar.gz`, 'old tarball');
      await env.DEPLOY_BUCKET.put(`${c.app_id}/v${c.version}/manifest.json`, '{"old":true}');
    }
    const order: string[] = [];
    const bucket = spyBucket(env.DEPLOY_BUCKET, async (method, args) => { if (method === 'put') order.push(String(args[0])); });
    const tarball = unb64(c.tarball_b64);
    const res = await upload('/api/linux-releases', {
      appId: c.app_id, version: c.version, description: c.description, replace: (c as { replace?: boolean }).replace ? '1' : '0',
      tarball, manifest: c.version_manifest,
    }, { DEPLOY_BUCKET: bucket });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Same objects, same order, same content types, the same root manifest bytes.
    expect(order).toEqual(c.writes.map((w) => w.key));
    for (const w of c.writes) expect((await env.DEPLOY_BUCKET.head(w.key))?.httpMetadata?.contentType, w.key).toBe(w.content_type);
    expect(await text(`${c.app_id}/manifest.json`)).toBe(c.root_after);
    expect(await text(`${c.app_id}/v${c.version}/manifest.json`)).toBe(c.version_manifest);
    const stored = await (await env.DEPLOY_BUCKET.get(`${c.app_id}/v${c.version}/update.tar.gz`))!.arrayBuffer();
    expect(hex(stored)).toBe(hex(tarball.buffer));

    const after = JSON.parse(c.root_after);
    const entry = after.versions.find((v: any) => v.version === c.version);
    expect(res.body).toMatchObject({
      tarballKey: `${c.app_id}/v${c.version}/update.tar.gz`, manifestKey: `${c.app_id}/v${c.version}/manifest.json`,
      rootManifestKey: `${c.app_id}/manifest.json`, version: c.version, released: '2026-10-21',
      sha256: entry.sha256, sizeBytes: entry.size_bytes, latestVersion: after.latest_version,
      previousLatest: c.root_before === null ? null : JSON.parse(c.root_before).latest_version,
      replaced: Boolean((c as { replace?: boolean }).replace),
    });
  });

  test('semver_key order and json.dumps escaping, directly', () => {
    const sorted = ['0.9.9', '1.0.1-r', '1.0.0', '1.0.1', '0.9.10', '1.0.1-alpha', '1.x', '1.2'].sort((a, b) => compareSemver(b, a));
    expect(sorted).toEqual(['1.2', '1.0.1', '1.0.1-r', '1.0.1-alpha', '1.0.0', '0.9.10', '0.9.9', '1.x']);
    expect(pythonJson({ a: 'é🚀\u007f', b: [], c: {} })).toBe('{\n  "a": "\\u00e9\\ud83d\\ude80\\u007f",\n  "b": [],\n  "c": {}\n}\n');
  });
});

describe('POST /api/linux-releases', () => {
  test('409 on a version already there; replace archives the old package and version manifest first', async () => {
    const id = await newLinuxApp();
    expect((await release(id, '1.0.0')).status).toBe(200);
    const again = await release(id, '1.0.0');
    expect([again.status, again.body.field]).toEqual([409, 'version']);
    const oldTar = await (await env.DEPLOY_BUCKET.get(`${id}/v1.0.0/update.tar.gz`))!.arrayBuffer();
    const oldManifest = await text(`${id}/v1.0.0/manifest.json`);

    const replaced = await release(id, '1.0.0', { replace: '1', description: 'Rebuilt' });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.replaced).toBe(true);
    const kept = (await env.STATE.list({ prefix: `replaced/${id}/v1.0.0/` })).objects.map((o) => o.key);
    expect(kept.length).toBe(2);
    const tarCopy = kept.find((k) => k.endsWith('/update.tar.gz'))!;
    expect(hex(await (await env.STATE.get(tarCopy))!.arrayBuffer())).toBe(hex(oldTar));
    expect(await (await env.STATE.get(kept.find((k) => k.endsWith('/manifest.json'))!))!.text()).toBe(oldManifest);
    const root = JSON.parse((await text(`${id}/manifest.json`))!);
    expect(root.versions.map((v: any) => [v.version, v.description])).toEqual([['1.0.0', 'Rebuilt']]);

    const logs = (await env.STATE.list({ prefix: 'log/' })).objects.filter((o) => o.key.endsWith(`-${id}-1.0.0.json`));
    const entries = await Promise.all(logs.map(async (o) => JSON.parse(await (await env.STATE.get(o.key))!.text())));
    expect(entries.map((e) => e.action)).toEqual(['publish-linux', 'publish-linux']);
    const last = entries.find((e) => e.replaced)!;
    expect(last).toMatchObject({ version: '1.0.0', replaced: true, size: replaced.body.sizeBytes, sha256: replaced.body.sha256 });
    expect(last.previous_manifest.versions[0].description).toBe('Release 1.0.0');
  });

  test('a lower version is published but does not become latest', async () => {
    const id = await newLinuxApp();
    await release(id, '1.2.0');
    const low = await release(id, '1.0.0');
    expect(low.body).toMatchObject({ version: '1.0.0', latestVersion: '1.2.0', previousLatest: '1.2.0' });
  });

  test('the version manifest must name this App ID and version, the same description, a date and valid files', async () => {
    const id = await newLinuxApp();
    const cases: [string, string][] = [
      ['other app', versionManifest('someone-else', '1.0.0', 'Release 1.0.0')],
      ['other version', versionManifest(id, '1.0.1', 'Release 1.0.0')],
      ['other description', versionManifest(id, '1.0.0', 'Something else')],
      ['no date', versionManifest(id, '1.0.0', 'Release 1.0.0', { released: undefined })],
      ['relative destination', versionManifest(id, '1.0.0', 'Release 1.0.0', { files: [{ source: 'files/a', destination: 'usr/a', mode: '0644', sha256: 'ab'.repeat(32) }] })],
      ['source outside files/', versionManifest(id, '1.0.0', 'Release 1.0.0', { files: [{ source: 'a', destination: '/usr/a', mode: '0644', sha256: 'ab'.repeat(32) }] })],
      ['mode not octal', versionManifest(id, '1.0.0', 'Release 1.0.0', { files: [{ source: 'files/a', destination: '/usr/a', mode: '644x', sha256: 'ab'.repeat(32) }] })],
      ['upper-case sha256', versionManifest(id, '1.0.0', 'Release 1.0.0', { files: [{ source: 'files/a', destination: '/usr/a', mode: '0644', sha256: 'AB'.repeat(32) }] })],
      ['post_install elsewhere', versionManifest(id, '1.0.0', 'Release 1.0.0', { post_install: { source: 'files/run.sh', interpreter: '/bin/bash', sha256: 'ab'.repeat(32) } })],
      ['not JSON', '{ nope'],
    ];
    for (const [label, manifest] of cases) {
      const res = await release(id, '1.0.0', { manifest });
      expect([res.status, res.body.field], label).toEqual([422, 'manifest']);
    }
    expect((await env.DEPLOY_BUCKET.list({ prefix: `${id}/` })).objects).toEqual([]);
  });

  test('the package must be gzip; version format and description are checked', async () => {
    const id = await newLinuxApp();
    const notGzip = await release(id, '1.0.0', { tarball: new TextEncoder().encode('just a tar') });
    expect([notGzip.status, notGzip.body.field]).toEqual([422, 'tarball']);
    expect((await release(id, '1.0', {})).body.field).toBe('version');
    expect((await release(id, 'v1.0.0', {})).body.field).toBe('version');
    expect((await release(id, '1.0.1-r', {})).status).toBe(200);
    expect((await release(id, '1.0.2', { description: ' ' })).body.field).toBe('description');
    expect(await env.DEPLOY_BUCKET.head(`${id}/v1.0.0/update.tar.gz`)).toBeNull();
  });

  test('S1 and Linux never mix', async () => {
    // A Linux release into an S1 folder (manifest or settings), and S1 firmware into a Linux one.
    const s1 = `S1${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const { payload, rawSize } = await zlibPayload();
    expect((await upload('/api/releases', { appId: s1, version: '1.0.0', description: 'x', payload, rawSize: String(rawSize) })).status).toBe(200);
    const intoS1 = await release(s1, '1.0.0');
    expect([intoS1.status, intoS1.body.error]).toEqual([422, `The folder ${s1} holds S1 firmware; Linux releases cannot go into it.`]);
    const s1Settings = `T${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await ok('POST', '/api/folders', { appId: s1Settings, customerId: null, controller: 'S1' }, 201);
    expect((await release(s1Settings, '1.0.0')).status).toBe(422);

    const id = await newLinuxApp(linuxId(), 'HMI1');
    const s1IntoLinux = await upload('/api/releases', { appId: id, version: '1.0.0', description: 'x', payload, rawSize: String(rawSize) });
    expect(s1IntoLinux.status).toBe(422);
    // A public key may be kept for a Linux application (provisioning), but nothing Linux is signed.
    expect((await call('POST', '/api/sign/scope', { appId: id, version: '1.0.0', payload: { size: 1, rawSize: 1, sha256: '00'.repeat(32) } })).status).toBe(422);

    // Nothing there yet: make it a Linux application first.
    const nothing = linuxId();
    const res = await release(nothing, '1.0.0');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/new application with controller M1, L4 or HMI1/);
  });

  test('nothing goes into a folder being deleted', async () => {
    const id = await newLinuxApp();
    await env.STATE.put(`deleting/${id}.json`, JSON.stringify({ app_id: id, started_at: new Date().toISOString(), actor: 'x', reason: 'y', controllers: 0, deleted: 0, bytes: 0 }));
    expect((await release(id, '1.0.0')).status).toBe(409);
    await env.STATE.delete(`deleting/${id}.json`);
  });

  test('a root manifest changed meanwhile is a 409, after the package and version manifest were written', async () => {
    const id = await newLinuxApp();
    await release(id, '1.0.0');
    const racing = spyBucket(env.DEPLOY_BUCKET, async (method, args, target) => {
      if (method === 'put' && args[0] === `${id}/manifest.json`) await target.put(args[0], '{"app_id":"x","latest_version":"9.9.9","versions":[]}');
    });
    expect((await release(id, '1.1.0', {}, { DEPLOY_BUCKET: racing })).status).toBe(409);
    expect(JSON.parse((await text(`${id}/manifest.json`))!).latest_version).toBe('9.9.9');
  });
});

describe('Linux applications', () => {
  test('a new one: Linux App ID, no host, kind linux before its first release', async () => {
    const id = linuxId();
    await ok('POST', '/api/folders', { appId: id, customerId: null, controller: 'M1', distributionUrl: 'https://deploy.gocontroll.tech' }, 201);
    expect(JSON.parse((await (await env.STATE.get(`folders/${id}.json`))!.text())).distribution_url).toBeNull();
    const row = (await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === id);
    expect(row).toMatchObject({ kind: 'linux', controller: 'M1', controllerSource: 'manual', releases: 0, latest: null, distributionUrl: null });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({
      kind: 'linux', controller: 'M1', package: null, packageSource: null, latestVersionManifest: null, latestVersionManifestError: null,
    });
    for (const bad of ['Upper-Case', '-lead', 'a b', 'x'.repeat(65)]) {
      const res = await call('POST', '/api/folders', { appId: bad, customerId: null, controller: 'L4' });
      expect([res.status, res.body.field], bad).toEqual([400, 'appId']);
    }
    expect((await ok('GET', '/api/overview')).folders.find((f: any) => f.appId === id)).toMatchObject({ kind: 'linux', publicKey: null });
  });

  test('the package definition: stored with defaults, validated, only for Linux applications', async () => {
    const id = await newLinuxApp();
    const definition = {
      files: [
        { name: 'app.elf', destination: '/usr/simulink/app.elf', mode: '0755' },
        { name: 'flows.json', destination: '/home/root/.node-red/flows.json', mode: '0644', owner: 'nodered', group: 'nodered' },
      ],
      post_install: { mode: 'services', services: ['nodered', 'go-simulink'] },
    };
    const saved = await ok('PUT', `/api/folders/${id}/package`, definition);
    expect(saved).toEqual({ package: { owner: 'root', group: 'root', ...definition }, packageSource: 'manual' });
    expect(await ok('GET', `/api/folders/${id}`)).toMatchObject({ package: saved.package, packageSource: 'manual' });
    expect((await ok('PUT', `/api/folders/${id}/package`, { files: definition.files })).package.post_install).toEqual({ mode: 'none' });
    expect((await ok('PUT', `/api/folders/${id}/package`, { files: definition.files, post_install: { mode: 'script', script: '#!/bin/bash\necho hi\n' } })).package.post_install.mode).toBe('script');

    const bad: [string, unknown][] = [
      ['no files', { files: [] }],
      ['post-install.sh as a file', { files: [{ name: 'post-install.sh', destination: '/x', mode: '0755' }] }],
      ['a path as name', { files: [{ name: 'bin/app', destination: '/x', mode: '0755' }] }],
      ['twice the same name', { files: [{ name: 'a', destination: '/x', mode: '0755' }, { name: 'a', destination: '/y', mode: '0755' }] }],
      ['twice the same destination', { files: [{ name: 'a', destination: '/x', mode: '0755' }, { name: 'b', destination: '/x', mode: '0755' }] }],
      ['relative destination', { files: [{ name: 'a', destination: 'usr/a', mode: '0644' }] }],
      ['.. in destination', { files: [{ name: 'a', destination: '/usr/../etc/a', mode: '0644' }] }],
      ['bad mode', { files: [{ name: 'a', destination: '/a', mode: '999' }] }],
      ['bad service', { files: [{ name: 'a', destination: '/a', mode: '0644' }], post_install: { mode: 'services', services: ['node red'] } }],
      ['no services', { files: [{ name: 'a', destination: '/a', mode: '0644' }], post_install: { mode: 'services', services: [] } }],
      ['empty script', { files: [{ name: 'a', destination: '/a', mode: '0644' }], post_install: { mode: 'script', script: '  ' } }],
      ['bad owner', { files: [{ name: 'a', destination: '/a', mode: '0644', owner: 'ro ot' }] }],
    ];
    for (const [label, body] of bad) expect((await call('PUT', `/api/folders/${id}/package`, body)).status, label).toBe(400);

    const s1 = `P${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await ok('POST', '/api/folders', { appId: s1, customerId: null, controller: 'S1' }, 201);
    expect((await call('PUT', `/api/folders/${s1}/package`, definition)).status).toBe(422);
    expect((await call('PUT', `/api/folders/${linuxId()}/package`, definition)).status).toBe(404);
  });

  test('the folder page offers the latest version manifest; its package can be fetched', async () => {
    const id = await newLinuxApp();
    const before = await ok('GET', `/api/folders/${id}`);
    expect(before.latestVersionManifest).toBeNull();
    const pub = await release(id, '1.0.0');
    expect(pub.status).toBe(200);
    const after = await ok('GET', `/api/folders/${id}`);
    expect(after).toMatchObject({ kind: 'linux', latest: '1.0.0', latestVersionManifestError: null });
    expect(after.latestVersionManifest).toEqual(JSON.parse(versionManifest(id, '1.0.0', 'Release 1.0.0')));
    expect(after.linuxVersions[0]).toMatchObject({ version: '1.0.0', sha256: pub.body.sha256, sizeBytes: pub.body.sizeBytes });

    const tar = await call('GET', `/api/folders/${id}/versions/1.0.0/tarball`);
    expect(tar.status).toBe(200);
    expect(tar.res.headers.get('content-type')).toBe('application/gzip');
    expect(tar.res.headers.get('cache-control')).toBe('private, no-store');
    const served = await tar.res.arrayBuffer();
    expect(hex(served)).toBe(hex(await (await env.DEPLOY_BUCKET.get(`${id}/v1.0.0/update.tar.gz`))!.arrayBuffer()));
    expect(hex(await crypto.subtle.digest('SHA-256', served))).toBe(pub.body.sha256);
    expect((await call('GET', `/api/folders/${id}/versions/9.9.9/tarball`)).status).toBe(404);

    await env.DEPLOY_BUCKET.delete(`${id}/v1.0.0/manifest.json`);
    expect((await ok('GET', `/api/folders/${id}`)).latestVersionManifestError).toMatch(/not in the bucket/);
  });

  test('no tarball route for an S1 folder', async () => {
    const id = linuxId();
    await putManifest(id, { application_id: id, latest: '1.0.0', binaries: {} });
    expect((await call('GET', `/api/folders/${id}/versions/1.0.0/tarball`)).status).toBe(404);
  });
});
