// The contract of the images bucket gocontroll-images, shared by its two Workers:
//
//   gocontroll-deploy-intranet (this repo, src/images.ts)   the only writer of releases and of
//                                                            manifest.json (the Images tab); mails
//                                                            the sign-in links (src/images-mail.ts)
//   gocontroll-images (this repo, images/)                  images.gocontroll.tech: customers ask for
//                                                            a link with their e-mail address, open it
//                                                            and download
//
// Bucket layout:
//
//   manifest.json                                   the published catalogue (Catalogue below); what
//                                                   customers see, nothing else (no e-mail addresses,
//                                                   no drafts)
//   images/<product>/<version>/<file>               a file of a controller image: the complete image as
//                                                   one zip for UUU (role package), or a part of it
//                                                   (rootfs, kernel, bootloader, …); <product> follows
//                                                   from the controller (CONTROLLER_PRODUCTS)
//   downloads/<yyyy>/<mm>/<iso time>-<random>.json  one download, written by images.gocontroll.tech;
//                                                   who and what is in the custom metadata (DownloadMeta)
//   access-mails/<hmac of the address>              the sign-in links mailed to one address in the last
//                                                   hour (custom metadata `sent`), written by
//                                                   images.gocontroll.tech for its hourly cap; expires
//                                                   after a day (R2 lifecycle rule)
//
// A file is downloadable only while its release is in manifest.json: a draft's files are in the
// bucket already, but images.gocontroll.tech serves nothing that the catalogue does not name.
//
// Signing in: images.gocontroll.tech asks for an e-mail address (and a Turnstile check), and hands the
// intranet Worker's RPC entrypoint ImagesMail (service binding MAIL) an AccessLinkMail: the address
// and the link it signed. The intranet writes and sends the mail itself (Microsoft Graph, from
// noreply@gocontroll.com), so the mail secret never reaches the public Worker; it sends only to that
// address and only a link to IMAGES_URL/access (LINK_TOKEN_RE). The link works for LINK_TTL_SECONDS;
// opening it gives access for SESSION_TTL_SECONDS on that device.
// Contract document: GOcontroll-Architecture/cloudflare/images/spec.md.
//
// No imports and only erasable TypeScript, so both Workers bundle it as it is.

export const CATALOGUE_KEY = 'manifest.json';
/**
 * Format 3 (since 2026-10-29, Deploy 0.9.0): a release is one controller's image, named by `controller`
 * and `version` only; its product folder follows from the controller, there is no title. Format 2 had
 * `product`, `title` and `controllers` (still read: the controller from the product, CONTROLLER_PRODUCTS);
 * format 1 also had tool releases (never published). A manifest of a newer format than this is read as
 * empty: a reader that does not know it shows nothing, and Deploy never writes over it.
 */
export const CATALOGUE_FORMAT = 3;
export const DOWNLOAD_LOG_PREFIX = 'downloads/';
/** The top folder of every release in the bucket. */
export const RELEASES_DIR = 'images';

/** The Linux controllers; a release is the image of one of them (order as shown). */
export const IMAGE_CONTROLLERS = ['L4', 'M1', 'HMI1'] as const;
export type ImageController = (typeof IMAGE_CONTROLLERS)[number];

/**
 * The product of each controller: its folder under images/, and the `product` of the download log and
 * the counts. Derived, never stored in a release: the controller is the one source.
 */
export const CONTROLLER_PRODUCTS: Readonly<Record<ImageController, string>> = { L4: 'moduline-l4', M1: 'moduline-m1', HMI1: 'moduline-hmi1' };
export const productOf = (controller: ImageController): string => CONTROLLER_PRODUCTS[controller];
/** The controller whose product this is (format 2 and older records named the product); null for any other. */
export function controllerOfProduct(product: unknown): ImageController | null {
  return IMAGE_CONTROLLERS.find((c) => CONTROLLER_PRODUCTS[c] === product) ?? null;
}
/** The name customers see for a controller's images. */
export const controllerTitle = (controller: ImageController): string => `Moduline ${controller}`;

/**
 * What a file in a release is. `package`: a zip with everything UUU needs to install the image, the
 * complete image and a script that installs only the kernel.
 */
export const FILE_ROLES = ['package', 'rootfs', 'kernel', 'bootloader', 'devicetree', 'script', 'docs', 'other'] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export const FILE_ROLE_LABELS: Readonly<Record<FileRole, string>> = {
  package: 'Complete image',
  rootfs: 'Root file system',
  kernel: 'Kernel',
  bootloader: 'Bootloader',
  devicetree: 'Device tree',
  script: 'Flash script',
  docs: 'Documentation',
  other: 'Other',
};

/** The computer a file runs on (a flash script); `any` for an image or a file that is not a program. */
export const PLATFORMS = ['any', 'windows', 'linux', 'macos'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = { any: 'Any', windows: 'Windows', linux: 'Linux', macos: 'macOS' };

/** The shape of a product folder (the products themselves: CONTROLLER_PRODUCTS). */
export const PRODUCT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A version: e.g. 2026-10-29_6.12.87, 2026.11.0, 1.4.2-rc1. Never "." or "..": it starts with a letter or digit. */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A file name in a release: no path, no leading dot. */
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
/** YYYY-MM-DD. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CatalogueFile {
  name: string;
  path: string;        // the object key, e.g. images/moduline-l4/2026-10-29_6.12.87/moduline-l4.zip
  size: number;        // bytes
  sha256: string;      // 64 lower-case hex, computed by Deploy from the stored object
  role: FileRole;
  platform: Platform;
}

export interface CatalogueRelease {
  controller: ImageController;     // whose image this is; its product folder is productOf(controller)
  version: string;
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
  product: string;   // productOf(controller), as in the path
  version: string;
  country: string;
}

/** The folder of a release in the bucket, with a trailing slash. */
export const releasePrefix = (controller: ImageController, version: string): string =>
  `${RELEASES_DIR}/${productOf(controller)}/${version}/`;

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

/** Catalogue order: controller (L4, M1, HMI1), then the newest release first. */
export function sortReleases(releases: CatalogueRelease[]): CatalogueRelease[] {
  return [...releases].sort((a, b) =>
    IMAGE_CONTROLLERS.indexOf(a.controller) - IMAGE_CONTROLLERS.indexOf(b.controller)
    || b.released.localeCompare(a.released)
    || compareLooseVersions(b.version, a.version));
}

const isString = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/**
 * Read manifest.json. A release or file that does not hold up is left out (never served), so a
 * broken entry cannot open a path outside its release. A newer format than CATALOGUE_FORMAT gives
 * no releases at all (`format` says which it was). A release of format 2 (no `controller`) takes
 * the controller of its `product`; its `title` and `controllers` are dropped. Throws only when the
 * text is not JSON.
 */
export function parseCatalogue(text: string): Catalogue {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const out = emptyCatalogue();
  out.updated = isString(doc?.updated) ? doc.updated : null;
  if (typeof doc?.format === 'number' && Number.isSafeInteger(doc.format) && doc.format > 0) out.format = doc.format;
  if (out.format > CATALOGUE_FORMAT) return out;
  const releases = Array.isArray(doc?.releases) ? doc.releases : [];
  for (const r of releases as Record<string, unknown>[]) {
    if (!r || !isString(r.version) || !VERSION_RE.test(r.version)) continue;
    const controller = oneOf(IMAGE_CONTROLLERS, r.controller) ? r.controller : controllerOfProduct(r.product);
    if (!controller) continue;
    const prefix = releasePrefix(controller, r.version);
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
      controller,
      version: r.version,
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

/** Whether `path` has the shape of a file of a release: images/<product>/<version>/<file>. */
export function isReleaseFilePath(path: string): boolean {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === RELEASES_DIR
    && PRODUCT_RE.test(parts[1]) && VERSION_RE.test(parts[2]) && FILE_NAME_RE.test(parts[3]);
}

// ── Signing in on images.gocontroll.tech ─────────────────────────────────────

export const ACCESS_MAIL_PREFIX = 'access-mails/';
/** The path of the link in the mail; the signed token is its query parameter `t`. */
export const ACCESS_PATH = '/access';
/** A link token as images.gocontroll.tech signs it: `l.<payload>.<HMAC-SHA256>`, base64url. */
export const LINK_TOKEN_RE = /^l\.[A-Za-z0-9_-]{16,1200}\.[A-Za-z0-9_-]{43}$/;
/** How long the link in the mail works. */
export const LINK_TTL_SECONDS = 60 * 60;
/** How long opening the link gives access, on that device. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** At most this many links per address per hour. */
export const LINKS_PER_HOUR = 5;

/** The page that starts the download of one published file: the link to give a customer. */
export const DOWNLOAD_PAGE_PREFIX = '/download/';
export const downloadPagePath = (path: string): string => `${DOWNLOAD_PAGE_PREFIX}${path}`;

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** An e-mail address as both Workers accept it: trimmed, lower case, plain ASCII; null when it is not one. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** What images.gocontroll.tech hands ImagesMail.sendAccessLink (the RPC entrypoint of the intranet Worker). */
export interface AccessLinkMail {
  email: string;   // the address the customer typed (normaliseEmail); the only recipient
  link: string;    // <IMAGES_URL>/access?t=<token>, the token matching LINK_TOKEN_RE
  file?: string;   // the file the customer wanted (a FILE_NAME_RE name), when they came from a download link
}
export type AccessLinkResult = { ok: true } | { ok: false; error: 'refused' | 'unavailable' };
