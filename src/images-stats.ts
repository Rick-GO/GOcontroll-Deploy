// How often the images and tools of images.gocontroll.tech are downloaded, per month, per release and
// per file, for the Images tab.
//
// The source is the download log in the images bucket (downloads/<yyyy>/<mm>/…, one empty object per
// download with DownloadMeta as custom metadata, src/images-format.ts). That log holds an e-mail
// address per download and expires after 13 months (R2 lifecycle rule). So every finished month is
// summed once into STATE images/stats/<yyyy-mm>.json, without any address (the number of different
// addresses only), and kept: the totals outlive the log. The month under way is counted live from the
// log on every look. Finished months are stored by the daily cron and when someone looks, at most
// MONTHS_PER_RUN per run, like the S1 download days (src/downloads.ts).

import type { Env } from './env';
import { DOWNLOAD_LOG_PREFIX, type DownloadMeta } from './images-format';
import { listAll, readJson, writeJson } from './state';

export const STATS_PREFIX = 'images/stats/';
const MONTHS_PER_RUN = 6;

/** The downloads of one month. Keys of `releases`: `<kind>/<product>/<version>`; of `countries`: ISO code, '' = unknown. */
export interface MonthStats {
  month: string;                     // YYYY-MM (UTC)
  downloads: number;
  addresses: number;                 // different e-mail addresses
  releases: Record<string, number>;
  files: Record<string, number>;
  countries: Record<string, number>;
  final: boolean;                    // stored after the month ended; false = the month under way, counted live
}

export interface ReleaseTotal { release: string; total: number; thisMonth: number; lastMonth: number }

export interface ImagesStats {
  month: string;                     // the month under way (YYYY-MM, UTC)
  months: MonthStats[];              // newest first: the month under way (and last month in its first hour), then the stored ones
  releases: ReleaseTotal[];          // all time, most downloaded first
  total: number;                     // all time
  error?: string;                    // stats could not be read (the rest of the tab still works)
}

/** "2026-10" of a moment (UTC). */
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(Date.UTC(y, m - 2, 1)));
};
const logPrefix = (month: string) => `${DOWNLOAD_LOG_PREFIX}${month.slice(0, 4)}/${month.slice(5, 7)}/`;

/** The download log of one month, as DownloadMeta per download. */
async function monthLog(env: Env, month: string): Promise<Partial<DownloadMeta>[]> {
  const objects = await listAll(env.IMAGES_BUCKET, { prefix: logPrefix(month), include: ['customMetadata'] });
  return objects.map((o) => (o.customMetadata ?? {}) as Partial<DownloadMeta>);
}

const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

/** Sum a month's log; pure. */
export function summarise(month: string, log: Partial<DownloadMeta>[], final: boolean): MonthStats {
  const out: MonthStats = { month, downloads: 0, addresses: 0, releases: {}, files: {}, countries: {}, final };
  const addresses = new Set<string>();
  for (const d of log) {
    out.downloads++;
    if (d.email) addresses.add(d.email.toLowerCase());
    if (d.kind && d.product && d.version) bump(out.releases, `${d.kind}/${d.product}/${d.version}`);
    if (d.path) bump(out.files, d.path);
    bump(out.countries, d.country ?? '');
  }
  out.addresses = addresses.size;
  return out;
}

/** The months that have a download log (YYYY-MM), oldest first. */
async function loggedMonths(env: Env): Promise<string[]> {
  const years = (await env.IMAGES_BUCKET.list({ prefix: DOWNLOAD_LOG_PREFIX, delimiter: '/' })).delimitedPrefixes;
  const months: string[] = [];
  for (const year of years) {
    const listed = await env.IMAGES_BUCKET.list({ prefix: year, delimiter: '/' });
    for (const p of listed.delimitedPrefixes) {
      const m = /^downloads\/(\d{4})\/(\d{2})\/$/.exec(p);
      if (m) months.push(`${m[1]}-${m[2]}`);
    }
  }
  return months.sort();
}

/**
 * Store the finished months that have a log but no stats yet (at most MONTHS_PER_RUN, oldest first).
 * A month counts as finished an hour after it ended, so a download logged at the last moment is in.
 */
export async function collectFinishedMonths(env: Env, now: Date): Promise<{ stored: string[] }> {
  const settled = monthOf(new Date(now.getTime() - 60 * 60 * 1000));
  const current = monthOf(now);
  const stored = new Set((await listAll(env.STATE, { prefix: STATS_PREFIX })).map((o) => o.key.slice(STATS_PREFIX.length, -'.json'.length)));
  const todo = (await loggedMonths(env)).filter((m) => m < current && m < settled && !stored.has(m)).slice(0, MONTHS_PER_RUN);
  for (const month of todo) {
    await writeJson(env.STATE, `${STATS_PREFIX}${month}.json`, summarise(month, await monthLog(env, month), true));
  }
  return { stored: todo };
}

/** The stats for the Images tab: stored months, the month under way live, totals per release. */
export async function imagesStats(env: Env, now: Date): Promise<ImagesStats> {
  try {
    await collectFinishedMonths(env, now);
    const keys = (await listAll(env.STATE, { prefix: STATS_PREFIX })).map((o) => o.key);
    const stored = (await Promise.all(keys.map((k) => readJson<MonthStats>(env.STATE, k))))
      .filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.value);
    const current = monthOf(now);
    const last = previousMonth(current);
    const live = [summarise(current, await monthLog(env, current), false)];
    // Last month is stored an hour after it ended; until then it is counted live as well.
    if (!stored.some((m) => m.month === last)) live.push(summarise(last, await monthLog(env, last), false));
    const months = [...live, ...stored.filter((m) => m.month !== current)]
      .filter((m) => m.downloads > 0 || m.month === current)
      .sort((a, b) => b.month.localeCompare(a.month));

    const totals = new Map<string, ReleaseTotal>();
    for (const m of months) {
      for (const [release, n] of Object.entries(m.releases)) {
        const t = totals.get(release) ?? { release, total: 0, thisMonth: 0, lastMonth: 0 };
        t.total += n;
        if (m.month === current) t.thisMonth += n;
        if (m.month === last) t.lastMonth += n;
        totals.set(release, t);
      }
    }
    return {
      month: current,
      months,
      releases: [...totals.values()].sort((a, b) => b.total - a.total || a.release.localeCompare(b.release)),
      total: months.reduce((n, m) => n + m.downloads, 0),
    };
  } catch (err) {
    console.error(`images stats: ${(err as Error).message}`);
    return { month: monthOf(now), months: [], releases: [], total: 0, error: 'The download counts could not be read right now.' };
  }
}
