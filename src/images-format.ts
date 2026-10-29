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
//   images/<product>/<id>/<file>                    a file of a controller image: the complete image as
//                                                   one zip for UUU (role package), or a part of it
//                                                   (rootfs, kernel, bootloader, …). images/<product>/<id>
//                                                   is the release's folder, fixed when it is made (its
//                                                   key <product>/<id>); type and version are labels and
//                                                   can change, the folder never does
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
 * Format 5 (since 2026-10-29, Deploy 0.11.0): a release is the image of one controller, optionally one
 * type of it, in one version, and names its own `folder` (images/<product>/<id>, fixed when it is made):
 * type and version are labels that can change. Format 4 and older had no `folder`: it was
 * images/<productOf(controller, type)>/<version> (legacyFolder), and is read so. Format 3 had no `type`
 * (read as ''); format 2 had `product`, `title` and `controllers` (read: the controller of the product);
 * format 1 also had tool releases (never published). A manifest of a newer format than this is read as
 * empty: a reader that does not know it shows nothing, and Deploy never writes over it.
 */
export const CATALOGUE_FORMAT = 5;
export const DOWNLOAD_LOG_PREFIX = 'downloads/';
/** The top folder of every release in the bucket. */
export const RELEASES_DIR = 'images';

/** The Linux controllers; a release is the image of one of them (order as shown). */
export const IMAGE_CONTROLLERS = ['L4', 'M1', 'HMI1'] as const;
export type ImageController = (typeof IMAGE_CONTROLLERS)[number];

/** The product of each controller: the first part of the folder of its new releases (images/<product>/<id>). */
export const CONTROLLER_PRODUCTS: Readonly<Record<ImageController, string>> = { L4: 'moduline-l4', M1: 'moduline-m1', HMI1: 'moduline-hmi1' };

/**
 * A type: a variant of a controller that is a system of its own (e.g. "1.07 - AV123": hardware version
 * and adapter board of an HMI1), with releases and a latest release of its own. Free text as people
 * write it, shown to customers as it is; '' = none. At most TYPE_MAX printable ASCII characters, at
 * least one letter or digit.
 */
export const TYPE_MAX = 40;
const TYPE_RE = /^[ -~]{1,40}$/;

/** A type as it is kept: trimmed, inner spaces collapsed; '' for none; null when it is not a type. */
export function normaliseType(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const type = raw.trim().replace(/\s+/g, ' ');
  if (!type) return '';
  return TYPE_RE.test(type) && /[A-Za-z0-9]/.test(type) ? type : null;
}

/** The folder part of a type: lower case, dots dropped, every other run of non-alphanumerics a dash ("1.07 - AV123" → "107-av123"). */
export function typeSlug(type: string): string {
  return type.toLowerCase().split('.').join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The product folder a release of format 4 and older had: "moduline-hmi1", or with a type
 * "moduline-hmi1-107-av123" (Deploy 0.10.0). Since format 5 a release names its folder itself.
 */
export const productOf = (controller: ImageController, type = ''): string =>
  (type ? `${CONTROLLER_PRODUCTS[controller]}-${typeSlug(type)}` : CONTROLLER_PRODUCTS[controller]);
/** The folder of a release of format 4 and older, which had none of its own. */
export const legacyFolder = (controller: ImageController, type: string, version: string): string =>
  `${RELEASES_DIR}/${productOf(controller, type)}/${version}`;
/** The controller whose product (without a type) this is (format 2 named the product); null for any other. */
export function controllerOfProduct(product: unknown): ImageController | null {
  return IMAGE_CONTROLLERS.find((c) => CONTROLLER_PRODUCTS[c] === product) ?? null;
}
/** The name customers see for a controller's images (the card). */
export const controllerTitle = (controller: ImageController): string => `Moduline ${controller}`;
/** The name of one system: the controller, with its type when it has one ("Moduline HMI1 · 1.07 - AV123"). */
export const releaseName = (controller: ImageController, type: string): string =>
  (type ? `${controllerTitle(controller)} · ${type}` : controllerTitle(controller));

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

/** The shape of the first part of a folder (the products: CONTROLLER_PRODUCTS, with a type suffix before format 5). */
export const PRODUCT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The shape of the second part of a folder: a release id since format 5 (12 hex), a version before. */
export const FOLDER_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A version: e.g. 6.12.87, 2026-10-29_6.12.87, 1.4.2-rc1. Never "." or "..": it starts with a letter or digit. */
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
  folder: string;                  // images/<product>/<id>: where its files are; fixed, its key is <product>/<id>
  controller: ImageController;     // whose image this is
  type: string;                    // label: which type of the controller ('' = none)
  version: string;                 // label
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
  product: string;   // with `version`: the two parts of the release's folder (its key), as in the path; not its labels
  version: string;
  country: string;
}

/** Whether `folder` has the shape of a release's folder: images/<product>/<id>. */
export function isReleaseFolder(folder: string): boolean {
  const parts = folder.split('/');
  return parts.length === 3 && parts[0] === RELEASES_DIR && PRODUCT_RE.test(parts[1]) && FOLDER_ID_RE.test(parts[2]);
}

/** The controller a folder belongs to: its product is the controller's, or (0.10.0) starts with it and a dash. */
export function controllerOfFolder(folder: string): ImageController | null {
  if (!isReleaseFolder(folder)) return null;
  const product = folder.split('/')[1];
  return IMAGE_CONTROLLERS.find((c) => product === CONTROLLER_PRODUCTS[c] || product.startsWith(`${CONTROLLER_PRODUCTS[c]}-`)) ?? null;
}

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

/** Catalogue order: controller (L4, M1, HMI1), then type (none first), then the newest release first. */
export function sortReleases(releases: CatalogueRelease[]): CatalogueRelease[] {
  return [...releases].sort((a, b) =>
    IMAGE_CONTROLLERS.indexOf(a.controller) - IMAGE_CONTROLLERS.indexOf(b.controller)
    || compareLooseVersions(a.type, b.type)
    || b.released.localeCompare(a.released)
    || compareLooseVersions(b.version, a.version));
}

const isString = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/**
 * Read manifest.json. A release or file that does not hold up is left out (never served), so a
 * broken entry cannot open a path outside its release. A newer format than CATALOGUE_FORMAT gives
 * no releases at all (`format` says which it was). A release without `folder` (format 4 and older) has
 * legacyFolder; a folder must belong to the release's controller and to one release only. A release
 * without `type` (format 3 and older) has none; one of format 2 (no `controller`) takes the controller
 * of its `product`, its `title` and `controllers` are dropped. Throws only when the text is not JSON.
 */
export function parseCatalogue(text: string): Catalogue {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const out = emptyCatalogue();
  out.updated = isString(doc?.updated) ? doc.updated : null;
  if (typeof doc?.format === 'number' && Number.isSafeInteger(doc.format) && doc.format > 0) out.format = doc.format;
  if (out.format > CATALOGUE_FORMAT) return out;
  const releases = Array.isArray(doc?.releases) ? doc.releases : [];
  const folders = new Set<string>();
  for (const r of releases as Record<string, unknown>[]) {
    if (!r || !isString(r.version) || !VERSION_RE.test(r.version)) continue;
    const controller = oneOf(IMAGE_CONTROLLERS, r.controller) ? r.controller : controllerOfProduct(r.product);
    const type = normaliseType(r.type);
    if (!controller || type === null || type !== (r.type ?? '')) continue;
    const folder = r.folder === undefined ? legacyFolder(controller, type, r.version) : r.folder;
    if (!isString(folder) || controllerOfFolder(folder) !== controller || folders.has(folder)) continue;
    folders.add(folder);
    const prefix = `${folder}/`;
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
      folder,
      controller,
      type,
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

/** Whether `path` has the shape of a file of a release: images/<product>/<id>/<file> (a file in a release folder). */
export function isReleaseFilePath(path: string): boolean {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === RELEASES_DIR
    && PRODUCT_RE.test(parts[1]) && FOLDER_ID_RE.test(parts[2]) && FILE_NAME_RE.test(parts[3]);
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
