// Moving an S1 application to another distribution host (cloud-r2-distribution.md §2.1, step 2):
// the host of every URL in its manifest, in one conditional write. Both hosts serve the same
// bucket, so no binary moves; the path, `?v=`, the signatures and the hashes stay as they are.
// Step 1 (CONFIG 0x35 of its controllers) and step 3 (distribution_url in its .cred file) are the
// Deployment Tool's. A folder without releases only gets the host its first release takes.

import type { Env, User } from './env';
import { distributionUrls, folderDistribution, latestOf, manifestKind, readManifest, s1Entries, urlBase, writeManifest } from './bucket';
import { deleteUnderWay } from './delete';
import { HttpError } from './lib/http';
import { audit, loadFolderSettingsVersioned, saveFolderSettings } from './state';

export interface MoveResult {
  appId: string;
  distributionUrl: string;
  previous: string | null;
  moved: number; // manifest URLs that changed host
}

export async function moveDistribution(env: Env, user: User, appId: string, target: string): Promise<MoveResult> {
  const bases = distributionUrls(env.DISTRIBUTION_URLS);
  const to = target.trim().replace(/\/+$/, '');
  if (!bases.includes(to)) throw new HttpError(422, `The distribution URL must be one of ${bases.join(', ')}.`, 'distributionUrl');

  const [manifest, settings, deleting] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId), loadFolderSettingsVersioned(env, appId), deleteUnderWay(env, appId),
  ]);
  if (deleting) throw new HttpError(409, `The folder ${appId} is being deleted.`);
  const own = settings?.value ?? null;
  if (own?.controller && own.controller !== 'S1') {
    throw new HttpError(422, `${appId} is for ${own.controller} controllers: only an S1 manifest names a distribution host.`);
  }
  if (manifest?.error) throw new HttpError(422, `The manifest of ${appId} cannot be read (${manifest.error}); fix it first.`);
  const doc: Record<string, unknown> = manifest?.doc ? structuredClone(manifest.doc) : {};
  const kind = manifestKind(doc);
  if (Object.keys(doc).length && kind !== 's1') throw new HttpError(422, `The manifest of ${appId} is not an S1 manifest; Deploy does not change it.`);

  const entries = kind === 's1' ? s1Entries(doc) : [];
  if (!entries.length && !own) throw new HttpError(404, `There is no S1 application ${appId}.`);
  const previous = entries.length ? folderDistribution(entries, latestOf(doc, 's1')).distributionUrl : own?.distribution_url ?? null;

  // Every URL must be one of the bucket's own: a URL elsewhere is not Deploy's to rewrite.
  let moved = 0;
  for (const [version, entry] of Object.entries((doc.binaries ?? {}) as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === 'string' ? e.url : '';
    const base = urlBase(url);
    if (!base || !bases.includes(base)) {
      throw new HttpError(422, `The URL of ${version} (${url || 'none'}) is not on one of this bucket’s distribution URLs; Deploy does not change the manifest.`);
    }
    if (base === to) continue;
    const u = new URL(url);
    e.url = `${to}${u.pathname}${u.search}${u.hash}`;
    moved++;
  }
  const settingsMoves = Boolean(own) && own!.distribution_url !== to;
  if (!moved && !settingsMoves) throw new HttpError(422, `${appId} is on ${to} already.`, 'distributionUrl');

  if (moved) {
    if (!(await writeManifest(env.DEPLOY_BUCKET, appId, doc, manifest!.etag))) {
      throw new HttpError(409, `Someone else changed the manifest of ${appId} a moment ago. Reload the page and try again.`);
    }
  }
  if (settingsMoves) {
    const now = new Date().toISOString();
    const saved = await saveFolderSettings(env, appId, { ...own!, distribution_url: to, updated_at: now, updated_by: user.email }, { etag: settings!.etag });
    // Without releases the settings are the host; with releases the manifest is, and it moved already.
    if (!saved && !entries.length) throw new HttpError(409, 'The settings of this folder were changed a moment ago. Reload the page.');
    if (!saved) console.error(`settings of ${appId} not moved to ${to}: changed meanwhile`);
  }
  await audit(env, {
    action: 'distribution', app_id: appId, actor: user.email, from: previous, to, moved,
    // The way back: the manifest as it stood (or move it back the same way).
    previous_manifest: moved ? manifest!.doc : null,
  }).catch((err) => console.error('audit', err));
  return { appId, distributionUrl: to, previous, moved };
}
