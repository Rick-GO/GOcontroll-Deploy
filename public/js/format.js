// @ts-check
// Formatting for the UI. Pure functions (no DOM). Times are stored in UTC and shown in
// Europe/Amsterdam; calendar dates (YYYY-MM-DD, such as a release date) are shown as they are.

const TZ = 'Europe/Amsterdam';

/** "9 Oct 2026, 14:05" @param {string | null | undefined} iso */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "12 Oct 2026" for a calendar date (YYYY-MM-DD). @param {string | null | undefined} day */
export function fmtDay(day) {
  if (!day) return '—';
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Tue 12 Oct" for a day in a short list. @param {string} day */
export function fmtDayShort(day) {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

/** "1,234" @param {number | null | undefined} n */
export const fmtCount = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-GB'));

/** "1.4 MB" (binary units, as R2 shows them). @param {number | null | undefined} bytes */
export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('en-GB', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** First 12 hex digits of a SHA-256, for a table. @param {string | null | undefined} hex */
export const shortHash = (hex) => (hex ? hex.slice(0, 12).toLowerCase() : '—');

/** "deploy.gocontroll.tech" for "https://deploy.gocontroll.tech/X/manifest.json". @param {string | null | undefined} url */
export function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}

/** "1.2.3" for a header version given as a string or as [1, 2, 3]. @param {string | number[] | null | undefined} v */
export const versionText = (v) => (Array.isArray(v) ? v.join('.') : (v ?? ''));

/** "1 release", "2 releases" @param {number} n @param {string} one @param {string} [many] */
export const plural = (n, one, many = `${one}s`) => `${fmtCount(n)} ${n === 1 ? one : many}`;
