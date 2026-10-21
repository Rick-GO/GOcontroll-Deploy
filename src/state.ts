// The app's own state in the private R2 bucket STATE (gocontroll-deploy-state), as JSON
// objects written only by this Worker. A bucket instead of a D1: when Deploy was made
// (2026-10-21) the account was at the Free-plan D1 limit, and R2 is enough for this data.
// Layout:
//
//   keys/<APP_ID>.json                      active signing key of a folder (private key sealed)
//   keys-retired/<APP_ID>/<timestamp>.json  keys that were replaced; never deleted
//   folders/<APP_ID>.json                   folder settings: the customer assigned by hand
//   log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version|action>.json   audit of every publish, sign and key action
//   downloads/<yyyy-mm-dd>.json             download counts of a finished UTC day (src/downloads.ts)
//   replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin   a binary that a publish overwrote (src/release.ts)
//
// Writes that must not overwrite each other are conditional (an R2 etag): a key is created
// only where none is, replaced only when it is still the one that was read.

import type { Env } from './env';
import { HttpError } from './lib/http';

export interface StoredKey {
  app_id: string;
  public_key: string;          // 130 hex, upper case: 04 || X || Y
  sealed_private_key: string;  // v1.<iv>.<ciphertext+tag>, src/keys.ts
  source: 'generated' | 'imported';
  created_at: string;
  created_by: string;
}

export interface FolderSettings {
  customer_id: number | null;
  updated_at: string;
  updated_by: string;
}

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

/**
 * The customer assigned by hand per folder, from one listing: the id is also kept in the
 * object's custom metadata, so the overview reads no object per folder.
 */
export async function assignedCustomers(env: Env): Promise<Map<string, number | null>> {
  const objects = await listAll(env.STATE, { prefix: 'folders/', include: ['customMetadata'] });
  const out = new Map<string, number | null>();
  for (const o of objects) {
    if (!o.key.endsWith('.json')) continue;
    const raw = o.customMetadata?.customer_id ?? '';
    const id = raw ? Number(raw) : null;
    out.set(o.key.slice('folders/'.length, -5), Number.isSafeInteger(id) ? id : null);
  }
  return out;
}

export async function saveFolderSettings(env: Env, appId: string, settings: FolderSettings): Promise<void> {
  await writeJson(env.STATE, folderPath(appId), settings, undefined, { customer_id: settings.customer_id === null ? '' : String(settings.customer_id) });
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  action: 'publish' | 'sign' | 'key-generate' | 'key-import' | 'key-replace' | 'assign-customer';
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
