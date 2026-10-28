// The app's own state in the private R2 bucket STATE (gocontroll-deploy-state), as JSON
// objects written only by this Worker. A bucket instead of a D1: when Deploy was made
// (2026-10-21) the account was at the Free-plan D1 limit, and R2 is enough for this data.
// Layout:
//
//   keys/<APP_ID>.json                      active signing key of a folder (private key sealed);
//                                           kept when the folder is deleted
//   keys-retired/<APP_ID>/<timestamp>.json  keys that were replaced; never deleted
//   folders/<APP_ID>.json                   folder settings: customer and controller set by hand,
//                                           distribution URL of an S1 folder made here before its first
//                                           release, the package definition of a Linux application
//   log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version|action>.json   audit of every publish, sign, key, settings and delete action
//   downloads/<yyyy-mm-dd>.json             download counts of a finished UTC day (src/downloads.ts)
//   replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin   a binary that a publish overwrote (src/release.ts)
//   replaced/<APP_ID>/v<version>/<timestamp>/update.tar.gz|manifest.json   a Linux release replaced (src/linux.ts)
//   deleted/<APP_ID>/<timestamp>/<original key>            every object of a deleted folder (src/delete.ts),
//                                           plus folder-settings.json
//   deleting/<APP_ID>.json                  an unfinished delete: its archive timestamp, actor, reason
//   firmware-log/<hw_id>/<version>.json      who published that module firmware from Deploy, from which commit
//                                           (src/firmware.ts); none for a version the module repo's CI published
//   images/releases/<kind>/<product>/<version>.json      a release of images.gocontroll.tech (src/images.ts)
//   images/uploads/<id>.json                an upload to the images bucket that is under way (src/images.ts)
//
// Writes that must not overwrite each other are conditional (an R2 etag): a key is created
// only where none is, replaced only when it is still the one that was read.

import type { Env } from './env';
import { HttpError } from './lib/http';
import type { PackageDefinition } from './linux';

export interface StoredKey {
  app_id: string;
  public_key: string;          // 130 hex, upper case: 04 || X || Y
  sealed_private_key: string;  // v1.<iv>.<ciphertext+tag>, src/keys.ts
  source: 'generated' | 'imported';
  created_at: string;
  created_by: string;
}

/** The controller types a colleague can choose; derived ones can be any controller_series type. */
export const CONTROLLER_TYPES = ['S1', 'M1', 'L4', 'HMI1'] as const;
export type ControllerType = (typeof CONTROLLER_TYPES)[number];

export interface FolderSettings {
  customer_id: number | null;
  controller?: ControllerType | null;  // set by hand; null or absent: derived
  distribution_url?: string | null;    // a folder made here: the host its first release gets
  package?: PackageDefinition | null;   // a Linux application: what its releases hold (src/linux.ts)
  created_at?: string;
  created_by?: string;
  updated_at: string;
  updated_by: string;
}

/** What the overview needs of a folder's settings, from the object's custom metadata. */
export interface SettingsIndexEntry { customer_id: number | null; controller: ControllerType | null; distribution_url: string | null }

export interface Versioned<T> { value: T; etag: string }

const keyPath = (appId: string) => `keys/${appId}.json`;
const folderPath = (appId: string) => `folders/${appId}.json`;

export async function readJson<T>(bucket: R2Bucket, key: string): Promise<Versioned<T> | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return { value: JSON.parse(await obj.text()) as T, etag: obj.etag };
}

/**
 * Write a JSON object. `onlyIf` 'absent' writes only where nothing is, an etag only over
 * that version. Returns false when the condition did not hold (someone else was first).
 */
export async function writeJson(bucket: R2Bucket, key: string, value: unknown, onlyIf?: 'absent' | { etag: string }, customMetadata?: Record<string, string>): Promise<boolean> {
  const options: R2PutOptions = { httpMetadata: { contentType: 'application/json' } };
  if (customMetadata) options.customMetadata = customMetadata;
  if (onlyIf === 'absent') options.onlyIf = new Headers({ 'if-none-match': '*' });
  else if (onlyIf) options.onlyIf = { etagMatches: onlyIf.etag };
  const result = await bucket.put(key, `${JSON.stringify(value, null, 2)}\n`, options);
  return result !== null;
}

/** Every key under `prefix`, all pages. */
export async function listAll(bucket: R2Bucket, options: R2ListOptions): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...options, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ── Signing keys ─────────────────────────────────────────────────────────────

export async function loadKey(env: Env, appId: string): Promise<Versioned<StoredKey> | null> {
  return readJson<StoredKey>(env.STATE, keyPath(appId));
}

/** The App IDs that have an active key (one listing, no reads). */
export async function appIdsWithKey(env: Env): Promise<Set<string>> {
  const objects = await listAll(env.STATE, { prefix: 'keys/' });
  return new Set(objects.map((o) => o.key.slice('keys/'.length)).filter((k) => k.endsWith('.json')).map((k) => k.slice(0, -5)));
}

/**
 * Store the active key of a folder. With `previous` (the key as it was read), the old one is
 * first copied to keys-retired/ and the new one written only if the old is still in place;
 * without it, only where no key is. 409 when someone else changed the key meanwhile.
 */
export async function saveKey(env: Env, appId: string, key: StoredKey, previous: Versioned<StoredKey> | null): Promise<void> {
  if (previous) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeJson(env.STATE, `keys-retired/${appId}/${stamp}.json`, { ...previous.value, retired_at: key.created_at, retired_by: key.created_by });
  }
  const ok = await writeJson(env.STATE, keyPath(appId), key, previous ? { etag: previous.etag } : 'absent');
  if (!ok) throw new HttpError(409, 'The signing key of this folder was changed a moment ago. Reload the page.');
}

// ── Folder settings ──────────────────────────────────────────────────────────

export async function loadFolderSettings(env: Env, appId: string): Promise<FolderSettings | null> {
  return (await readJson<FolderSettings>(env.STATE, folderPath(appId)))?.value ?? null;
}

export async function loadFolderSettingsVersioned(env: Env, appId: string): Promise<Versioned<FolderSettings> | null> {
  return readJson<FolderSettings>(env.STATE, folderPath(appId));
}

/** Marks settings whose custom metadata carries the index (customer, controller, distribution URL). */
const INDEX_VERSION = '2';

const asController = (v: unknown): ControllerType | null => (CONTROLLER_TYPES as readonly unknown[]).includes(v) ? v as ControllerType : null;

/**
 * The settings of every folder from one listing: customer, controller and distribution URL
 * are also kept in the object's custom metadata, so the overview reads no object per folder.
 */
export async function settingsIndex(env: Env): Promise<Map<string, SettingsIndexEntry>> {
  const objects = await listAll(env.STATE, { prefix: 'folders/', include: ['customMetadata'] });
  const out = new Map<string, SettingsIndexEntry>();
  await Promise.all(objects.filter((o) => o.key.endsWith('.json')).map(async (o) => {
    const appId = o.key.slice('folders/'.length, -5);
    const m = o.customMetadata ?? {};
    if (m.index !== INDEX_VERSION) {
      // Written without this index (milestone 1, or put back by hand from an archive): read it.
      const entry = settingsEntry((await readJson<FolderSettings>(env.STATE, o.key))?.value);
      if (entry) out.set(appId, entry);
      return;
    }
    const id = m.customer_id ? Number(m.customer_id) : null;
    out.set(appId, {
      customer_id: Number.isSafeInteger(id) ? id : null,
      controller: asController(m.controller),
      distribution_url: m.distribution_url || null,
    });
  }));
  return out;
}

export function settingsEntry(s: FolderSettings | null | undefined): SettingsIndexEntry | null {
  if (!s) return null;
  return { customer_id: s.customer_id ?? null, controller: asController(s.controller), distribution_url: s.distribution_url ?? null };
}

/**
 * Write a folder's settings. `onlyIf` 'absent' creates them only where none are (a new
 * folder); returns false when the condition did not hold.
 */
export async function saveFolderSettings(env: Env, appId: string, settings: FolderSettings, onlyIf?: 'absent' | { etag: string }): Promise<boolean> {
  return writeJson(env.STATE, folderPath(appId), settings, onlyIf, {
    customer_id: settings.customer_id === null || settings.customer_id === undefined ? '' : String(settings.customer_id),
    controller: settings.controller ?? '',
    distribution_url: settings.distribution_url ?? '',
    index: INDEX_VERSION,
  });
}

export async function deleteFolderSettings(env: Env, appId: string): Promise<void> {
  await env.STATE.delete(folderPath(appId));
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  action: 'publish' | 'publish-linux' | 'sign' | 'key-generate' | 'key-import' | 'key-replace' | 'settings' | 'package' | 'create-folder' | 'delete-folder'
    | 'publish-firmware'
    | 'images-create' | 'images-update' | 'images-delete' | 'images-publish' | 'images-withdraw' | 'images-upload' | 'images-abort' | 'images-remove-file';
  app_id: string;
  version?: string;
  actor: string;
  signed?: boolean;
  replaced?: boolean;
  sha256?: string;
  size?: number;
  description?: string;
  [field: string]: unknown;
}

/** One object per action, never overwritten: log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version|action>.json. */
export async function audit(env: Env, entry: AuditEntry): Promise<string> {
  const at = new Date().toISOString();
  const key = `log/${at.slice(0, 4)}/${at.slice(5, 7)}/${at}-${entry.app_id}-${entry.version ?? entry.action}.json`;
  await writeJson(env.STATE, key, { at, ...entry });
  return key;
}
