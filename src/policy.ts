// Which versions of an S1 application may be installed (cloud-r2-distribution.md §3, "Which versions
// can be installed"): the manifest's `min_version` and the `withdrawn` flag of a release. The
// publisher sets them on the application's page; every client that installs from the bucket (the
// app, the Service Tool, the Deployment Tool, the dispatch side) follows them, for every controller
// of the App ID at once, without touching a controller.
//
//   min_version absent    only the newest release that is not withdrawn is installable
//   min_version present   every release from that version up that is not withdrawn
//   withdrawn: true       never offered and never installed; the binary stays (publishing the
//                         version again clears it, src/release.ts)
//
// One conditional write of the manifest per change (R2 etag: a change racing another write is a
// 409, never a lost write); the manifest as it stood goes into the log entry (previous_manifest).
// `latest` stays the newest release that is not withdrawn; every other field stays as it is. The
// release that is the only one not withdrawn cannot be withdrawn: there would be nothing to install.

import type { Env, User } from './env';
import {
  installableVersions, manifestKind, manifestLatestOf, minVersionOf, readManifest, s1Entries, settleLatest, writeManifest,
} from './bucket';
import { deleteUnderWay } from './delete';
import { HttpError } from './lib/http';
import { versionField } from './lib/validate';
import { audit, loadFolderSettings } from './state';

export interface PolicyResult {
  appId: string;
  /** null: only the newest release is installable. */
  minVersion: string | null;
  latest: string | null;
  previousLatest: string | null;
  /** Newest first. */
  withdrawn: string[];
  /** Newest first: what a client may install now. */
  installable: string[];
}

/** The S1 manifest of a folder, read and checked; a copy to change, and the etag to write it over. */
async function s1Manifest(env: Env, appId: string): Promise<{ doc: Record<string, unknown>; etag: string; before: Record<string, unknown> }> {
  const [manifest, settings, deleting] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId), loadFolderSettings(env, appId), deleteUnderWay(env, appId),
  ]);
  if (deleting) throw new HttpError(409, `The folder ${appId} is being deleted.`);
  if (settings?.controller && settings.controller !== 'S1') {
    throw new HttpError(422, `${appId} is for ${settings.controller} controllers: which versions may be installed is set in an S1 manifest only.`);
  }
  if (!manifest) throw new HttpError(404, `${appId} has no releases yet: publish one first.`);
  if (manifest.error || !manifest.doc) throw new HttpError(422, `The manifest of ${appId} cannot be read (${manifest.error ?? 'empty'}); fix it first.`);
  if (manifestKind(manifest.doc) !== 's1') throw new HttpError(422, `The manifest of ${appId} is not an S1 manifest; Deploy does not change it.`);
  return { doc: structuredClone(manifest.doc), etag: manifest.etag, before: manifest.doc };
}

async function write(env: Env, appId: string, doc: Record<string, unknown>, etag: string): Promise<void> {
  if (!(await writeManifest(env.DEPLOY_BUCKET, appId, doc, etag))) {
    throw new HttpError(409, `Someone else changed the manifest of ${appId} a moment ago. Reload the page and try again.`);
  }
}

function result(appId: string, doc: Record<string, unknown>, previousLatest: string | null): PolicyResult {
  return {
    appId,
    minVersion: minVersionOf(doc),
    latest: manifestLatestOf(doc),
    previousLatest,
    withdrawn: s1Entries(doc).filter((e) => e.withdrawn).map((e) => e.version),
    installable: installableVersions(doc),
  };
}

/** `doc` with `min_version` set (in its place, or after `latest` when it is new) or removed. */
function placeMinVersion(doc: Record<string, unknown>, value: string | null): Record<string, unknown> {
  if (value !== null && 'min_version' in doc) return { ...doc, min_version: value };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'min_version') continue;
    out[k] = v;
    if (k === 'latest' && value !== null) out.min_version = value;
  }
  if (value !== null && !('min_version' in out)) out.min_version = value;
  return out;
}

/**
 * PUT /api/folders/:appId/min-version: "Earlier versions". `null` removes `min_version` (only the
 * newest is installable); a version sets it, and must be one of the folder's releases.
 */
export async function setMinVersion(env: Env, user: User, appId: string, value: string | null): Promise<PolicyResult> {
  const next = value === null ? null : versionField(value, 'minVersion');
  const loaded = await s1Manifest(env, appId);
  const previous = minVersionOf(loaded.doc);
  if (next !== null && !s1Entries(loaded.doc).some((e) => e.version === next)) {
    throw new HttpError(422, `${next} is not a release of ${appId}: choose one of its published versions.`, 'minVersion');
  }
  if (next === null ? !('min_version' in loaded.doc) : loaded.doc.min_version === next) {
    throw new HttpError(422, next === null ? `Only the newest release of ${appId} is installable already.` : `${appId} is installable from ${next} already.`, 'minVersion');
  }
  const doc = placeMinVersion(loaded.doc, next);
  const previousLatest = manifestLatestOf(doc);
  const latest = settleLatest(doc);
  await write(env, appId, doc, loaded.etag);
  await audit(env, {
    action: 'min-version', app_id: appId, actor: user.email, min_version: next, previous_min_version: previous,
    latest, previous_latest: previousLatest, previous_manifest: loaded.before,
  }).catch((err) => console.error('audit', err));
  return result(appId, doc, previousLatest);
}

/**
 * PUT /api/folders/:appId/releases/:version/withdrawn: withdraw a release (`true`: no client offers
 * or installs it) or restore it (`false`). The only release that is not withdrawn stays.
 */
export async function setWithdrawn(env: Env, user: User, appId: string, versionParam: string, withdrawn: boolean): Promise<PolicyResult> {
  const version = versionField(versionParam);
  const { doc, etag, before } = await s1Manifest(env, appId);
  const entry = (doc.binaries as Record<string, unknown>)[version];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpError(404, `${appId} has no release ${version}.`, 'version');
  const e = entry as Record<string, unknown>;
  if ((e.withdrawn === true) === withdrawn) {
    throw new HttpError(422, withdrawn ? `${version} is withdrawn already.` : `${version} is not withdrawn.`, 'version');
  }
  if (withdrawn) {
    if (!s1Entries(doc).some((r) => !r.withdrawn && r.version !== version)) {
      throw new HttpError(422, `${version} is the only release of ${appId} that is not withdrawn: withdrawn, nothing would be left to install. Publish a release, or restore one, first.`, 'version');
    }
    e.withdrawn = true;
  } else {
    delete e.withdrawn;
  }
  const previousLatest = manifestLatestOf(doc);
  const latest = settleLatest(doc);
  await write(env, appId, doc, etag);
  await audit(env, {
    action: withdrawn ? 'withdraw' : 'restore', app_id: appId, version, actor: user.email,
    latest, previous_latest: previousLatest, previous_manifest: before,
  }).catch((err) => console.error('audit', err));
  return result(appId, doc, previousLatest);
}
