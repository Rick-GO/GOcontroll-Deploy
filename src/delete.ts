// Deleting an application folder: the only path that removes objects from the distribution
// bucket, and never without archiving them to STATE first.
//
//   DELETE /api/folders/:appId  { confirm: "<APP_ID>", reason: "<at least 10 characters>", acknowledgeControllers }
//
// Every object under <APP_ID>/ (S1 containers, Linux tarballs and version manifests alike) is
// copied to STATE deleted/<APP_ID>/<ISO timestamp of the first call>/<original key> (body,
// HTTP metadata, custom metadata), its size checked, and only then deleted from the bucket.
// The manifest goes first, alone: no client ever reads a manifest that points at deleted
// binaries. At most BATCH objects per request; the client repeats the same call until `done`.
// The archive timestamp of an unfinished delete is kept in STATE deleting/<APP_ID>.json, so a
// repeat (or a retry after a failure) continues in the same archive. When the bucket holds
// nothing more, the folder settings move to the archive (folder-settings.json), the record goes
// and the delete is logged. The signing key stays: controllers in the field carry its public
// key, and a folder made again under that App ID signs with the same key.

import type { Env, User } from './env';
import { listFolder, manifestKey } from './bucket';
import { HttpError } from './lib/http';
import { controllerGroups } from './moduline';
import { audit, deleteFolderSettings, loadFolderSettingsVersioned, readJson, writeJson, type Versioned } from './state';

export const BATCH = 200;
const PARALLEL = 6;

export interface DeleteBody { confirm: string; reason: string; acknowledgeControllers?: boolean }

interface Deleting {
  app_id: string;
  started_at: string;  // ISO; names the archive
  actor: string;
  reason: string;
  controllers: number;
  deleted: number;     // objects so far, over every call
  bytes: number;
}

const deletingKey = (appId: string) => `deleting/${appId}.json`;
export const archivePrefix = (appId: string, startedAt: string) => `deleted/${appId}/${startedAt}/`;

export async function deleteFolder(env: Env, user: User, appId: string, body: DeleteBody): Promise<{ done: boolean; deleted: number; remaining: number; archive: string }> {
  if (body.confirm !== appId) throw new HttpError(400, 'Type the App ID exactly as it is to confirm.', 'confirm');
  const reason = (body.reason ?? '').trim();
  if (reason.length < 10) throw new HttpError(400, 'Say why the folder goes, in at least 10 characters.', 'reason');

  const controllers = (await controllerGroups(env, appId)).reduce((n, g) => n + g.total, 0);
  if (controllers > 0 && body.acknowledgeControllers !== true) {
    throw new HttpError(409, `${controllers} controller${controllers === 1 ? '' : 's'} still report App ID ${appId}; their cloud updates stop when the folder is gone. Acknowledge that to delete it.`, 'acknowledgeControllers', { controllers });
  }

  const [objects, settings] = await Promise.all([listFolder(env.DEPLOY_BUCKET, appId), loadFolderSettingsVersioned(env, appId)]);
  let record = await readJson<Deleting>(env.STATE, deletingKey(appId));
  if (!record) {
    if (!objects.length && !settings) throw new HttpError(404, `There is nothing to delete in ${appId} (its signing key always stays).`);
    const fresh: Deleting = { app_id: appId, started_at: new Date().toISOString(), actor: user.email, reason, controllers, deleted: 0, bytes: 0 };
    // Two colleagues starting at once: the second continues the first one's archive.
    record = (await writeJson(env.STATE, deletingKey(appId), fresh, 'absent')) ? { value: fresh, etag: '' } : await readJson<Deleting>(env.STATE, deletingKey(appId));
    if (!record) throw new HttpError(409, 'The delete was changed a moment ago. Try again.');
  }
  const archive = archivePrefix(appId, record.value.started_at);

  // The manifest first and alone, then the rest in key order.
  const manifest = objects.find((o) => o.key === manifestKey(appId));
  const rest = objects.filter((o) => o !== manifest).sort((a, b) => (a.key < b.key ? -1 : 1));
  const batch = [...(manifest ? [manifest] : []), ...rest].slice(0, BATCH);
  let deleted = 0;
  let bytes = 0;
  const done = async (items: R2Object[]) => {
    await env.DEPLOY_BUCKET.delete(items.map((o) => o.key));
    deleted += items.length;
    bytes += items.reduce((n, o) => n + o.size, 0);
  };
  try {
    if (manifest) {
      await archiveObject(env, archive, manifest);
      await done([manifest]);
    }
    const others = batch.filter((o) => o !== manifest);
    for (let i = 0; i < others.length; i += PARALLEL) {
      const chunk = others.slice(i, i + PARALLEL);
      await Promise.all(chunk.map((o) => archiveObject(env, archive, o)));
      await done(chunk);
    }
  } finally {
    if (deleted) await saveProgress(env, record, deleted, bytes);
  }

  const remaining = objects.length - batch.length;
  if (remaining > 0) return { done: false, deleted, remaining, archive };

  // The bucket holds nothing more: settings to the archive, the record away, the log entry.
  if (settings) {
    await writeJson(env.STATE, `${archive}folder-settings.json`, settings.value);
    await deleteFolderSettings(env, appId);
  }
  const final = (await readJson<Deleting>(env.STATE, deletingKey(appId)))?.value ?? record.value;
  await audit(env, {
    action: 'delete-folder', app_id: appId, actor: user.email, reason: final.reason, started_by: final.actor,
    started_at: final.started_at, objects: final.deleted, bytes: final.bytes, controllers, archive,
    settings_archived: Boolean(settings),
  }).catch((err) => console.error('audit', err));
  await env.STATE.delete(deletingKey(appId));
  return { done: true, deleted, remaining: 0, archive };
}

/** Copy one object (body + metadata) into the archive and check its size; throws when the copy is not whole. */
async function archiveObject(env: Env, archive: string, obj: R2Object): Promise<void> {
  const src = await env.DEPLOY_BUCKET.get(obj.key);
  if (!src) return; // gone meanwhile (an earlier run deleted it after archiving)
  const copy = await env.STATE.put(`${archive}${obj.key}`, src.body, {
    httpMetadata: src.httpMetadata,
    customMetadata: { ...src.customMetadata, 'archived-etag': src.etag, 'archived-uploaded': src.uploaded.toISOString() },
  });
  if (!copy || copy.size !== src.size) {
    throw new HttpError(500, `Archiving ${obj.key} failed, so it was not deleted. Try again: the delete continues where it stopped.`);
  }
}

async function saveProgress(env: Env, record: Versioned<Deleting>, deleted: number, bytes: number): Promise<void> {
  const now = (await readJson<Deleting>(env.STATE, deletingKey(record.value.app_id)))?.value ?? record.value;
  await writeJson(env.STATE, deletingKey(record.value.app_id), { ...now, deleted: now.deleted + deleted, bytes: now.bytes + bytes });
}

/** Whether a delete of this folder is under way (publishing and creating wait for it). */
export async function deleteUnderWay(env: Env, appId: string): Promise<boolean> {
  return (await env.STATE.head(deletingKey(appId))) !== null;
}
