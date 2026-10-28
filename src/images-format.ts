// The contract of the images bucket gocontroll-images, shared by its two Workers:
//
//   gocontroll-deploy-intranet (this repo, src/images.ts)   the only writer of releases and of
//                                                            manifest.json (the Images tab)
//   gocontroll-images (this repo, images/)                  images.gocontroll.tech: customers sign in
//                                                            (Access, one-time PIN) and download
//
// Bucket layout:
//
//   manifest.json                                   the published catalogue (Catalogue below); what
//                                                   customers see, nothing else (no e-mail addresses,
//                                                   no drafts)
//   images/<product>/<version>/<file>               a controller image (rootfs, kernel, bootloader, …)
//   tools/<product>/<version>/<file>                a tool to install an image with (flash scripts, …)
//   downloads/<yyyy>/<mm>/<iso time>-<random>.json  one download, written by images.gocontroll.tech;
//                                                   who and what is in the custom metadata (DownloadMeta)
//
// A file is downloadable only while its release is in manifest.json: a draft's files are in the
// bucket already, but images.gocontroll.tech serves nothing that the catalogue does not name.
// Contract document: GOcontroll-Architecture/cloudflare/images/spec.md.
//
// No imports and only erasable TypeScript, so both Workers bundle it as it is.

export const CATALOGUE_KEY = 'manifest.json';
export const CATALOGUE_FORMAT = 1;
export const DOWNLOAD_LOG_PREFIX = 'downloads/';

/** What a release is: an image for a controller, or a tool to install one with. */
export const RELEASE_KINDS = ['image', 'tool'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];
/** The top folder of each kind in the bucket. */
export const KIND_DIRS: Readonly<Record<ReleaseKind, string>> = { image: 'images', tool: 'tools' };

/** The Linux controllers an image is for (order as shown). */
export const IMAGE_CONTROLLERS = ['L4', 'M1', 'HMI1'] as const;
export type ImageController = (typeof IMAGE_CONTROLLERS)[number];

/** What a file in a release is. */
export const FILE_ROLES = ['rootfs', 'kernel', 'bootloader', 'devicetree', 'script', 'tool', 'docs', 'other'] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export const FILE_ROLE_LABELS: Readonly<Record<FileRole, string>> = {
  rootfs: 'Root file system',
  kernel: 'Kernel',
  bootloader: 'Bootloader',
  devicetree: 'Device tree',
  script: 'Flash script',
  tool: 'Tool',
  docs: 'Documentation',
  other: 'Other',
};

/** The computer a file runs on; `any` for an image or a file that is not a program. */
export const PLATFORMS = ['any', 'windows', 'linux', 'macos'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = { any: 'Any', windows: 'Windows', linux: 'Linux', macos: 'macOS' };

/** A product: one line of releases (e.g. moduline-headless, flash-tools). */
export const PRODUCT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A version: e.g. 2026.11.0, 1.4.2-rc1. Never "." or "..": it starts with a letter or digit. */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A file name in a release: no path, no leading dot. */
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
/** YYYY-MM-DD. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CatalogueFile {
  name: string;
  path: string;        // the object key, e.g. images/moduline-headless/2026.11.0/rootfs.ext4.zst
  size: number;        // bytes
  sha256: string;      // 64 lower-case hex, computed by Deploy from the stored object
  role: FileRole;
  platform: Platform;
}

export interface CatalogueRelease {
  kind: ReleaseKind;
  product: string;
  title: string;
  version: string;
  controllers: ImageController[];  // empty for a tool that works with every controller
  released: string;                // YYYY-MM-DD
  notes: string;                   // plain text; the page shows it as text, never as HTML
  files: CatalogueFile[];
}

export interface Catalogue {
  format: number;
  updated: string | null;          // ISO time of the last publish or withdrawal
  releases: CatalogueRelease[];
}

/** Custom metadata of a downloads/ object: who downloaded what (images.gocontroll.tech). */
export interface DownloadMeta {
  email: string;
  path: string;
  kind: string;
  product: string;
  version: string;
  country: string;
}

/** The folder of a release in the bucket, with a trailing slash. */
export const releasePrefix = (kind: ReleaseKind, product: string, version: string): string =>
  `${KIND_DIRS[kind]}/${product}/${version}/`;

export const emptyCatalogue = (): Catalogue => ({ format: CATALOGUE_FORMAT, updated: null, releases: [] });

/** Version order: numeric parts as numbers, the rest as text ("1.10" after "1.9"). */
export function compareLooseVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Catalogue order: images before tools, then product, then the newest release first. */
export function sortReleases(releases: CatalogueRelease[]): CatalogueRelease[] {
  return [...releases].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'image' ? -1 : 1)
    || a.product.localeCompare(b.product)
    || b.released.localeCompare(a.released)
    || compareLooseVersions(b.version, a.version));
}

const isString = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/**
 * Read manifest.json. A release or file that does not hold up is left out (never served), so a
 * broken entry cannot open a path outside its release. Throws only when the text is not JSON.
 */
export function parseCatalogue(text: string): Catalogue {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const out = emptyCatalogue();
  out.updated = isString(doc?.updated) ? doc.updated : null;
  const releases = Array.isArray(doc?.releases) ? doc.releases : [];
  for (const r of releases as Record<string, unknown>[]) {
    if (!r || !oneOf(RELEASE_KINDS, r.kind) || !isString(r.product) || !PRODUCT_RE.test(r.product)
      || !isString(r.version) || !VERSION_RE.test(r.version)) continue;
    const prefix = releasePrefix(r.kind, r.product, r.version);
    const files: CatalogueFile[] = [];
    for (const f of (Array.isArray(r.files) ? r.files : []) as Record<string, unknown>[]) {
      if (!f || !isString(f.name) || !FILE_NAME_RE.test(f.name) || f.path !== prefix + f.name) continue;
      files.push({
        name: f.name,
        path: f.path,
        size: typeof f.size === 'number' && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0,
        sha256: isString(f.sha256) && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : '',
        role: oneOf(FILE_ROLES, f.role) ? f.role : 'other',
        platform: oneOf(PLATFORMS, f.platform) ? f.platform : 'any',
      });
    }
    out.releases.push({
      kind: r.kind,
      product: r.product,
      title: isString(r.title) && r.title.trim() ? r.title : r.product,
      version: r.version,
      controllers: (Array.isArray(r.controllers) ? r.controllers : []).filter((c): c is ImageController => oneOf(IMAGE_CONTROLLERS, c)),
      released: isString(r.released) && DATE_RE.test(r.released) ? r.released : '',
      notes: isString(r.notes) ? r.notes : '',
      files,
    });
  }
  out.releases = sortReleases(out.releases);
  return out;
}

/** The release and file a path belongs to, when the catalogue names it; null otherwise. */
export function findPublishedFile(catalogue: Catalogue, path: string): { release: CatalogueRelease; file: CatalogueFile } | null {
  for (const release of catalogue.releases) {
    const file = release.files.find((f) => f.path === path);
    if (file) return { release, file };
  }
  return null;
}

/** The text of manifest.json: two-space JSON with a trailing newline. */
export const catalogueText = (catalogue: Catalogue): string => `${JSON.stringify(catalogue, null, 2)}\n`;

/** The key of one download in the log; time-ordered, so a listing is chronological. */
export function downloadLogKey(at: Date, random: string): string {
  const iso = at.toISOString();
  return `${DOWNLOAD_LOG_PREFIX}${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso}-${random}.json`;
}
