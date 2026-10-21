// Download counts (src/downloads.ts): Cloudflare's GraphQL Analytics, mocked. Finished days
// are stored in STATE the first time someone looks, at most 7 per request; today is live.

import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { dayCounts, lastDays, loadWindow, resetDownloadCaches, tally, type AppDay } from '../src/downloads';
import worker from '../src/index';
import { appId, ok, upload, zlibPayload } from './helpers';

const TOKEN = 'test-cf-token';
const DAY = 24 * 60 * 60 * 1000;

interface Mock { graphql: { zoneTag: string; from: string; to: string; hosts: string[] }[]; zones: string[] }

/** Cloudflare's API on fetch: two zones, and per day per zone the groups of `groups(day)`. */
function mockCloudflare(groups: (day: string) => { path: string; status: number; count: number }[] | { error: string }): Mock {
  const mock: Mock = { graphql: [], zones: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.host !== 'api.cloudflare.com') throw new Error(`unexpected fetch ${req.url}`);
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return Response.json({ success: false, errors: [{ message: 'auth' }] }, { status: 403 });
    if (url.pathname === '/client/v4/zones') {
      const name = url.searchParams.get('name')!;
      mock.zones.push(name);
      return Response.json({ success: true, result: [{ id: `zone-${name}` }] });
    }
    if (url.pathname === '/client/v4/graphql') {
      const { variables } = await req.json<any>();
      const f = variables.filter;
      mock.graphql.push({ zoneTag: variables.zoneTag, from: f.datetime_geq, to: f.datetime_lt, hosts: f.clientRequestHTTPHost_in });
      expect(f).toMatchObject({ requestSource: 'eyeball', clientRequestHTTPMethodName: 'GET' });
      const answer = groups(f.datetime_geq.slice(0, 10));
      if ('error' in answer) return Response.json({ data: null, errors: [{ message: answer.error }] });
      return Response.json({
        data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: answer.map((g) => ({ count: g.count, dimensions: { clientRequestPath: g.path, edgeResponseStatus: g.status } })) }] } },
        errors: null,
      });
    }
    return new Response('not found', { status: 404 });
  });
  return mock;
}

const groupsFor = (id: string) => () => [
  { path: `/${id}/${id}-1.0.0.bin`, status: 200, count: 3 },
  { path: `/${id}/${id}-1.0.0.bin`, status: 206, count: 5 },
  { path: `/${id}/manifest.json`, status: 200, count: 2 },
  { path: `/${id}/manifest.json`, status: 304, count: 1 },
  { path: `/${id}/v1.0.0/update.tar.gz`, status: 200, count: 9 },   // a Linux tarball: not counted
  { path: '/stray.bin', status: 200, count: 4 },                     // not in a folder
];

beforeEach(() => resetDownloadCaches());
afterEach(() => vi.restoreAllMocks());

test('tally: downloads, header reads and manifest reads per App ID and file', () => {
  const apps: Record<string, AppDay> = {};
  for (const g of groupsFor('GOCO')()) tally(apps, g.path, g.status, g.count);
  tally(apps, '/GOCO/GOCO-1.0.0.bin', 404, 7);
  expect(apps).toEqual({ GOCO: { downloads: 3, headerReads: 5, manifestReads: 3, bins: { 'GOCO-1.0.0.bin': 3 } } });
});

/** Run the daily cron of wrangler.toml at `when` with these bindings. */
async function runCron(when: string, bindings: typeof env) {
  const ctx = createExecutionContext();
  await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse(when), cron: '17 2 * * *' }), bindings, ctx);
  await waitOnExecutionContext(ctx);
}

test('the daily cron without a token does nothing and calls nothing', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  await runCron('2035-02-10T02:17:00Z', env);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect((await env.STATE.list({ prefix: 'downloads/2035-' })).objects).toEqual([]);
});

test('without a token: configured false and no call at all', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  expect(await ok('GET', '/api/downloads')).toEqual({ configured: false, days: [] });
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('with a token', () => {
  const withToken = { ...env, CF_API_TOKEN: TOKEN } as typeof env;

  test('7 missing days per request, newest first, stored; today live and never stored', async () => {
    const id = appId('D');
    const now = Date.parse('2031-03-15T12:00:00Z');
    const mock = mockCloudflare(groupsFor(id));
    const first = await loadWindow(withToken, 30, now);
    // 7 stored days + today, each over two zones.
    expect(mock.graphql.length).toBe(16);
    expect(new Set(mock.graphql.map((g) => g.zoneTag))).toEqual(new Set(['zone-gocontroll.com', 'zone-gocontroll.tech']));
    expect(mock.graphql.find((g) => g.zoneTag === 'zone-gocontroll.com')!.hosts).toEqual(['deploy.gocontroll.com']);
    expect(mock.zones.sort()).toEqual(['gocontroll.com', 'gocontroll.tech']);
    expect(first.known.map((d) => d.day)).toEqual([
      '2031-03-08', '2031-03-09', '2031-03-10', '2031-03-11', '2031-03-12', '2031-03-13', '2031-03-14', '2031-03-15',
    ]);
    expect(first.missingDays).toBe(22);
    // The API answers every day of the window; one not fetched yet says so.
    const days = dayCounts(first, id);
    expect(days.length).toBe(30);
    expect(days[0]).toEqual({ day: '2031-02-14', downloads: null, headerReads: null, manifestReads: null, pending: true });
    expect(days[29]).toEqual({ day: '2031-03-15', downloads: 6, headerReads: 10, manifestReads: 6 });
    expect(await env.STATE.head('downloads/2031-03-14.json')).not.toBeNull();
    expect(await env.STATE.head('downloads/2031-03-15.json')).toBeNull();
    expect(first.known[0].apps![id]).toEqual({ downloads: 6, headerReads: 10, manifestReads: 6, bins: { [`${id}-1.0.0.bin`]: 6 } });
    expect(lastDays(first, 7, now)).toBe(42);

    mock.graphql.length = 0;
    const second = await loadWindow(withToken, 30, now);
    expect(mock.graphql.length).toBe(16); // the next 7 days + today; the stored ones are read back
    expect(second.known.length).toBe(15);
    expect(mock.graphql.map((g) => g.from.slice(0, 10)).filter((d) => d < '2031-03-08').sort()[0]).toBe('2031-03-01');
  });

  test('the daily cron stores the missing finished days (7 per run, newest first), never today', async () => {
    const id = appId('C');
    const mock = mockCloudflare(groupsFor(id));
    await runCron('2036-07-20T02:17:00Z', withToken);
    const days = [...new Set(mock.graphql.map((g) => g.from.slice(0, 10)))].sort();
    expect(days).toEqual(['2036-07-13', '2036-07-14', '2036-07-15', '2036-07-16', '2036-07-17', '2036-07-18', '2036-07-19']);
    expect(mock.graphql.length).toBe(14); // two zones per day, nothing for today
    expect(await env.STATE.head('downloads/2036-07-19.json')).not.toBeNull();
    expect(await env.STATE.head('downloads/2036-07-20.json')).toBeNull();

    // The next run takes the next 7; what a run stored, a look reads back without fetching it.
    mock.graphql.length = 0;
    await runCron('2036-07-20T03:00:00Z', withToken);
    expect([...new Set(mock.graphql.map((g) => g.from.slice(0, 10)))].sort()[0]).toBe('2036-07-06');
    mock.graphql.length = 0;
    const look = await loadWindow(withToken, 7, Date.parse('2036-07-20T12:00:00Z'));
    expect(mock.graphql.map((g) => g.from.slice(0, 10))).toEqual(['2036-07-20', '2036-07-20']); // only today, live
    expect(look.known.length).toBe(7);
  });

  test('a day the API refuses as too old is stored as unavailable; other errors are shown, not stored', async () => {
    const now = Date.parse('2032-06-20T12:00:00Z');
    mockCloudflare((day) => (day < '2032-06-17' ? { error: 'cannot request data older than 3 days' } : []));
    const w = await loadWindow(withToken, 10, now);
    expect(w.error).toBeUndefined();
    expect(JSON.parse(await (await env.STATE.get('downloads/2032-06-15.json'))!.text())).toMatchObject({ unavailable: true });
    expect(w.known.map((d) => d.day)).toEqual(['2032-06-17', '2032-06-18', '2032-06-19', '2032-06-20']);
    const days = dayCounts(w);
    expect(days.find((d) => d.day === '2032-06-15')).toEqual({ day: '2032-06-15', downloads: null, headerReads: null, manifestReads: null, unavailable: true });
    expect(days.find((d) => d.day === '2032-06-11')).toMatchObject({ downloads: null, pending: true });
    expect(lastDays(w, 10, now)).toBe(0);

    vi.restoreAllMocks();
    resetDownloadCaches();
    mockCloudflare(() => ({ error: 'not authorized for that zone' }));
    const broken = await loadWindow(withToken, 3, Date.parse('2033-01-10T12:00:00Z'));
    expect(broken.error).toMatch(/not authorized/);
    expect(await env.STATE.head('downloads/2033-01-09.json')).toBeNull();
  });

  test('the folder page counts downloads per release; the overview sums the last 7 and 30 days', async () => {
    const id = appId('D');
    const { payload, rawSize } = await zlibPayload();
    expect((await upload('/api/releases', { appId: id, version: '1.0.0', description: 'x', payload, rawSize: String(rawSize) })).status).toBe(200);
    mockCloudflare(groupsFor(id));
    const folder = await ok('GET', `/api/folders/${id}`, undefined, 200, { CF_API_TOKEN: TOKEN });
    expect(folder.downloads.configured).toBe(true);
    expect(folder.downloads.days.length).toBe(30);
    const known = folder.downloads.days.filter((d: any) => d.downloads !== null);
    expect(known.length).toBeGreaterThanOrEqual(8);
    expect(known[0]).toMatchObject({ downloads: 6, headerReads: 10, manifestReads: 6 });
    expect(folder.releases[0].downloads).toBe(6 * known.length);

    const overview = await ok('GET', '/api/overview', undefined, 200, { CF_API_TOKEN: TOKEN });
    expect(overview.downloads.configured).toBe(true);
    expect(overview.downloads.last7).toBeGreaterThanOrEqual(42);
    expect(overview.downloads.last30).toBeGreaterThanOrEqual(overview.downloads.last7);

    const api = await ok('GET', `/api/downloads?appId=${id}&days=7`, undefined, 200, { CF_API_TOKEN: TOKEN });
    expect(api.days.length).toBe(7);
    expect((await ok('GET', '/api/downloads?days=0', undefined, 400, { CF_API_TOKEN: TOKEN })).field).toBe('days');
  });
});
