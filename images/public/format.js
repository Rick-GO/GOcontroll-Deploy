// @ts-check
// What the page shows, without the DOM: labels, sizes, dates and the grouping and filtering of the
// catalogue. No DOM here, so images/test/page.test.ts runs it as it is.
//
// The browser cannot import ../../src/images-format.ts (TypeScript, outside the site). The source
// of the types, the two label maps and the name of a controller's images below is that file;
// page.test.ts fails when they drift apart.

/**
 * @typedef {{ name: string, path: string, size: number, sha256: string, role: string, platform: string }} CatalogueFile
 * @typedef {{ folder: string, controller: string, type: string, version: string, released: string, notes: string, files: CatalogueFile[] }} CatalogueRelease
 * @typedef {{ format: number, updated: string | null, releases: CatalogueRelease[] }} Catalogue
 */

/** Copy of FILE_ROLE_LABELS in src/images-format.ts (the source). @type {Readonly<Record<string, string>>} */
export const FILE_ROLE_LABELS = Object.freeze({
  package: 'Complete image',
  rootfs: 'Root file system',
  kernel: 'Kernel',
  bootloader: 'Bootloader',
  devicetree: 'Device tree',
  script: 'Flash script',
  docs: 'Documentation',
  other: 'Other',
});

/** Copy of PLATFORM_LABELS in src/images-format.ts (the source). @type {Readonly<Record<string, string>>} */
export const PLATFORM_LABELS = Object.freeze({ any: 'Any', windows: 'Windows', linux: 'Linux', macos: 'macOS' });

/** The controllers of the filter, in the order of IMAGE_CONTROLLERS in src/images-format.ts. */
export const CONTROLLERS = Object.freeze(['L4', 'M1', 'HMI1']);

/** @param {string} role */
export const roleLabel = (role) => FILE_ROLE_LABELS[role] ?? FILE_ROLE_LABELS.other;

/** The platform to show, or '' for `any` (nothing to say). @param {string} platform */
export const platformLabel = (platform) => (platform === 'any' ? '' : PLATFORM_LABELS[platform] ?? '');

/** Bytes as people read them: 1000-based, one decimal from kB up. @param {number} bytes */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value.toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** YYYY-MM-DD (or an ISO time) as "1 November 2026"; '' when there is none. @param {string | null | undefined} date */
export function formatDate(date) {
  if (!date) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The name of a controller's images (its card), as controllerTitle in src/images-format.ts: "Moduline HMI1". @param {CatalogueRelease} release */
export const releaseTitle = (release) => `Moduline ${release.controller}`;

/** The name of one system, as releaseName in src/images-format.ts: "Moduline HMI1 · 1.07 - AV123". @param {CatalogueRelease} release */
export const releaseName = (release) => (release.type ? `${releaseTitle(release)} · ${release.type}` : releaseTitle(release));

/**
 * Per release of one controller's card (catalogue order: type, then newest first) whether it is the
 * latest of its type: every type is a system of its own, with a latest release of its own (a
 * controller without types is one system). The latest is shown open, the others collapsed.
 * @param {CatalogueRelease[]} releases @returns {boolean[]}
 */
export function latestPerType(releases) {
  const seen = new Set();
  return releases.map((r) => {
    if (seen.has(r.type)) return false;
    seen.add(r.type);
    return true;
  });
}

/** True when a release is the image of `controller` ('' = all). @param {CatalogueRelease} release @param {string} controller */
export const isFor = (release, controller) => !controller || release.controller === controller;

/**
 * The releases grouped per controller, in catalogue order (the Worker sorts: L4, M1, HMI1, then type,
 * then the newest release first), optionally only those of one controller.
 * @param {CatalogueRelease[]} releases @param {string} [controller]
 * @returns {CatalogueRelease[][]}
 */
export function controllerGroups(releases, controller = '') {
  /** @type {Map<string, CatalogueRelease[]>} */
  const groups = new Map();
  for (const r of releases) {
    if (!isFor(r, controller)) continue;
    const list = groups.get(r.controller);
    if (list) list.push(r);
    else groups.set(r.controller, [r]);
  }
  return [...groups.values()];
}

// ── Signing in and the download page ─────────────────────────────────────────

/** Copies of LINK_TTL_SECONDS and SESSION_TTL_SECONDS in src/images-format.ts (the source), in minutes and days. */
export const LINK_MINUTES = 60;
export const ACCESS_DAYS = 7;

/**
 * What the sign-in page says first, from its address: an expired or broken link, or signed out;
 * null when there is nothing to say. @param {URLSearchParams} params
 * @returns {{ kind: 'err' | 'info', text: string } | null}
 */
export function signInNotice(params) {
  const link = params.get('link');
  if (link === 'expired') return { kind: 'err', text: 'This link has expired. Enter your e-mail address and we send you a new one.' };
  if (link !== null) return { kind: 'err', text: 'This link does not work. Enter your e-mail address and we send you a new one.' };
  if (params.has('signed-out')) return { kind: 'info', text: 'You are signed out.' };
  return null;
}

/** The release file a download page or ?next= names, or '' (the start page). @param {string | null} path */
export function downloadTarget(path) {
  const prefix = '/download/';
  if (!path || !path.startsWith(prefix)) return '';
  const file = path.slice(prefix.length);
  return /^images\/[^/]+\/[^/]+\/[^/]+$/.test(file) ? file : '';
}

/** The file name of a release file path. @param {string} path */
export const fileName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The release and file of a path in the catalogue, or null when it is not (or no longer) published.
 * @param {Catalogue} catalogue @param {string} path
 * @returns {{ release: CatalogueRelease, file: CatalogueFile } | null}
 */
export function findFile(catalogue, path) {
  for (const release of catalogue.releases) {
    const file = release.files.find((f) => f.path === path);
    if (file) return { release, file };
  }
  return null;
}

/** The commands that compute a file's SHA-256, per system, with its name filled in. @param {string} name */
export function verifyCommands(name) {
  return [
    { system: 'Linux', command: `sha256sum ${name}` },
    { system: 'macOS', command: `shasum -a 256 ${name}` },
    { system: 'Windows (PowerShell)', command: `Get-FileHash -Algorithm SHA256 .\\${name}` },
  ];
}
