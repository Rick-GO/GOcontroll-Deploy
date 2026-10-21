// Download counts of the distribution hosts, from Cloudflare's GraphQL Analytics API
// (httpRequestsAdaptiveGroups, per zone: gocontroll.com, gocontroll.tech). Only with the
// Secrets Store binding CF_API_TOKEN (store DEPLOY_CF_API_TOKEN, Zone Analytics: Read + Zone:
// Read); without it nothing is called and the answer says `configured: false`.
//
// Per UTC day, per App ID:
//   download     GET <APP_ID>/<file>.bin answered 200 (per file as well)
//   header read  GET <APP_ID>/<file>.bin answered 206 (a range read of the header)
//   manifest     GET <APP_ID>/manifest.json answered 200 or 304
// Counts are Cloudflare's sample-based estimates: approximate.
//
// Cloudflare keeps these analytics only briefly, so a finished day is stored in STATE as
// downloads/<yyyy-mm-dd>.json: by the daily cron (collectMissingDays, wrangler.toml
// [triggers]) and the first time someone looks, whichever comes first. At most MAX_FETCH_DAYS
// missing days are fetched per request or run, newest first; a day the API refuses as too old
// is stored as { unavailable: true }; today (and a day that ended less than an hour ago) is
// always fetched live and never stored.

import type { Env } from './env';
import { configList } from './auth';
import { readSecret } from './lib/secret';
import { readJson, writeJson } from './state';

const API = 'https://api.cloudflare.com/client/v4';
const MAX_FETCH_DAYS = 7;
/** The window the cron keeps filled: the overview's 30 days. */
export const CRON_WINDOW_DAYS = 30;
const SETTLE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AppDay { downloads: number; headerReads: number; manifestReads: number; bins: Record<string, number> }
export interface StoredDay { day: string; fetched_at: string; unavailable?: true; apps?: Record<string, AppDay> }
/**
 * One day as the API answers it. A day without counts has nulls and says why: `unavailable`
 * (Cloudflare no longer has it) or `pending` (not fetched yet: the next look fetches more).
 */
export interface DayCounts {
  day: string;
  downloads: number | null;
  headerReads: number | null;
  manifestReads: number | null;
  unavailable?: true;
  pending?: true;
}

export interface DownloadWindow {
  configured: boolean;
  error?: string;
  known: StoredDay[];                                  // days with counts (stored, fetched now, or today live), oldest first
  unknown: { day: string; unavailable: boolean }[];    // days without counts, oldest first
  missingDays: number;                                 // = unknown.length
  fetched: number;                                     // finished days fetched and stored by this call
}

export class AnalyticsError extends Error {
  constructor(message: string, readonly tooOld = false) { super(message); }
}

const zoneIds = new Map<string, string>(); // zone name → id, per isolate

/** For tests. */
export function resetDownloadCaches(): void { zoneIds.clear(); }

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * The counts of the last `days` UTC days (today included), as far as they can be had. Missing
 * finished days are fetched and stored (at most MAX_FETCH_DAYS); with `live: false` today is
 * not fetched (the cron stores, it shows nothing).
 */
export async function loadWindow(env: Env, days: number, now = Date.now(), { live: fetchLive = true }: { live?: boolean } = {}): Promise<DownloadWindow> {
  let token: string | undefined;
  try {
    token = await readSecret(env.CF_API_TOKEN);
  } catch {
    return { configured: true, error: 'The Cloudflare API token could not be read from the Secrets Store.', known: [], unknown: [], missingDays: days, fetched: 0 };
  }
  if (!token) return { configured: false, known: [], unknown: [], missingDays: 0, fetched: 0 };

  const today = isoDay(now);
  const window: string[] = [];
  for (let i = days - 1; i >= 0; i--) window.push(isoDay(dayStart(today) - i * DAY_MS));
  const settled = (day: string) => dayStart(day) + DAY_MS <= now - SETTLE_MS;

  const stored = new Map<string, StoredDay>();
  await Promise.all(window.filter(settled).map(async (day) => {
    const hit = await readJson<StoredDay>(env.STATE, `downloads/${day}.json`).catch(() => null);
    if (hit) stored.set(day, hit.value);
  }));

  let error: string | undefined;
  let fetched = 0;
  const client = analytics(env, token);
  const missing = window.filter((d) => settled(d) && !stored.has(d)).reverse().slice(0, MAX_FETCH_DAYS);
  for (const day of missing) {
    try {
      const counts = await client.day(day, dayStart(day) + DAY_MS);
      const value: StoredDay = { day, fetched_at: new Date(now).toISOString(), apps: counts };
      await writeJson(env.STATE, `downloads/${day}.json`, value);
      stored.set(day, value);
      fetched++;
    } catch (err) {
      // Only a day well in the past can be "too old"; anything else is an error to show.
      if (err instanceof AnalyticsError && err.tooOld && dayStart(day) + 2 * DAY_MS <= now) {
        const value: StoredDay = { day, fetched_at: new Date(now).toISOString(), unavailable: true };
        await writeJson(env.STATE, `downloads/${day}.json`, value);
        stored.set(day, value);
        fetched++;
        continue;
      }
      error = err instanceof AnalyticsError ? err.message : 'The download counts could not be fetched from Cloudflare.';
      if (!(err instanceof AnalyticsError)) console.error(err);
      break;
    }
  }

  // Today, and a day too recent to store: live.
  const live = new Map<string, StoredDay>();
  if (!error && fetchLive) {
    for (const day of window.filter((d) => !settled(d))) {
      try {
        live.set(day, { day, fetched_at: new Date(now).toISOString(), apps: await client.day(day, Math.min(dayStart(day) + DAY_MS, now)) });
      } catch (err) {
        error = err instanceof AnalyticsError ? err.message : 'The download counts could not be fetched from Cloudflare.';
        break;
      }
    }
  }

  const known: StoredDay[] = [];
  const unknown: DownloadWindow['unknown'] = [];
  for (const day of window) {
    const d = stored.get(day) ?? live.get(day);
    if (d && !d.unavailable) known.push(d);
    else unknown.push({ day, unavailable: Boolean(d?.unavailable) });
  }
  return { configured: true, ...(error ? { error } : {}), known, unknown, missingDays: unknown.length, fetched };
}

/**
 * The daily cron (wrangler.toml [triggers]): fetch and store the finished days of the last
 * CRON_WINDOW_DAYS that are still missing, at most MAX_FETCH_DAYS per run, as a look does.
 * Without CF_API_TOKEN nothing is called.
 */
export async function collectMissingDays(env: Env, now = Date.now()): Promise<DownloadWindow> {
  return loadWindow(env, CRON_WINDOW_DAYS, now, { live: false });
}

/** Every day of the window, oldest first: the counts of one App ID, or of every App ID together. */
export function dayCounts(window: DownloadWindow, appId?: string): DayCounts[] {
  const known: DayCounts[] = window.known.map((d) => {
    const apps = Object.entries(d.apps ?? {}).filter(([id]) => appId === undefined || id === appId).map(([, a]) => a);
    return {
      day: d.day,
      downloads: apps.reduce((n, a) => n + a.downloads, 0),
      headerReads: apps.reduce((n, a) => n + a.headerReads, 0),
      manifestReads: apps.reduce((n, a) => n + a.manifestReads, 0),
    };
  });
  const unknown: DayCounts[] = window.unknown.map((u) => ({
    day: u.day, downloads: null, headerReads: null, manifestReads: null, ...(u.unavailable ? { unavailable: true as const } : { pending: true as const }),
  }));
  return [...known, ...unknown].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Downloads per file name of one App ID over the window. */
export function fileDownloads(window: DownloadWindow, appId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of window.known) {
    for (const [file, n] of Object.entries(d.apps?.[appId]?.bins ?? {})) out.set(file, (out.get(file) ?? 0) + n);
  }
  return out;
}

/** Sum of downloads over the last `n` days of the window; null when none of them is known. */
export function lastDays(window: DownloadWindow, n: number, now = Date.now()): number | null {
  const from = isoDay(dayStart(isoDay(now)) - (n - 1) * DAY_MS);
  const days = dayCounts(window).filter((d) => d.day >= from && d.downloads !== null);
  return days.length ? days.reduce((s, d) => s + (d.downloads ?? 0), 0) : null;
}

// ── Cloudflare GraphQL ───────────────────────────────────────────────────────

const QUERY = `query DeployDownloads($zoneTag: string, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(limit: 10000, filter: $filter) {
        count
        dimensions { clientRequestPath edgeResponseStatus }
      }
    }
  }
}`;

const TOO_OLD = /older than|too old|retention|out of (the )?(allowed )?range|before .*limit/i;

/** The zone of a hostname: its last two labels (deploy.gocontroll.com → gocontroll.com). */
export const zoneOf = (host: string) => host.split('.').slice(-2).join('.');

function analytics(env: Env, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const byZone = new Map<string, string[]>();
  for (const host of configList(env.DOWNLOAD_HOSTS).map((h) => h.toLowerCase())) {
    const zone = zoneOf(host);
    byZone.set(zone, [...(byZone.get(zone) ?? []), host]);
  }

  async function zoneId(zone: string): Promise<string> {
    const hit = zoneIds.get(zone);
    if (hit) return hit;
    const res = await fetch(`${API}/zones?name=${encodeURIComponent(zone)}`, { headers });
    const body = await res.json<any>().catch(() => null);
    if (!res.ok || !body?.success) throw new AnalyticsError(`Cloudflare refused the zone lookup of ${zone} (HTTP ${res.status}): check the token's Zone: Read permission.`);
    const id = body.result?.[0]?.id;
    if (typeof id !== 'string') throw new AnalyticsError(`The Cloudflare API token has no access to the zone ${zone}.`);
    zoneIds.set(zone, id);
    return id;
  }

  return {
    /** Counts per App ID of [day 00:00, end) over every zone. */
    async day(day: string, endMs: number): Promise<Record<string, AppDay>> {
      const apps: Record<string, AppDay> = {};
      for (const [zone, hosts] of byZone) {
        const zoneTag = await zoneId(zone);
        const res = await fetch(`${API}/graphql`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: QUERY,
            variables: {
              zoneTag,
              filter: {
                datetime_geq: `${day}T00:00:00Z`,
                datetime_lt: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
                clientRequestHTTPHost_in: hosts,
                clientRequestHTTPMethodName: 'GET',
                requestSource: 'eyeball',
              },
            },
          }),
        });
        const body = await res.json<any>().catch(() => null);
        const errors: { message?: string }[] = Array.isArray(body?.errors) ? body.errors : [];
        if (errors.length) {
          const message = errors.map((e) => e?.message || 'unknown error').join('; ');
          throw new AnalyticsError(`Cloudflare Analytics refused the counts of ${day}: ${message}`, TOO_OLD.test(message));
        }
        if (!res.ok || !body?.data) throw new AnalyticsError(`Cloudflare Analytics answered HTTP ${res.status}: check the token's Analytics: Read permission.`);
        for (const group of body.data.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? []) {
          tally(apps, String(group?.dimensions?.clientRequestPath ?? ''), Number(group?.dimensions?.edgeResponseStatus), Number(group?.count) || 0);
        }
      }
      return apps;
    },
  };
}

/** Add one group (path, status, count) to the counts per App ID. */
export function tally(apps: Record<string, AppDay>, path: string, status: number, count: number): void {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== '' || !parts[1] || !parts[2]) return;
  let appId: string;
  let file: string;
  try {
    appId = decodeURIComponent(parts[1]);
    file = decodeURIComponent(parts[2]);
  } catch {
    return;
  }
  const isBin = file.endsWith('.bin');
  const isManifest = file === 'manifest.json';
  if (!isBin && !isManifest) return;
  const a = (apps[appId] ??= { downloads: 0, headerReads: 0, manifestReads: 0, bins: {} });
  if (isBin && status === 200) {
    a.downloads += count;
    a.bins[file] = (a.bins[file] ?? 0) + count;
  } else if (isBin && status === 206) {
    a.headerReads += count;
  } else if (isManifest && (status === 200 || status === 304)) {
    a.manifestReads += count;
  }
}
