// The go-deploy root manifest as the CI producer writes it: upload-r2.py of the skill
// r2-application-deploy-setup (semver_key order, json.dumps indent 2 with ensure_ascii). Pure
// functions without imports; test/linux-release.test.ts holds them to upload-r2.py's own output
// (test/fixtures/linux, scripts/linux-root-fixtures.py).

export interface SemverKey { nums: number[]; release: boolean; pre: string }

/** Python's int() on a version part: optional sign and spaces, digits with single underscores. */
function pyInt(s: string): number | null {
  return /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(s) ? Number(s.replace(/[\s_]/g, '')) : null;
}

/** upload-r2.py semver_key: (numeric tuple, not a pre-release, pre-release suffix); (0,) when a part is not a number. */
export function semverKey(v: string): SemverKey {
  const dash = v.indexOf('-');
  const base = dash < 0 ? v : v.slice(0, dash);
  const pre = dash < 0 ? '' : v.slice(dash + 1);
  const parts = base.split('.').map(pyInt);
  return { nums: parts.some((p) => p === null) ? [0] : (parts as number[]), release: pre === '', pre };
}

/** Python tuple order of two semver keys. */
export function compareSemver(a: string, b: string): number {
  const x = semverKey(a);
  const y = semverKey(b);
  for (let i = 0; i < Math.min(x.nums.length, y.nums.length); i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.nums.length !== y.nums.length) return x.nums.length < y.nums.length ? -1 : 1;
  if (x.release !== y.release) return x.release ? 1 : -1;
  return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0;
}

/** json.dumps(obj, indent=2) + "\n" with Python's default ensure_ascii: every non-ASCII code unit as \uXXXX. */
export function pythonJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

export interface RootEntry {
  version: string;
  released: string;
  description: string;
  tarball: string;
  manifest: string;
  size_bytes: number;
  sha256: string;
}

/**
 * The root manifest after a release, as upload-r2.py upload() builds it: the existing document
 * (or a new one), the entry of this version replaced, versions sorted newest first by
 * semver_key (stable), latest_version = the first. Every other field stays where it was.
 */
export function nextRootManifest(existing: Record<string, unknown> | null, appId: string, entry: RootEntry): Record<string, unknown> {
  const root: Record<string, unknown> = existing ? structuredClone(existing) : { app_id: appId, latest_version: entry.version, versions: [] };
  const versions = ((Array.isArray(root.versions) ? root.versions : []) as Record<string, unknown>[]).filter((v) => v.version !== entry.version);
  versions.push({ ...entry });
  versions.sort((a, b) => compareSemver(String(b.version), String(a.version)));
  root.app_id = appId;
  root.versions = versions;
  root.latest_version = versions[0].version;
  return root;
}

