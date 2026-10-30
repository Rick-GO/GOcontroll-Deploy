// AdminApi (src/admin-api.ts): the tools of the MCP connector and the backup. What a tool returns
// goes to an AI provider: the fixtures hold a recognisable value in every place that must stay in,
// and no tool may return one. Everything here is made up; GitHub and Cloudflare are stubbed.

import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { AdminApi, TOOLS, exportScope } from '../src/admin-api';
import { AdminError } from '../src/lib/admin-contract';
import { downloadLogKey } from '../src/images-format';
import { APP_VERSION } from '../src/version';
import { controller, customer, putManifest } from './helpers';

const ACTOR = { email: 'admin@gocontroll.com', name: 'An Admin', client: 'Claude' };
const SEALED = 'v1.SEALED-IV.SEALED-CIPHERTEXT';
const CUSTOMER_MAIL = 'secret.customer@example.com';
const PUBLIC_KEY = `04${'AB'.repeat(64)}`;
const SECRETS = [SEALED, 'SEALED-CIPHERTEXT', CUSTOMER_MAIL, PUBLIC_KEY, 'UPLOAD-ID-SECRET', 'TOKEN-OF-GITHUB', 'C:/Users/secret/path'];

const APP = 'ADMINAPP';
const LINUX = 'ADMINLNX';
const MOD = '20700101';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let acme: number;
const api = () => new AdminApi(createExecutionContext(), env);
const call = (name: string, args: Record<string, unknown> = {}) => api().call(name, args, ACTOR) as Promise<any>;
const json = (value: unknown) => JSON.stringify(value);

async function putLog(at: string, app_id: string, version: string, entry: Record<string, unknown>) {
  await env.STATE.put(`log/${at.slice(0, 4)}/${at.slice(5, 7)}/${at}-${app_id}-${version}.json`, json({ at, app_id, version, actor: 'jane.doe@gocontroll.com', ...entry }));
}

beforeAll(async () => {
  acme = await customer('Acme Pumps');
  const today = iso(Date.now()).slice(0, 10);

  // An S1 application with a key sealed before 0.7.0, two controllers of which one behind.
  await putManifest(APP, { application_id: APP, latest: '1.2.0', binaries: {
    '1.2.0': { url: `https://deploy.gocontroll.tech/${APP}/${APP}-1.2.0.bin?v=0011223344556677`, release_date: today, description: 'Fixes the pump start' },
    '1.1.0': { url: `https://deploy.gocontroll.tech/${APP}/${APP}-1.1.0.bin?v=7766554433221100`, release_date: '2026-09-01', description: 'First' },
  } });
  await env.STATE.put(`keys/${APP}.json`, json({ app_id: APP, public_key: PUBLIC_KEY, sealed_private_key: SEALED, source: 'generated', created_at: '2026-10-01T00:00:00Z', created_by: 'jane.doe@gocontroll.com' }));
  await env.STATE.put(`folders/${APP}.json`, json({ customer_id: acme, updated_at: '2026-10-01T00:00:00Z', updated_by: 'jane.doe@gocontroll.com' }));
  await controller({ app_id: APP, app_version: '1.2.0', client_id: acme, online: 1, type: 'Moduline S1' });
  await controller({ app_id: APP, app_version: '1.1.0', client_id: acme, online: 0, type: 'Moduline S1' });

  // A Linux application.
  await putManifest(LINUX, { app_id: LINUX, latest_version: '2.0.0', versions: [{ version: '2.0.0', released: today, description: 'Linux', size_bytes: 1000, tarball: 'v2.0.0/update.tar.gz', manifest: 'v2.0.0/manifest.json' }] });

  // Module firmware, published from Deploy with a commit, the first release not the latest_firmware.
  await env.FIRMWARE_BUCKET.put('modules/manifest.json', json({ updated: today, modules: [{ id: MOD, name: 'Test Input module', hardware_version: '1.01', latest_firmware: '1.1.0', manifest: `modules/${MOD}/manifest.json` }] }));
  await env.FIRMWARE_BUCKET.put(`modules/${MOD}/manifest.json`, json({ id: MOD, name: 'Test Input module', hardware_version: '1.01', releases: [
    { sw_version: '1.0.0', file: `modules/${MOD}/x.srec`, date: '28/10/26', sha256: 'ab', changelog: 'Older' },
    { sw_version: '0.9.0', file: `modules/${MOD}/y.srec`, date: '01/09/26', sha256: 'cd', changelog: 'First' },
  ] }));
  const source = json({ repo: 'Module-Test', branch: 'main', commit: 'a'.repeat(40), tag: 'v1.0.0', path: 'C:/Users/secret/path', pushed: true });
  await env.STATE.put(`firmware-log/${MOD}/1.0.0.json`, '{}', { customMetadata: { email: 'jane.doe@gocontroll.com', at: '2026-10-28T10:00:00Z', source } });

  // Images: a published release with downloads, an old draft, an upload that hangs.
  const release = (fields: Record<string, unknown>) => json({
    controller: 'L4', type: '', version: '6.12.87', released: '2026-10-29', notes: 'Kernel 6.12', status: 'published', files: [
      { name: 'image.zip', path: 'images/moduline-l4/abc123def456/image.zip', size: 2048, sha256: '0'.repeat(64), role: 'package', platform: 'any', uploaded_at: '2026-10-29T10:00:00Z', uploaded_by: 'jane.doe@gocontroll.com' },
    ], created_at: '2026-10-29T09:00:00Z', created_by: 'jane.doe@gocontroll.com', updated_at: '2026-10-29T10:00:00Z', updated_by: 'jane.doe@gocontroll.com',
    published_at: '2026-10-29T11:00:00Z', published_by: 'jane.doe@gocontroll.com', ...fields,
  });
  await env.STATE.put('images/releases/moduline-l4/abc123def456.json', release({}));
  await env.STATE.put('images/releases/moduline-hmi1/old000draft0.json', release({ controller: 'HMI1', type: '1.07 - AV123', version: '6.12.80', status: 'draft', files: [], updated_at: iso(Date.now() - 40 * DAY), published_at: null, published_by: null }));
  await env.IMAGES_BUCKET.put('manifest.json', json({ format: 5, updated: '2026-10-29T11:00:00Z', releases: [
    { folder: 'images/moduline-l4/abc123def456', controller: 'L4', type: '', version: '6.12.87', released: '2026-10-29', notes: '', files: [] },
  ] }));
  await env.STATE.put('images/uploads/aaaabbbbccccddddaaaabbbbccccdddd.json', json({
    id: 'aaaabbbbccccddddaaaabbbbccccdddd', upload_id: 'UPLOAD-ID-SECRET', key: 'images/moduline-hmi1/old000draft0/big.zip', release: 'moduline-hmi1/old000draft0', name: 'big.zip', size: 10, role: 'package', platform: 'any',
    part_size: 10, parts: 1, started_at: iso(Date.now() - 3 * DAY), started_by: 'jane.doe@gocontroll.com',
  }));
  await env.IMAGES_BUCKET.put(downloadLogKey(new Date(), 'r1'), '', { customMetadata: { email: CUSTOMER_MAIL, path: 'images/moduline-l4/abc123def456/image.zip', product: 'moduline-l4', version: 'abc123def456', country: 'NL' } });
  await env.IMAGES_BUCKET.put(downloadLogKey(new Date(), 'r2'), '', { customMetadata: { email: CUSTOMER_MAIL.toUpperCase(), path: 'images/moduline-l4/abc123def456/image.zip', product: 'moduline-l4', version: 'abc123def456', country: '' } });

  // The audit log: a publish with everything a log line holds, and a settings change.
  await putLog(iso(Date.now() - DAY), APP, '1.2.0', { action: 'publish', signed: true, replaced: false, description: 'Fixes the pump start', public_key: PUBLIC_KEY, previous_manifest: { secret: SEALED } });
  await putLog(iso(Date.now() - 2 * DAY), 'image-moduline-l4', 'abc123def456', { action: 'images-publish', files: [] });
  await putLog(iso(Date.now() - 3 * DAY), APP, 'settings', { action: 'settings', version: undefined });
  await putLog(iso(Date.now() - 40 * DAY), APP, '1.1.0', { action: 'publish', signed: true });

  // A delete that stopped halfway.
  await env.STATE.put('deleting/STUCKAPP.json', json({ started_at: '2026-10-29T10:00:00Z', actor: 'jane.doe@gocontroll.com', reason: 'test' }));
});

afterEach(() => vi.restoreAllMocks());

describe('describe', () => {
  test('contract 1, names unique and snake_case, every input an object, attention and customer there, only reads', () => {
    const d = api().describe();
    expect(d).toMatchObject({ contract: 1, id: 'deploy', title: 'Deploy', version: APP_VERSION, url: 'https://deploy.gocontroll.tools', scopes: ['deploy'] });
    const names = d.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of d.tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.input.type).toBe('object');
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.kind).toBe('read');
    }
    expect(names).toEqual(expect.arrayContaining(['attention', 'customer']));
    expect(names.length).toBeLessThanOrEqual(12);
  });

  test('the Worker exports the entrypoint', async () => {
    const worker = await import('../src/index');
    expect(worker.AdminApi).toBe(AdminApi);
  });
});

describe('the data boundary', () => {
  test('no tool returns a key, a sealed key, a token, a customer\'s address or a local path', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const args: Record<string, Record<string, unknown>> = {
      application: { app_id: APP }, module_firmware_releases: { hw_id: MOD }, customer: { relation_id: acme }, recent_publications: { all: true }, rollout: { all: true },
    };
    for (const tool of TOOLS) {
      const out = json(await call(tool.name, args[tool.name] ?? {}));
      expect(out, tool.name).not.toContain('The request failed');
      for (const secret of SECRETS) expect(out.includes(secret), `${tool.name} returned ${secret}`).toBe(false);
      expect(out.includes('@example.com'), `${tool.name} returned a customer's address`).toBe(false);
    }
  });

  test('a wrong argument, an unknown tool and an unknown application are refused with a sentence', async () => {
    expect(await call('applications', { kind: 'x' })).toEqual({ error: 'kind must be one of: s1, linux, unknown.' });
    expect(await call('application', {})).toEqual({ error: 'app_id is required.' });
    expect(await call('module_firmware_releases', { hw_id: 'abc' })).toEqual({ error: 'hw_id has the wrong format.' });
    expect(await call('nope')).toEqual({ error: 'Unknown tool: nope.' });
    expect(await call('application', { app_id: 'NOSUCHAPP' })).toEqual({ error: 'There is no folder NOSUCHAPP in the bucket.' });
    expect(await call('application', { app_id: 'a/b' })).toEqual({ error: 'Not found.' });
    expect(await call('module_firmware_releases', { hw_id: '99999999' })).toEqual({ error: 'There is no module 99999999 on firmware.gocontroll.tech.' });
  });
});

describe('the tools', () => {
  test('applications: customer, latest release, controllers, totals, filters', async () => {
    const out = await call('applications', { search: 'adminapp' });
    expect(out.total).toBe(1);
    expect(out.items[0]).toEqual({
      app_id: APP, kind: 's1', controller: 'S1', customer: { relation_id: acme, name: 'Acme Pumps' }, latest: '1.2.0', releases: 2, last_upload: expect.any(String),
      has_public_key: true, distribution_url: 'https://deploy.gocontroll.tech', controllers: { total: 2, online: 1, up_to_date: 1 },
      url: `https://deploy.gocontroll.tools/#/applications/${APP}`,
    });
    expect(out.totals.applications).toBeGreaterThanOrEqual(2);
    expect((await call('applications', { kind: 'linux' })).items.map((i: any) => i.app_id)).toContain(LINUX);
    expect((await call('applications', { controller: 's1', relation_id: acme })).total).toBe(1);
  });

  test('application: releases, versions on the controllers, only that there is a key', async () => {
    const out = await call('application', { app_id: APP });
    expect(out.releases.map((r: any) => r.version)).toEqual(['1.2.0', '1.1.0']);
    expect(out.releases[0]).toMatchObject({ description: 'Fixes the pump start', problem: 'The binary is not in the bucket.' });
    expect(out.controllers.versions).toEqual([{ version: '1.2.0', count: 1 }, { version: '1.1.0', count: 1 }]);
    expect(out.public_key).toEqual({ source: 'generated', created_at: '2026-10-01T00:00:00Z', created_by: 'jane.doe@gocontroll.com' });
    expect(out.downloads).toEqual({ configured: false });
    expect((await call('application', { app_id: LINUX })).linux_versions).toEqual([{ version: '2.0.0', released: expect.any(String), description: 'Linux', size: 1000 }]);
  });

  test('rollout: who is behind, with the versions they run', async () => {
    const out = await call('rollout');
    const app = out.items.find((i: any) => i.app_id === APP);
    expect(app).toMatchObject({ latest: '1.2.0', controllers: 2, up_to_date: 1, behind: 1, customer: 'Acme Pumps' });
    expect(app.versions).toEqual([{ version: '1.2.0', count: 1 }, { version: '1.1.0', count: 1 }]);
  });

  test('module_firmware and its history: latest_firmware, dates as YYYY-MM-DD, who published, without the local path', async () => {
    const out = await call('module_firmware', { search: 'test input' });
    expect(out.items).toEqual([{
      id: MOD, name: 'Test Input module', hardware_version: '1.01', latest_firmware: '1.1.0', releases: 2,
      newest_release: { version: '1.0.0', date: '2026-10-28', published_by: 'jane.doe@gocontroll.com' }, url: 'https://deploy.gocontroll.tools/#/firmware',
    }]);
    const history = await call('module_firmware_releases', { hw_id: MOD });
    expect(history.items).toEqual([
      { version: '1.0.0', date: '2026-10-28', changelog: 'Older', published_by: 'jane.doe@gocontroll.com', published_at: '2026-10-28T10:00:00Z', repo: 'Module-Test', commit: 'aaaaaaaaaaaa', tag: 'v1.0.0' },
      { version: '0.9.0', date: '2026-09-01', changelog: 'First', published_by: 'CI', published_at: null, repo: null, commit: null, tag: null },
    ]);
  });

  test('firmware_repos: off without a token; with one, the commits GitHub has after the publish, asked once in 5 minutes', async () => {
    expect(await call('firmware_repos')).toEqual({ configured: false, note: 'GitHub is not set up (DEPLOY_GITHUB_TOKEN).' });
    const github = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/repos/GOcontroll/Module-Test')) return Response.json({ default_branch: 'main', permissions: { push: true } });
      if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: 'b'.repeat(40), commit: { message: 'Add a filter\n\nbody', committer: { date: '2026-10-29T08:00:00Z' } } } });
      if (url.includes('/compare/')) return Response.json({ status: 'ahead', ahead_by: 3, behind_by: 0 });
      throw new Error(`unexpected fetch ${url}`);
    });
    const tool = TOOLS.find((t) => t.name === 'firmware_repos')!;
    const withToken = { ...env, GITHUB_TOKEN: 'TOKEN-OF-GITHUB', GITHUB_REPOS: 'GOcontroll/Module-*' } as typeof env;
    const out = await tool.run(withToken, {}, ACTOR) as any;
    expect(out.configured).toBe(true);
    expect(out.items).toEqual([{
      repo: 'GOcontroll/Module-Test', branch: 'main', published: { module: MOD, version: '1.0.0', at: '2026-10-28T10:00:00Z', commit: 'aaaaaaaaaaaa' },
      state: 'github-newer', commits_after_publish: 3, newest_commit: { date: '2026-10-29T08:00:00Z', subject: 'Add a filter' },
    }]);
    expect(json(out)).not.toContain('TOKEN-OF-GITHUB');

    // A loop asks GitHub once: the answer is kept, in the state bucket, without the token.
    const calls = github.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(await tool.run(withToken, {}, ACTOR)).toEqual(out);
    expect(await tool.run(withToken, {}, ACTOR)).toEqual(out);
    expect(github.mock.calls.length).toBe(calls);
    const stored = await (await env.STATE.get('cache/firmware-repos.json'))!.text();
    expect(stored).not.toContain('TOKEN-OF-GITHUB');

    // Without a token the cache says nothing; after 5 minutes GitHub is asked again.
    expect(await call('firmware_repos')).toEqual({ configured: false, note: 'GitHub is not set up (DEPLOY_GITHUB_TOKEN).' });
    await env.STATE.put('cache/firmware-repos.json', json({ ...out, checked_at: iso(Date.now() - 5 * 60 * 1000 - 1000) }));
    await tool.run(withToken, {}, ACTOR);
    expect(github.mock.calls.length).toBe(calls * 2);

    // A cache that cannot be read is no cache.
    await env.STATE.put('cache/firmware-repos.json', 'not json');
    expect((await tool.run(withToken, {}, ACTOR) as any).configured).toBe(true);
    expect(github.mock.calls.length).toBe(calls * 3);
  });

  test('images: per system the latest published release with its downloads, and the drafts', async () => {
    const out = await call('images');
    const l4 = out.items.find((i: any) => i.controller === 'L4' && !i.type);
    expect(l4.latest).toMatchObject({ version: '6.12.87', files: 1, bytes: 2048, complete_image: true, downloads: 2, published_by: 'jane.doe@gocontroll.com' });
    const hmi = out.items.find((i: any) => i.type === '1.07 - AV123');
    expect(hmi).toMatchObject({ name: 'Moduline HMI1 · 1.07 - AV123', latest: null, published: 0 });
    expect(hmi.drafts.map((d: any) => d.version)).toEqual(['6.12.80']);
    expect(out.uploads_under_way).toBe(1);
  });

  test('image_downloads: per month, country and release, numbers only', async () => {
    const out = await call('image_downloads', { months: 1 });
    expect(out.months).toHaveLength(1);
    expect(out.months[0]).toMatchObject({ downloads: 2, different_addresses: 1, complete: false, countries: { NL: 1, unknown: 1 } });
    expect(out.months[0].releases).toEqual([{ release: 'Moduline L4 6.12.87', downloads: 2 }]);
    expect(out.releases[0]).toMatchObject({ release: 'Moduline L4 6.12.87', total: 2, this_month: 2 });
  });

  test('application_downloads: says it is off without the token, sums per application with it', async () => {
    expect((await call('application_downloads')).configured).toBe(false);
    const day = iso(Date.now() - 2 * DAY).slice(0, 10);
    await env.STATE.put(`downloads/${day}.json`, json({ day, fetched_at: iso(Date.now()), apps: { [APP]: { downloads: 5, headerReads: 7, manifestReads: 9, bins: { [`${APP}-1.2.0.bin`]: 5 } } } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/zones?')) return Response.json({ success: true, result: [{ id: 'zone' }] });
      return Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } }, errors: null });
    });
    const tool = TOOLS.find((t) => t.name === 'application_downloads')!;
    const out = await tool.run({ ...env, CF_API_TOKEN: 'test-cf-token' } as typeof env, { days: 3 }, ACTOR) as any;
    expect(out).toMatchObject({ configured: true, days: 3, total: 1 });
    expect(out.items[0]).toEqual({ app_id: APP, downloads: 5, header_reads: 7, manifest_reads: 9, files: [{ file: `${APP}-1.2.0.bin`, downloads: 5 }] });
  });

  test('recent_publications: what was published and by whom, newest first; labels for images; everything on request', async () => {
    const out = await call('recent_publications');
    expect(out.items.map((i: any) => [i.action, i.subject, i.version])).toEqual([
      ['publish', APP, '1.2.0'],
      ['images-publish', 'Moduline L4 6.12.87', undefined],
    ]);
    expect(out.items[0]).toMatchObject({ by: 'jane.doe@gocontroll.com', signed: true, replaced: false, description: 'Fixes the pump start' });
    expect((await call('recent_publications', { all: true })).items.map((i: any) => i.action)).toContain('settings');
    const old = iso(Date.now() - 40 * DAY).slice(0, 10);
    expect((await call('recent_publications', { from: old, to: old })).items.map((i: any) => i.version)).toEqual(['1.1.0']);
    expect(await call('recent_publications', { from: '2020-01-01', to: '2026-10-30' })).toEqual({ error: 'Ask for at most 24 months.' });
    expect(await call('recent_publications', { from: '2026-02-01', to: '2026-01-01' })).toEqual({ error: 'from must not be after to.' });
  });

  test('customer: the applications of a relation, or none', async () => {
    const out = await call('customer', { relation_id: acme });
    expect(out).toMatchObject({ relation_id: acme, name: 'Acme Pumps', controllers: 2 });
    expect(out.applications.map((a: any) => a.app_id)).toEqual([APP]);
    expect(await call('customer', { relation_id: 999999 })).toEqual({ none: true });
  });

  test('attention: what to do, without any external call', async () => {
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no external call'));
    const tool = TOOLS.find((t) => t.name === 'attention')!;
    const { items } = await tool.run({ ...env, GITHUB_TOKEN: 'not-set' } as typeof env, {}, ACTOR) as any;
    const lines = items.map((i: any) => `${i.severity}: ${i.title}`);
    expect(lines).toContain('high: Deleting STUCKAPP did not finish');
    expect(lines).toContain(`medium: Module ${MOD} Test Input module: latest_firmware is 1.1.0, its first release 1.0.0`);
    expect(lines).toContain('medium: The upload of big.zip did not finish');
    expect(lines).toContain('low: Moduline HMI1 · 1.07 - AV123 6.12.80 is still a draft');
    expect(lines).toContain('low: 1 signing key of before 0.7.0 still sealed in Deploy');
    expect(lines).toContain('low: Download counts of S1 applications are off');
    expect(lines).toContain('low: Deploy cannot tag or release on GitHub');
    expect(lines.some((l: string) => /^low: \d+ controllers? of \d+ applications? not on the latest release$/.test(l))).toBe(true);
    expect(items.find((i: any) => /big\.zip/.test(i.title)).due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(external).not.toHaveBeenCalled();
    for (const i of items) expect(['high', 'medium', 'low']).toContain(i.severity);
  });

  test('attention: a published release that is not in the catalogue', async () => {
    await env.STATE.put('images/releases/moduline-m1/gone00000000.json', json({
      controller: 'M1', type: '', version: '6.12.1', released: '2026-10-29', notes: '', status: 'published', files: [], created_at: '2026-10-29T09:00:00Z', created_by: 'x', updated_at: '2026-10-29T09:00:00Z', updated_by: 'x',
    }));
    const { items } = await call('attention');
    expect(items.map((i: any) => i.title)).toContain('Moduline M1 6.12.1 is published but not in the catalogue');
    await env.STATE.delete('images/releases/moduline-m1/gone00000000.json');
  });
});

describe('the backup', () => {
  test('no databases: the state bucket, whole but for uploads under way, and every skipped store with its reason', async () => {
    const plan = await api().exportPlan('deploy', true);
    expect(plan.databases).toEqual([]);
    expect(plan.stores.map((s) => s.name)).toEqual(['gocontroll-deploy-state']);
    expect(plan.stores[0].files).toBeGreaterThan(5);
    expect(plan.stores[0].bytes).toBeGreaterThan(0);
    const what = plan.skipped.map((s) => s.what);
    expect(what).toEqual(expect.arrayContaining(['gocontroll-deploy', 'gocontroll-firmware', 'gocontroll-images', 'gocontroll-images/downloads/', 'gocontroll-deploy-state/images/uploads/', 'gocontroll-deploy-state/cache/']));
    for (const s of plan.skipped) expect(s.reason.length).toBeGreaterThan(10);
    expect(plan.skipped.find((s) => s.what === 'gocontroll-images/downloads/')?.reason).toMatch(/e-mail/);
  });

  test('without files the plan names the store as not selected', async () => {
    const plan = await api().exportPlan('deploy', false);
    expect(plan.stores).toEqual([]);
    expect(plan.skipped.some((s) => s.what === 'gocontroll-deploy-state' && /not selected/.test(s.reason))).toBe(true);
  });

  test('exportRows is an AdminError: there are no databases', async () => {
    await expect(api().exportRows('deploy', 'gocontroll-deploy-state', 'x', null, 10)).rejects.toThrow('Unknown database');
    expect(() => exportScope(env, 'finance')).toThrow(AdminError);
  });

  test('every file can be listed and read; the sealed key goes as it is, an upload under way does not', async () => {
    const entry = api();
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const pageOf: { files: { key: string; size: number }[]; cursor: string | null } = await entry.exportFiles('deploy', 'gocontroll-deploy-state', cursor);
      keys.push(...pageOf.files.map((f) => f.key));
      cursor = pageOf.cursor;
    } while (cursor);
    expect(keys).toEqual(expect.arrayContaining([`keys/${APP}.json`, `folders/${APP}.json`, 'images/releases/moduline-l4/abc123def456.json', 'deleting/STUCKAPP.json']));
    expect(keys.filter((k) => k.startsWith('images/uploads/') || k.startsWith('cache/'))).toEqual([]);
    const body = await new Response(await entry.exportFile('deploy', 'gocontroll-deploy-state', `keys/${APP}.json`)).text();
    expect(JSON.parse(body).sealed_private_key).toBe(SEALED);
    await expect(entry.exportFile('deploy', 'gocontroll-deploy-state', 'images/uploads/aaaabbbbccccddddaaaabbbbccccdddd.json')).rejects.toThrow('Not part of the backup');
    await expect(entry.exportFile('deploy', 'gocontroll-deploy-state', 'keys/none.json')).rejects.toThrow('File is gone');
    await expect(entry.exportFiles('deploy', 'gocontroll-images', null)).rejects.toThrow('Unknown store');
    await expect(entry.exportPlan('suppliers', false)).rejects.toThrow('Unknown scope');
  });
});
