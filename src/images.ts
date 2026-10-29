// Linux images for the controllers, for customers, in the R2 bucket gocontroll-images
// (IMAGES_BUCKET), which images.gocontroll.tech (the Worker in images/) serves to customers who
// signed in with their e-mail address. This Worker is the only one that writes releases and
// manifest.json; the bucket layout and the catalogue format are in src/images-format.ts.
//
// A release is the image of one controller (L4/M1/HMI1), optionally of one type of it (e.g.
// "1.07 - AV123"), in one version. It has a key <product>/<id> of its own, fixed when it is made:
// its files are in the folder images/<key>/, its record in STATE images/releases/<key>.json, and the
// API, the audit log, the download log and the counts name it by that key. Type and version are
// labels: Edit changes them (controller + type + version stays unique), the folder never moves.
// A new release gets <the controller's product>/<12 hex>; the releases of 0.10.0 and older keep the
// folder they have (images/moduline-hmi1/AV101_6.12.87): their key is that of their record.
//
// A release is first a draft: its files are uploaded into its folder, but customers cannot get them,
// because images.gocontroll.tech serves only what manifest.json names. Publish puts the release in
// manifest.json; Withdraw takes it out again (the files stay). Only a draft can lose files or be
// deleted.
//
// Files can be several GB, more than one request may carry (Cloudflare: ~100 MB), so the browser
// uploads them in parts of PART_SIZE through an R2 multipart upload: start (POST …/files), every
// part (PUT /images/uploads/:id/parts/:n, the raw bytes streamed into R2, never held here), then
// complete. On completion the Worker reads the stored object once and computes its SHA-256
// (crypto.DigestStream), so the checksum customers see is that of what they will download.
//
// What is kept in STATE (gocontroll-deploy-state):
//   images/releases/<key>.json   the release: controller, type, version, date, notes, files,
//                                draft/published, who
//   images/uploads/<id>.json     an upload under way (R2 upload ID, part count, the release's key)
// Records of 0.8.0 named product, title and controllers instead of the controller: read as the
// controller of their product (asRelease), written back in this shape at the next change. Records
// without a type (0.9.x and older) have none. Uploads of 0.10.0 and older name no release: it is
// the folder of their object key.
// Every change is in the audit log (log/…, action images-*, App ID image-<product>, version <id>,
// with the labels). R2 aborts an upload that is never completed after 7 days; its record here is
// shown until someone aborts it.

import { z } from 'zod';
import type { Env, User } from './env';
import { toHex } from './goco';
import { imagesStats, type ImagesStats } from './images-stats';
import { HttpError, parse } from './lib/http';
import { audit, listAll, readJson, writeJson, type Versioned } from './state';
import {
  CATALOGUE_FORMAT, CATALOGUE_KEY, CONTROLLER_PRODUCTS, DOWNLOAD_LOG_PREFIX, FILE_NAME_RE, FILE_ROLES, FOLDER_ID_RE, IMAGE_CONTROLLERS,
  PLATFORMS, PRODUCT_RE, RELEASES_DIR, TYPE_MAX, VERSION_RE, catalogueText, compareLooseVersions, controllerOfFolder, controllerOfProduct,
  emptyCatalogue, normaliseType, parseCatalogue, releaseName, sortReleases, typeSlug,
  type Catalogue, type CatalogueRelease, type DownloadMeta, type FileRole, type ImageController, type Platform,
} from './images-format';

/** Every part but the last has exactly this size (R2 wants equal parts); one request each. */
export const PART_SIZE = 32 * 1024 * 1024;
/** Largest file: 32 GB (R2 allows 10,000 parts; this is a sanity limit, not R2's). */
export const MAX_FILE_SIZE = 32 * 1024 * 1024 * 1024;
const MAX_NOTES = 4000;
const ATTEMPTS = 3;

export interface ImageFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
  role: FileRole;
  platform: Platform;
  uploaded_at: string;
  uploaded_by: string;
}

/** A release as STATE keeps it; its key (and so its folder) is that of the record. */
export interface ImageRelease {
  controller: ImageController;
  type: string;         // label, '' = none
  version: string;      // label
  released: string;
  notes: string;
  files: ImageFile[];
  status: 'draft' | 'published';
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  published_at?: string | null;
  published_by?: string | null;
}

/** A release as the API gives it: with its key and folder. */
export type ReleaseView = ImageRelease & { key: string; folder: string };

interface UploadRecord {
  id: string;
  upload_id: string;    // R2's
  key: string;          // object key: images/<release key>/<name>
  release: string;      // the release's key
  name: string;
  size: number;
  role: FileRole;
  platform: Platform;
  part_size: number;
  parts: number;
  started_at: string;
  started_by: string;
}

/** A release's key: <product>/<id>, the two parts of its folder images/<product>/<id>. */
export interface ReleaseRef { product: string; id: string }

const keyOf = (ref: ReleaseRef) => `${ref.product}/${ref.id}`;
const folderOf = (ref: ReleaseRef) => `${RELEASES_DIR}/${ref.product}/${ref.id}`;
const recordKey = (ref: ReleaseRef) => `images/releases/${ref.product}/${ref.id}.json`;
/** The App ID of a release's entries in the audit log (as before: image-moduline-l4); the id is their version. */
const logId = (ref: ReleaseRef) => `image-${ref.product}`;
const uploadKey = (id: string) => `images/uploads/${id}.json`;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const RECORD_KEY = /^images\/releases\/([^/]+)\/([^/]+)\.json$/;

const isController = (v: unknown): v is ImageController => (IMAGE_CONTROLLERS as readonly unknown[]).includes(v);
const isRef = (ref: ReleaseRef) => PRODUCT_RE.test(ref.product) && FOLDER_ID_RE.test(ref.id);
/** What a release is called in messages: "Moduline HMI1 · 1.07 - AV123 6.12.87". */
const labelOf = (r: { controller: ImageController; type: string; version: string }) => `${releaseName(r.controller, r.type)} ${r.version}`;

/** The key of a release in a URL (/images/releases/<product>/<id>); 404 for anything else. */
export function releaseRef(product: string | undefined, id: string | undefined): ReleaseRef {
  const ref = { product: product ?? '', id: id ?? '' };
  if (!isRef(ref)) throw new HttpError(404, 'Not found.');
  return ref;
}

/** The release key in a key ("moduline-hmi1/AV101_6.12.87"); null when it is none. */
function parseKey(key: unknown): ReleaseRef | null {
  if (typeof key !== 'string') return null;
  const [product, id, ...rest] = key.split('/');
  const ref = { product: product ?? '', id: id ?? '' };
  return !rest.length && isRef(ref) ? ref : null;
}

type Stored<T> = Omit<Partial<T>, 'type'> & { type?: unknown; product?: unknown; title?: unknown; controllers?: unknown; controller?: unknown; version?: unknown };
const storedType = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A release record in this version's shape; null when its controller cannot be told or its folder
 * belongs to another controller. A record of 0.8.0 (product, title, controllers) takes the controller
 * of its product.
 */
function asRelease(raw: Stored<ImageRelease>, ref: ReleaseRef): ImageRelease | null {
  const controller = isController(raw.controller) ? raw.controller : controllerOfProduct(raw.product);
  if (!controller || controllerOfFolder(folderOf(ref)) !== controller) return null;
  const { product: _product, title: _title, controllers: _controllers, ...rest } = raw;
  return { ...(rest as ImageRelease), controller, type: storedType(raw.type), version: typeof raw.version === 'string' ? raw.version : ref.id };
}

/** An upload record in this version's shape: the release's key from the record, or (0.10.0 and older) from its object key. */
function asUpload(raw: Record<string, unknown>): UploadRecord | null {
  if (typeof raw.key !== 'string') return null;
  const release = parseKey(raw.release) ?? parseKey(raw.key.split('/').slice(1, 3).join('/'));
  if (!release || !raw.key.startsWith(`${folderOf(release)}/`)) return null;
  const { product: _p, controller: _c, type: _t, version: _v, ...rest } = raw;
  return { ...(rest as unknown as UploadRecord), release: keyOf(release) };
}

export function uploadParam(id: string | undefined): string {
  if (!UPLOAD_ID.test(id ?? '')) throw new HttpError(404, 'Not found.');
  return id!;
}

const partsOf = (size: number) => Math.max(1, Math.ceil(size / PART_SIZE));
/** The size part n (1-based) of a file must have. */
export const expectedPartSize = (size: number, n: number) => (n < partsOf(size) ? PART_SIZE : size - PART_SIZE * (partsOf(size) - 1));

// ── Reading ──────────────────────────────────────────────────────────────────

async function loadRelease(env: Env, ref: ReleaseRef): Promise<Versioned<ImageRelease>> {
  const rec = await readJson<Stored<ImageRelease>>(env.STATE, recordKey(ref));
  const release = rec ? asRelease(rec.value, ref) : null;
  if (!rec || !release) throw new HttpError(404, 'This release does not exist.');
  return { value: release, etag: rec.etag };
}

/** Every release record (drafts and published), with its key. */
async function allReleases(env: Env): Promise<{ ref: ReleaseRef; release: ImageRelease }[]> {
  const records = await listAll(env.STATE, { prefix: 'images/releases/' });
  const read = await Promise.all(records.map(async (o) => {
    const m = RECORD_KEY.exec(o.key);
    const ref = m ? parseKey(`${m[1]}/${m[2]}`) : null;
    const rec = ref ? await readJson<Stored<ImageRelease>>(env.STATE, o.key) : null;
    const release = ref && rec ? asRelease(rec.value, ref) : null;
    return ref && release ? { ref, release } : null;
  }));
  return read.filter((r): r is { ref: ReleaseRef; release: ImageRelease } => r !== null);
}

async function readCatalogue(env: Env): Promise<{ catalogue: Catalogue; etag: string | null }> {
  const obj = await env.IMAGES_BUCKET.get(CATALOGUE_KEY);
  if (!obj) return { catalogue: emptyCatalogue(), etag: null };
  let catalogue: Catalogue;
  try {
    catalogue = parseCatalogue(await obj.text());
  } catch {
    throw new HttpError(409, 'manifest.json of images.gocontroll.tech is not valid JSON. It has to be repaired before anything is published.');
  }
  // Written by a newer Deploy: rewriting it here would drop what this version cannot read.
  if (catalogue.format > CATALOGUE_FORMAT) {
    throw new HttpError(409, `manifest.json of images.gocontroll.tech has format ${catalogue.format}, newer than this Deploy knows (${CATALOGUE_FORMAT}). Deploy the newer version first.`);
  }
  return { catalogue, etag: obj.etag };
}

export interface DownloadView { at: string; email: string; path: string; product: string; version: string; country: string }

export interface ImagesOverview {
  /** key: <product>/<id>, its URL and the key of its download counts; folder: images/<key>. */
  releases: (ReleaseView & { inCatalogue: boolean })[];
  /** release: the key of the release the upload is for. */
  uploads: Omit<UploadRecord, 'upload_id'>[];
  downloads: DownloadView[];
  stats: ImagesStats;
  catalogueError?: string;
  publicUrl: string;
  limits: { partSize: number; maxFileSize: number };
}

/** Releases (drafts and published), unfinished uploads, the downloads of this and last month and the counts (src/images-stats.ts). */
export async function imagesOverview(env: Env, now = new Date()): Promise<ImagesOverview> {
  const [releases, uploads, downloads, stats] = await Promise.all([
    allReleases(env),
    listAll(env.STATE, { prefix: 'images/uploads/' }),
    recentDownloads(env, now),
    imagesStats(env, now),
  ]);
  const out: ImagesOverview = {
    releases: [],
    uploads: [],
    downloads,
    stats,
    publicUrl: env.IMAGES_URL || 'https://images.gocontroll.tech',
    limits: { partSize: PART_SIZE, maxFileSize: MAX_FILE_SIZE },
  };
  let catalogue = emptyCatalogue();
  try {
    catalogue = (await readCatalogue(env)).catalogue;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    out.catalogueError = err.message;
  }
  const listed = new Set(catalogue.releases.map((r) => r.folder));
  out.releases = releases
    .map(({ ref, release }) => ({ ...release, key: keyOf(ref), folder: folderOf(ref), inCatalogue: listed.has(folderOf(ref)) }))
    .sort((a, b) => IMAGE_CONTROLLERS.indexOf(a.controller) - IMAGE_CONTROLLERS.indexOf(b.controller)
      || compareLooseVersions(a.type, b.type) || b.released.localeCompare(a.released) || b.created_at.localeCompare(a.created_at));
  const ups = await Promise.all(uploads.filter((o) => o.key.endsWith('.json')).map((o) => readJson<Record<string, unknown>>(env.STATE, o.key)));
  out.uploads = ups.map((u) => (u ? asUpload(u.value) : null)).filter((u): u is UploadRecord => u !== null)
    .map(({ upload_id: _, ...rest }) => rest);
  return out;
}

/** The downloads of this month and the one before, newest first, at most 200 (one listing per month, no reads). */
async function recentDownloads(env: Env, now: Date): Promise<DownloadView[]> {
  const months = [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))]
    .map((d) => `${DOWNLOAD_LOG_PREFIX}${d.toISOString().slice(0, 4)}/${d.toISOString().slice(5, 7)}/`);
  const lists = await Promise.all(months.map((prefix) => listAll(env.IMAGES_BUCKET, { prefix, include: ['customMetadata'] })));
  return lists.flat()
    .map((o) => {
      const m = (o.customMetadata ?? {}) as Partial<DownloadMeta>;
      const at = o.key.slice(DOWNLOAD_LOG_PREFIX.length + 8).replace(/-[0-9a-z]+\.json$/, '');
      return { at, email: m.email ?? '', path: m.path ?? '', product: m.product ?? '', version: m.version ?? '', country: m.country ?? '' };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 200);
}

// ── Releases ─────────────────────────────────────────────────────────────────

const ReleaseFields = {
  released: z.string({ message: 'Fill in the release date.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Fill in the release date.'),
  notes: z.string().max(MAX_NOTES, `The notes are at most ${MAX_NOTES} characters.`).default(''),
};
const TypeField = z.string({ message: 'The type is text, e.g. 1.07 - AV123.' }).max(200, `A type is at most ${TYPE_MAX} characters.`);
const VersionField = z.string({ message: 'Fill in the version.' }).trim()
  .regex(VERSION_RE, 'A version is letters, digits and . _ + -, starting with a letter or digit (at most 64).');

const CreateBody = z.object({
  controller: z.enum(IMAGE_CONTROLLERS, { message: `Choose the controller: ${IMAGE_CONTROLLERS.join(', ')}.` }),
  type: TypeField.optional(),
  version: VersionField,
  ...ReleaseFields,
});

/** Edit: date and notes, and the labels type and version (left out = as they are). Never the controller. */
const UpdateBody = z.object({ ...ReleaseFields, type: TypeField.optional(), version: VersionField.optional() });

function checkDate(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Fill in the release date.', 'released');
  return value;
}

const TYPE_RULE = `A type is at most ${TYPE_MAX} characters without accents, with a letter or digit, e.g. 1.07 - AV123.`;

function typeOf(raw: string | undefined): string {
  const type = normaliseType(raw ?? '');
  if (type === null) throw new HttpError(400, TYPE_RULE, 'type');
  return type;
}

/**
 * The labels of a release must be free: no other release of the controller with the same type and
 * version (409, field version), and no other release of it whose type is this one written differently
 * ("1.07-AV123" next to "1.07 - AV123": the same letters and digits, 409, field type). `self` is the
 * release being edited.
 */
async function checkLabels(env: Env, controller: ImageController, type: string, version: string, self?: ReleaseRef): Promise<void> {
  for (const { ref, release } of await allReleases(env)) {
    if (release.controller !== controller || (self && keyOf(ref) === keyOf(self))) continue;
    if (release.type === type && release.version === version) {
      throw new HttpError(409, `${labelOf({ controller, type, version })} exists already. Choose another version or type.`, 'version');
    }
    if (type && release.type && release.type !== type && typeSlug(release.type) === typeSlug(type)) {
      throw new HttpError(409, `The type "${type}" is the type "${release.type}" of the ${releaseName(controller, '')} written differently. Use "${release.type}", or a type that differs in its letters or digits.`, 'type');
    }
  }
}

/** A new release id: 12 hex characters, the second part of its key. */
const newId = () => toHex(crypto.getRandomValues(new Uint8Array(6)));

export async function createRelease(env: Env, user: User, body: unknown): Promise<ReleaseView> {
  const b = parse(CreateBody, body);
  const type = typeOf(b.type);
  await checkLabels(env, b.controller, type, b.version);
  const at = new Date().toISOString();
  const release: ImageRelease = {
    controller: b.controller,
    type,
    version: b.version,
    released: checkDate(b.released),
    notes: b.notes.trim(),
    files: [],
    status: 'draft',
    created_at: at,
    created_by: user.email,
    updated_at: at,
    updated_by: user.email,
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const ref = { product: CONTROLLER_PRODUCTS[b.controller], id: newId() };
    const leftovers = await env.IMAGES_BUCKET.list({ prefix: `${folderOf(ref)}/`, limit: 1 });
    if (leftovers.objects.length) continue;
    if (!(await writeJson(env.STATE, recordKey(ref), release, 'absent'))) continue;
    await audit(env, { action: 'images-create', app_id: logId(ref), version: ref.id, actor: user.email, controller: b.controller, type, label_version: b.version });
    return { ...release, key: keyOf(ref), folder: folderOf(ref) };
  }
  throw new HttpError(503, 'No free folder for the release. Try again.');
}

/**
 * Edit a release, a published one too: its date, notes, type and version (the labels; the controller
 * and the folder stay). A published release is updated in manifest.json too: customers see the new
 * labels at once, its files and links stay as they are.
 */
export async function updateRelease(env: Env, user: User, ref: ReleaseRef, body: unknown): Promise<ReleaseView> {
  const b = parse(UpdateBody, body);
  const rec = await loadRelease(env, ref);
  const type = b.type === undefined ? rec.value.type : typeOf(b.type);
  const version = b.version ?? rec.value.version;
  if (type !== rec.value.type || version !== rec.value.version) await checkLabels(env, rec.value.controller, type, version, ref);
  const release: ImageRelease = {
    ...rec.value,
    type,
    version,
    released: checkDate(b.released),
    notes: b.notes.trim(),
    updated_at: new Date().toISOString(),
    updated_by: user.email,
  };
  if (!(await writeJson(env.STATE, recordKey(ref), release, { etag: rec.etag }))) {
    throw new HttpError(409, 'This release was changed a moment ago. Reload the page.');
  }
  if (release.status === 'published') await updateCatalogue(env, (releases) => [...without(releases, ref), catalogueEntry(release, ref)]);
  await audit(env, {
    action: 'images-update', app_id: logId(ref), version: ref.id, actor: user.email,
    ...(type !== rec.value.type || version !== rec.value.version
      ? { from: { type: rec.value.type, version: rec.value.version }, to: { type, version } } : {}),
  });
  return { ...release, key: keyOf(ref), folder: folderOf(ref) };
}

/** Delete a draft: its files in the bucket, its unfinished uploads and the record. */
export async function deleteRelease(env: Env, user: User, ref: ReleaseRef): Promise<void> {
  const rec = await loadRelease(env, ref);
  if (rec.value.status !== 'draft') throw new HttpError(409, 'Withdraw this release first: customers can still download it.');
  for (const up of await uploadsOf(env, ref)) await abortUpload(env, up);
  const objects = await listAll(env.IMAGES_BUCKET, { prefix: `${folderOf(ref)}/` });
  for (let i = 0; i < objects.length; i += 1000) await env.IMAGES_BUCKET.delete(objects.slice(i, i + 1000).map((o) => o.key));
  await env.STATE.delete(recordKey(ref));
  await audit(env, { action: 'images-delete', app_id: logId(ref), version: ref.id, actor: user.email, files: objects.map((o) => o.key) });
}

export async function publishRelease(env: Env, user: User, ref: ReleaseRef): Promise<ReleaseView> {
  const rec = await loadRelease(env, ref);
  if (!rec.value.files.length) throw new HttpError(409, 'Upload at least one file first.');
  if ((await uploadsOf(env, ref)).length) throw new HttpError(409, 'An upload of this release is not finished. Finish or abort it first.');
  const at = new Date().toISOString();
  const release: ImageRelease = { ...rec.value, status: 'published', published_at: at, published_by: user.email, updated_at: at, updated_by: user.email };
  if (!(await writeJson(env.STATE, recordKey(ref), release, { etag: rec.etag }))) {
    throw new HttpError(409, 'This release was changed a moment ago. Reload the page.');
  }
  await updateCatalogue(env, (releases) => [...without(releases, ref), catalogueEntry(release, ref)]);
  await audit(env, { action: 'images-publish', app_id: logId(ref), version: ref.id, actor: user.email, files: release.files.map((f) => f.path) });
  return { ...release, key: keyOf(ref), folder: folderOf(ref) };
}

export async function withdrawRelease(env: Env, user: User, ref: ReleaseRef): Promise<ReleaseView> {
  const rec = await loadRelease(env, ref);
  // Out of the catalogue first: if the record write fails after, the release is still not downloadable.
  await updateCatalogue(env, (releases) => without(releases, ref));
  const at = new Date().toISOString();
  const release: ImageRelease = { ...rec.value, status: 'draft', updated_at: at, updated_by: user.email };
  if (!(await writeJson(env.STATE, recordKey(ref), release, { etag: rec.etag }))) {
    throw new HttpError(409, 'This release was changed a moment ago. Reload the page.');
  }
  await audit(env, { action: 'images-withdraw', app_id: logId(ref), version: ref.id, actor: user.email });
  return { ...release, key: keyOf(ref), folder: folderOf(ref) };
}

const without = (releases: CatalogueRelease[], ref: ReleaseRef) => releases.filter((r) => r.folder !== folderOf(ref));

/** What customers see of a release: no e-mail addresses, no draft state. */
export function catalogueEntry(r: ImageRelease, ref: ReleaseRef): CatalogueRelease {
  return {
    folder: folderOf(ref),
    controller: r.controller,
    type: r.type,
    version: r.version,
    released: r.released,
    notes: r.notes,
    files: r.files.map((f) => ({ name: f.name, path: f.path, size: f.size, sha256: f.sha256, role: f.role, platform: f.platform })),
  };
}

/** Rewrite manifest.json over the version that was read, in format CATALOGUE_FORMAT; retried when someone else was first. */
async function updateCatalogue(env: Env, change: (releases: CatalogueRelease[]) => CatalogueRelease[]): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { catalogue, etag } = await readCatalogue(env);
    const next: Catalogue = { format: CATALOGUE_FORMAT, updated: new Date().toISOString(), releases: sortReleases(change(catalogue.releases)) };
    const onlyIf = etag ? { etagMatches: etag } : new Headers({ 'if-none-match': '*' });
    const done = await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText(next), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      onlyIf,
    });
    if (done) return;
  }
  throw new HttpError(409, 'manifest.json changed while this was saved. Try again.');
}

// ── Files ────────────────────────────────────────────────────────────────────

const StartBody = z.object({
  name: z.string({ message: 'Choose a file.' }).regex(FILE_NAME_RE, 'A file name is letters, digits and . _ + -, starting with a letter or digit (at most 128). Rename the file.'),
  size: z.number({ message: 'Choose a file.' }).int().positive('The file is empty.').max(MAX_FILE_SIZE, 'A file is at most 32 GB.'),
  role: z.enum(FILE_ROLES, { message: 'Choose what the file is.' }),
  platform: z.enum(PLATFORMS, { message: 'Choose the computer it runs on.' }).default('any'),
});

async function uploadsOf(env: Env, ref: ReleaseRef): Promise<UploadRecord[]> {
  const objects = await listAll(env.STATE, { prefix: 'images/uploads/' });
  const all = await Promise.all(objects.map((o) => readJson<Record<string, unknown>>(env.STATE, o.key)));
  return all.map((u) => (u ? asUpload(u.value) : null)).filter((u): u is UploadRecord => u !== null)
    .filter((u) => u.release === keyOf(ref));
}

function randomId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function startUpload(env: Env, user: User, ref: ReleaseRef, body: unknown): Promise<{ id: string; partSize: number; parts: number }> {
  const b = parse(StartBody, body);
  const rec = await loadRelease(env, ref);
  if (rec.value.status !== 'draft') throw new HttpError(409, 'Withdraw this release before you change its files.');
  if (rec.value.files.some((f) => f.name === b.name)) throw new HttpError(409, `${b.name} is in this release already. Remove it first to upload it again.`, 'name');
  if ((await uploadsOf(env, ref)).some((u) => u.name === b.name)) throw new HttpError(409, `${b.name} is being uploaded already. Abort that upload first.`, 'name');
  const key = `${folderOf(ref)}/${b.name}`;
  const upload = await env.IMAGES_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
  const record: UploadRecord = {
    id: randomId(),
    upload_id: upload.uploadId,
    key,
    release: keyOf(ref),
    name: b.name,
    size: b.size,
    role: b.role,
    platform: b.platform,
    part_size: PART_SIZE,
    parts: partsOf(b.size),
    started_at: new Date().toISOString(),
    started_by: user.email,
  };
  await writeJson(env.STATE, uploadKey(record.id), record, 'absent');
  return { id: record.id, partSize: record.part_size, parts: record.parts };
}

async function loadUpload(env: Env, id: string): Promise<UploadRecord> {
  const rec = await readJson<Record<string, unknown>>(env.STATE, uploadKey(id));
  const up = rec ? asUpload(rec.value) : null;
  if (!up) throw new HttpError(404, 'This upload does not exist any more. Start it again.');
  return up;
}

/** One part, streamed from the request into R2. The size must be exactly what this part has. */
export async function uploadPart(env: Env, id: string, partNumber: number, request: Request): Promise<{ partNumber: number; etag: string }> {
  const up = await loadUpload(env, id);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > up.parts) throw new HttpError(404, 'Not found.');
  const length = Number(request.headers.get('content-length'));
  if (!request.body || length !== expectedPartSize(up.size, partNumber)) {
    throw new HttpError(400, `Part ${partNumber} must be ${expectedPartSize(up.size, partNumber)} bytes.`);
  }
  const part = await env.IMAGES_BUCKET.resumeMultipartUpload(up.key, up.upload_id).uploadPart(partNumber, request.body);
  return { partNumber: part.partNumber, etag: part.etag };
}

const CompleteBody = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) }), { message: 'The parts are missing.' }),
});

/** Finish an upload: R2 joins the parts, the size is checked and the SHA-256 read from the stored object. */
export async function completeUpload(env: Env, user: User, id: string, body: unknown): Promise<ImageFile> {
  const b = parse(CompleteBody, body);
  const up = await loadUpload(env, id);
  const ref = parseKey(up.release)!;
  const numbers = new Set(b.parts.map((p) => p.partNumber));
  if (b.parts.length !== up.parts || numbers.size !== up.parts || [...numbers].some((n) => n > up.parts)) {
    throw new HttpError(400, `Upload all ${up.parts} parts first.`);
  }
  const multipart = env.IMAGES_BUCKET.resumeMultipartUpload(up.key, up.upload_id);
  const stored = await multipart.complete([...b.parts].sort((x, y) => x.partNumber - y.partNumber));
  if (stored.size !== up.size) {
    await env.IMAGES_BUCKET.delete(up.key);
    await env.STATE.delete(uploadKey(id));
    throw new HttpError(422, `The stored file is ${stored.size} bytes instead of ${up.size}. It was removed; upload it again.`);
  }
  const sha256 = await storedDigest(env, up.key);
  const file: ImageFile = {
    name: up.name, path: up.key, size: stored.size, sha256, role: up.role, platform: up.platform,
    uploaded_at: new Date().toISOString(), uploaded_by: user.email,
  };
  for (let attempt = 0; ; attempt++) {
    const rec = await loadRelease(env, ref);
    const release: ImageRelease = { ...rec.value, files: [...rec.value.files.filter((f) => f.name !== file.name), file], updated_at: file.uploaded_at, updated_by: user.email };
    if (await writeJson(env.STATE, recordKey(ref), release, { etag: rec.etag })) break;
    if (attempt + 1 >= ATTEMPTS) throw new HttpError(409, 'The release changed while this file was saved. Reload the page.');
  }
  await env.STATE.delete(uploadKey(id));
  await audit(env, { action: 'images-upload', app_id: logId(ref), version: ref.id, actor: user.email, file: up.key, size: stored.size, sha256 });
  return file;
}

/** SHA-256 of an object in the bucket, read once as a stream (never whole in memory). */
async function storedDigest(env: Env, key: string): Promise<string> {
  const obj = await env.IMAGES_BUCKET.get(key);
  if (!obj) throw new HttpError(500, 'The file just stored cannot be read back.');
  const digest = new crypto.DigestStream('SHA-256');
  await obj.body.pipeTo(digest);
  return toHex(new Uint8Array(await digest.digest));
}

async function abortUpload(env: Env, up: UploadRecord): Promise<void> {
  try {
    await env.IMAGES_BUCKET.resumeMultipartUpload(up.key, up.upload_id).abort();
  } catch (err) {
    // Already completed or aborted (R2 drops an upload after 7 days): nothing left to stop.
    console.warn(`abort ${up.key}: ${err instanceof Error ? err.message : err}`);
  }
  await env.STATE.delete(uploadKey(up.id));
}

export async function cancelUpload(env: Env, user: User, id: string): Promise<void> {
  const up = await loadUpload(env, id);
  await abortUpload(env, up);
  const ref = parseKey(up.release)!;
  await audit(env, { action: 'images-abort', app_id: logId(ref), version: ref.id, actor: user.email, file: up.key });
}

/** Remove a file from a draft (and from the bucket). */
export async function removeFile(env: Env, user: User, ref: ReleaseRef, name: string): Promise<ReleaseView> {
  if (!FILE_NAME_RE.test(name)) throw new HttpError(404, 'Not found.');
  for (let attempt = 0; ; attempt++) {
    const rec = await loadRelease(env, ref);
    if (rec.value.status !== 'draft') throw new HttpError(409, 'Withdraw this release before you change its files.');
    const file = rec.value.files.find((f) => f.name === name);
    if (!file) throw new HttpError(404, 'This file is not in the release.');
    const release: ImageRelease = { ...rec.value, files: rec.value.files.filter((f) => f.name !== name), updated_at: new Date().toISOString(), updated_by: user.email };
    if (await writeJson(env.STATE, recordKey(ref), release, { etag: rec.etag })) {
      await env.IMAGES_BUCKET.delete(file.path);
      await audit(env, { action: 'images-remove-file', app_id: logId(ref), version: ref.id, actor: user.email, file: file.path, sha256: file.sha256 });
      return { ...release, key: keyOf(ref), folder: folderOf(ref) };
    }
    if (attempt + 1 >= ATTEMPTS) throw new HttpError(409, 'This release was changed a moment ago. Reload the page.');
  }
}
