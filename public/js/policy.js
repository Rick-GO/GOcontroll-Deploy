// @ts-check
// Which versions of an S1 application may be installed (cloud-r2-distribution.md §3 v0.22.0, "Which
// versions can be installed"), worked out the way the Worker does it (src/bucket.ts compareVersions,
// newestNotWithdrawn, installableVersions), so the page can say what a change does before it is
// made. No imports and no DOM: test/pages.test.ts holds it against the Worker.
//
//   installable           every release that is not withdrawn
//   withdrawn             never offered and never installed

/** @typedef {{ version: string, withdrawn?: boolean }} PolicyRelease */

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Order two versions as the Worker does: numbers per part (0.0.10 after 0.0.9); a version that is
 * not major.minor.patch sorts below every one that is. Negative when a is lower.
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  const pa = VERSION.test(a) ? a.split('.').map(Number) : null;
  const pb = VERSION.test(b) ? b.split('.').map(Number) : null;
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }
  if (pa) return 1;
  if (pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @template {PolicyRelease} T @param {T[]} releases @returns {T[]} newest first */
const newestFirst = (releases) => [...releases].sort((a, b) => compareVersions(b.version, a.version));

/** The newest release that is not withdrawn (what update-to-latest installs), or null. @param {PolicyRelease[]} releases */
export function newestNotWithdrawn(releases) {
  return newestFirst(releases).find((r) => !r.withdrawn)?.version ?? null;
}

/** The installable versions, newest first: every release that is not withdrawn. @param {PolicyRelease[]} releases @returns {string[]} */
export function installableVersions(releases) {
  return newestFirst(releases).filter((r) => !r.withdrawn).map((r) => r.version);
}

/**
 * The releases as they would be with one of them withdrawn or restored.
 * @template {PolicyRelease} T @param {T[]} releases @param {string} version @param {boolean} withdrawn
 * @returns {T[]}
 */
export const withWithdrawn = (releases, version, withdrawn) => releases.map((r) => (r.version === version ? { ...r, withdrawn } : r));

/** Whether withdrawing `version` would leave no release to install (the Worker refuses it). @param {PolicyRelease[]} releases @param {string} version */
export const onlyOneLeft = (releases, version) => !releases.some((r) => !r.withdrawn && r.version !== version);
