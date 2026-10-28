// @ts-check
// What the page shows, without the DOM: labels, sizes, dates and the grouping and filtering of the
// catalogue. No DOM here, so images/test/page.test.ts runs it as it is.
//
// The browser cannot import ../../src/images-format.ts (TypeScript, outside the site). The source
// of the types and the two label maps below is that file; page.test.ts fails when they drift apart.

/**
 * @typedef {{ name: string, path: string, size: number, sha256: string, role: string, platform: string }} CatalogueFile
 * @typedef {{ kind: 'image' | 'tool', product: string, title: string, version: string, controllers: string[],
 *   released: string, notes: string, files: CatalogueFile[] }} CatalogueRelease
 * @typedef {{ format: number, updated: string | null, releases: CatalogueRelease[] }} Catalogue
 */

/** Copy of FILE_ROLE_LABELS in src/images-format.ts (the source). @type {Readonly<Record<string, string>>} */
export const FILE_ROLE_LABELS = Object.freeze({
  rootfs: 'Root file system',
  kernel: 'Kernel',
  bootloader: 'Bootloader',
  devicetree: 'Device tree',
  script: 'Flash script',
  tool: 'Tool',
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

/** "L4, M1 and HMI1"; '' for none. @param {string[]} items */
export function joinList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Which controllers a release is for, as a sentence part. @param {CatalogueRelease} release */
export const controllersText = (release) => (release.controllers.length ? `For the ${joinList(release.controllers)}` : 'For every controller');

/**
 * True when a release is for `controller` ('' = all). An image without controllers is for every
 * controller (the contract allows an empty list for a tool only, so this is the safe reading).
 * @param {CatalogueRelease} release @param {string} controller
 */
export const isFor = (release, controller) => !controller || !release.controllers.length || release.controllers.includes(controller);

/**
 * The releases of one kind grouped per product, in catalogue order (the Worker sorts: product,
 * then the newest release first), optionally only those for one controller.
 * @param {CatalogueRelease[]} releases @param {'image' | 'tool'} kind @param {string} [controller]
 * @returns {CatalogueRelease[][]}
 */
export function productGroups(releases, kind, controller = '') {
  /** @type {Map<string, CatalogueRelease[]>} */
  const groups = new Map();
  for (const r of releases) {
    if (r.kind !== kind || !isFor(r, controller)) continue;
    const list = groups.get(r.product);
    if (list) list.push(r);
    else groups.set(r.product, [r]);
  }
  return [...groups.values()];
}
