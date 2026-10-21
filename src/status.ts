// The status pages: every folder (application) with its releases, customer, controller type,
// controllers and downloads (overview), one folder in detail, and the keys list.
//
// A folder is what the bucket holds under <APP_ID>/, a signing key (STATE keys/), or settings
// (STATE folders/: a folder made here before its first release, or a customer or controller
// set by hand). Any of the three makes it show.
//
// Customer of a folder, first that applies:
//   manual       assigned by hand in Deploy (STATE folders/<APP_ID>.json customer_id)
//   controllers  the most common client_id among the controllers reporting that App ID
//   project      a project whose provisioning names the App ID (gocontroll-db) → its customer
//                in gocontroll-business
//
// Controller type of a folder ("S1", "M1", "L4", "HMI1", or another controller_series type
// without its "Moduline " prefix), first that applies:
//   manual       set by hand (folders/<APP_ID>.json controller)
//   manifest     an S1 manifest (`binaries`) means S1
//   controllers  the most common controller_series.controller_type of the controllers on that
//                App ID; for a Linux manifest the S1 ones are left out (one App ID can have both)
//
// Cost (Worker CPU and R2 Class A operations): the overview lists the bucket once (not per
// folder) and reads one manifest per folder; the detail reads one header per release with a
// range read. Nothing is downloaded whole.

import type { Env } from './env';
import {
  compareVersions, distributionUrls, folderDistribution, latestOf, linuxEntries, listBucket, listFolder, manifestKey,
  manifestKind, objectKeyForUrl, readManifest, readStoredHeader, s1Entries, urlDigest, type FolderKind,
} from './bucket';
import { customerNames, projectCustomers } from './business';
import { dayCounts, fileDownloads, lastDays, loadWindow, type DayCounts } from './downloads';
import { toHex } from './goco';
import { controllerGroups, provisionedProjects, type ControllerGroup } from './moduline';
import {
  appIdsWithKey, listAll, loadFolderSettings, loadKey, readJson, settingsEntry, settingsIndex,
  type ControllerType, type SettingsIndexEntry, type StoredKey,
} from './state';
import { HttpError } from './lib/http';

export interface FolderCustomer { id: number; name: string; source: 'manual' | 'controllers' | 'project' }
export type ControllerSource = 'manual' | 'manifest' | 'controllers' | null;

interface ControllerStats { total: number; online: number; upToDate: number }

/** Controller counts of one App ID. Up to date: on the folder's latest version, or (latest unknown) app_uptodate. */
function controllerStats(groups: ControllerGroup[], latest: string | null): ControllerStats {
  let total = 0, online = 0, upToDate = 0;
  for (const g of groups) {
    total += g.total;
    online += g.online;
    upToDate += latest ? (g.app_version?.trim() === latest ? g.total : 0) : g.up_to_date;
  }
  return { total, online, upToDate };
}

/** The most common client_id of one App ID's controllers (ties: the lowest id). */
function controllerCustomer(groups: ControllerGroup[]): number | null {
  const counts = new Map<number, number>();
  for (const g of groups) if (g.client_id !== null && g.client_id !== undefined) counts.set(g.client_id, (counts.get(g.client_id) ?? 0) + g.total);
  let best: number | null = null;
  for (const [id, n] of counts) if (best === null || n > counts.get(best)! || (n === counts.get(best)! && id < best)) best = id;
  return best;
}

/** "Moduline S1" → "S1"; anything else as it is, trimmed. */
export const controllerTypeName = (type: string) => type.trim().replace(/^Moduline\s+/i, '');

/**
 * The controller type of a folder: manual → an S1 manifest → the most common type of its
 * controllers (for a Linux manifest without the S1 ones; ties: alphabetical) → null.
 */
export function resolveController(manifestKindOfFolder: FolderKind, manual: ControllerType | null | undefined, groups: ControllerGroup[]): { controller: string | null; controllerSource: ControllerSource } {
  if (manual) return { controller: manual, controllerSource: 'manual' };
  if (manifestKindOfFolder === 's1') return { controller: 'S1', controllerSource: 'manifest' };
  const counts = new Map<string, number>();
  for (const g of groups) {
    if (!g.controller_type || !g.controller_type.trim()) continue;
    const name = controllerTypeName(g.controller_type);
    if (manifestKindOfFolder === 'linux' && name.toUpperCase() === 'S1') continue;
    counts.set(name, (counts.get(name) ?? 0) + g.total);
  }
  let best: string | null = null;
  for (const [name, n] of counts) if (best === null || n > counts.get(best)! || (n === counts.get(best)! && name < best)) best = name;
  return best ? { controller: best, controllerSource: 'controllers' } : { controller: null, controllerSource: null };
}

/**
 * The kind of a folder: its manifest's; without a manifest, S1 when its settings say S1, or
 * when it has a signing key and no controller set (keys are only made for S1 folders).
 */
export function folderKind(manifestDoc: Record<string, unknown> | null | undefined, hasManifest: boolean, settings: SettingsIndexEntry | null | undefined, hasKey: boolean): FolderKind {
  const kind = manifestKind(manifestDoc);
  if (kind !== 'unknown' || hasManifest) return kind;
  if (settings?.controller === 'S1') return 's1';
  if (hasKey && !settings?.controller) return 's1';
  return 'unknown';
}

interface CustomerSources {
  manual: Map<string, number | null>;
  groups: Map<string, ControllerGroup[]>;
  projects: Map<string, number[]>;           // app id → project ids
  projectCustomer: Map<number, number>;       // project id → customer id
  names: Map<number, string>;
}

function resolveCustomer(appId: string, s: CustomerSources): FolderCustomer | null {
  const named = (id: number | null | undefined, source: FolderCustomer['source']): FolderCustomer | null =>
    id !== null && id !== undefined && s.names.has(id) ? { id, name: s.names.get(id)!, source } : null;
  const manual = s.manual.get(appId);
  if (manual !== undefined && manual !== null) {
    // A customer that no longer exists falls through to the derived one.
    const c = named(manual, 'manual');
    if (c) return c;
  }
  const fromControllers = named(controllerCustomer(s.groups.get(appId) ?? []), 'controllers');
  if (fromControllers) return fromControllers;
  for (const p of (s.projects.get(appId) ?? []).sort((a, b) => a - b)) {
    const c = named(s.projectCustomer.get(p), 'project');
    if (c) return c;
  }
  return null;
}

async function customerSources(env: Env, manual: Map<string, number | null>, groups: ControllerGroup[], appId?: string): Promise<CustomerSources> {
  const byApp = new Map<string, ControllerGroup[]>();
  for (const g of groups) byApp.set(g.app_id, [...(byApp.get(g.app_id) ?? []), g]);
  const provisioned = await provisionedProjects(env, appId);
  const projects = new Map<string, number[]>();
  for (const p of provisioned) projects.set(p.app_id, [...(projects.get(p.app_id) ?? []), p.project_id]);
  const projectCustomer = await projectCustomers(env, provisioned.map((p) => p.project_id));
  const ids = [
    ...[...manual.values()].filter((v): v is number => v !== null),
    ...groups.map((g) => g.client_id).filter((v): v is number => v !== null && v !== undefined),
    ...projectCustomer.values(),
  ];
  return { manual, groups: byApp, projects, projectCustomer, names: await customerNames(env, ids) };
}

// ── Every folder ─────────────────────────────────────────────────────────────

export interface FolderSummary {
  appId: string;
  kind: FolderKind;
  controller: string | null;
  controllerSource: ControllerSource;
  latest: string | null;
  releases: number;
  bytes: number;
  lastUpload: string | null;
  distributionUrl: string | null;
  hasKey: boolean;
  inBucket: boolean;
  customer: FolderCustomer | null;
  controllers: ControllerStats;
}

/** Every folder: what the bucket holds, every key and every settings record. */
export async function folderSummaries(env: Env): Promise<FolderSummary[]> {
  const [objects, keyed, settings, groups] = await Promise.all([
    listBucket(env.DEPLOY_BUCKET),
    appIdsWithKey(env),
    settingsIndex(env),
    controllerGroups(env),
  ]);

  const byFolder = new Map<string, { bytes: number; lastUpload: number | null; objects: number }>();
  for (const o of objects) {
    const slash = o.key.indexOf('/');
    if (slash <= 0) continue; // an object at the top level is no folder
    const name = o.key.slice(0, slash);
    const f = byFolder.get(name) ?? { bytes: 0, lastUpload: null, objects: 0 };
    f.bytes += o.size;
    f.objects++;
    const t = o.uploaded.getTime();
    if (f.lastUpload === null || t > f.lastUpload) f.lastUpload = t;
    byFolder.set(name, f);
  }
  // A key or settings made before the first release still show their folder.
  for (const id of [...keyed, ...settings.keys()]) if (!byFolder.has(id)) byFolder.set(id, { bytes: 0, lastUpload: null, objects: 0 });

  const manual = new Map<string, number | null>([...settings].map(([id, s]) => [id, s.customer_id]));
  const sources = await customerSources(env, manual, groups);
  const names = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map(async (appId) => {
    const stats = byFolder.get(appId)!;
    const own = settings.get(appId) ?? null;
    const manifest = stats.objects ? await readManifest(env.DEPLOY_BUCKET, appId) : null;
    const realKind = manifestKind(manifest?.doc);
    const kind = folderKind(manifest?.doc, Boolean(manifest), own, keyed.has(appId));
    const latest = latestOf(manifest?.doc, realKind);
    const entries = realKind === 's1' ? s1Entries(manifest?.doc) : [];
    const releases = realKind === 's1' ? entries.length : realKind === 'linux' ? linuxEntries(manifest?.doc).length : 0;
    const appGroups = sources.groups.get(appId) ?? [];
    return {
      appId,
      kind,
      ...resolveController(realKind, own?.controller, appGroups),
      latest,
      releases,
      bytes: stats.bytes,
      lastUpload: stats.lastUpload === null ? null : new Date(stats.lastUpload).toISOString(),
      distributionUrl: entries.length ? folderDistribution(entries, latest).distributionUrl : kind === 's1' ? own?.distribution_url ?? null : null,
      hasKey: keyed.has(appId),
      inBucket: stats.objects > 0,
      customer: resolveCustomer(appId, sources),
      controllers: controllerStats(appGroups, latest),
    };
  }));
}

export async function overview(env: Env) {
  const [folders, window] = await Promise.all([folderSummaries(env), loadWindow(env, 30)]);

  const perCustomer = new Map<number, { id: number; name: string; folders: string[] }>();
  for (const f of folders) {
    if (!f.customer) continue;
    const c = perCustomer.get(f.customer.id) ?? { id: f.customer.id, name: f.customer.name, folders: [] };
    c.folders.push(f.appId);
    perCustomer.set(f.customer.id, c);
  }

  return {
    folders,
    // The bucket's distribution URLs (DISTRIBUTION_URLS): the choice for a new folder, the first the default.
    distributionUrls: distributionUrls(env.DISTRIBUTION_URLS),
    customers: [...perCustomer.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id),
    totals: {
      folders: folders.length,
      s1Folders: folders.filter((f) => f.kind === 's1').length,
      linuxFolders: folders.filter((f) => f.kind === 'linux').length,
      releases: folders.reduce((n, f) => n + f.releases, 0),
      bytes: folders.reduce((n, f) => n + f.bytes, 0),
      controllers: folders.reduce((n, f) => n + f.controllers.total, 0),
    },
    downloads: {
      configured: window.configured,
      last7: window.configured ? lastDays(window, 7) : null,
      last30: window.configured ? lastDays(window, 30) : null,
      ...(window.error ? { error: window.error } : {}),
      ...(window.configured ? { missingDays: window.missingDays } : {}),
    },
  };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** Every folder's key, and the S1 folders that have none (the Keys page). */
export async function keysList(env: Env) {
  const [folders, keyObjects] = await Promise.all([folderSummaries(env), listAll(env.STATE, { prefix: 'keys/' })]);
  const byId = new Map(folders.map((f) => [f.appId, f]));
  const stored = await Promise.all(keyObjects.filter((o) => o.key.endsWith('.json')).map(async (o) => (await readJson<StoredKey>(env.STATE, o.key))?.value ?? null));
  const keys = stored
    .filter((k): k is StoredKey => Boolean(k))
    .sort((a, b) => a.app_id.localeCompare(b.app_id))
    .map((k) => {
      const f = byId.get(k.app_id);
      return {
        appId: k.app_id, publicKey: k.public_key, source: k.source, createdAt: k.created_at, createdBy: k.created_by,
        inBucket: f?.inBucket ?? false, customer: f?.customer ?? null, controller: f?.controller ?? null,
      };
    });
  const withoutKey = folders
    .filter((f) => !f.hasKey && (f.kind === 's1' || f.controller === 'S1'))
    .map((f) => ({ appId: f.appId, customer: f.customer, controller: f.controller }));
  return { keys, withoutKey };
}

// ── One folder ───────────────────────────────────────────────────────────────

/** The customer and controller type of one folder (as in the overview). */
export async function folderIdentity(env: Env, appId: string): Promise<{ customer: FolderCustomer | null; controller: string | null; controllerSource: ControllerSource }> {
  const [settings, groups, manifest] = await Promise.all([loadFolderSettings(env, appId), controllerGroups(env, appId), readManifest(env.DEPLOY_BUCKET, appId)]);
  const manual = new Map<string, number | null>(settings ? [[appId, settings.customer_id]] : []);
  const customer = resolveCustomer(appId, await customerSources(env, manual, groups, appId));
  return { customer, ...resolveController(manifestKind(manifest?.doc), settingsEntry(settings)?.controller, groups) };
}

export async function folderDetail(env: Env, appId: string, days = 30) {
  const bases = distributionUrls(env.DISTRIBUTION_URLS);
  const [manifest, objects, key, settings, groups, window, deleting] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId),
    listFolder(env.DEPLOY_BUCKET, appId),
    loadKey(env, appId),
    loadFolderSettings(env, appId),
    controllerGroups(env, appId),
    loadWindow(env, days),
    readJson<{ started_at: string; actor: string; reason: string }>(env.STATE, `deleting/${appId}.json`),
  ]);
  if (!manifest && !objects.length && !key && !settings && !groups.length && !deleting) throw new HttpError(404, `There is no folder ${appId} in the bucket.`);

  const own = settingsEntry(settings);
  const realKind = manifestKind(manifest?.doc);
  const kind = folderKind(manifest?.doc, Boolean(manifest), own, Boolean(key));
  const latest = latestOf(manifest?.doc, realKind);
  const entries = realKind === 's1' ? s1Entries(manifest?.doc) : [];
  const named = folderDistribution(entries, latest);
  const distributionUrl = entries.length ? named.distributionUrl : kind === 's1' ? own?.distribution_url ?? null : null;
  const activeKey = key?.value.public_key ?? null;
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const namedKeys = new Set<string>([manifestKey(appId)]);
  const perFile = window.configured ? fileDownloads(window, appId) : null;

  const releases = await Promise.all(entries.map(async (e) => {
    const objectKey = objectKeyForUrl(e.url, bases);
    if (objectKey) namedKeys.add(objectKey);
    const obj = objectKey ? byKey.get(objectKey) : undefined;
    let header = null;
    let headerError: string | null = null;
    if (!objectKey) headerError = 'The URL is outside this bucket’s distribution URLs.';
    else if (!obj) headerError = 'The binary is not in the bucket.';
    else {
      const read = await readStoredHeader(env.DEPLOY_BUCKET, objectKey, obj.size);
      if (read.error) headerError = read.error;
      else if (read.header) {
        const h = read.header;
        header = {
          headerVersion: h.headerVersion, signed: h.signed, appId: h.appId, version: h.version,
          compressedSize: h.compressedSize, uncompressedSize: h.uncompressedSize, sha256: toHex(h.sha256),
          publicKey: h.publicKey ? toHex(h.publicKey).toUpperCase() : null,
        };
        if (h.appId !== appId || h.version !== e.version) headerError = `The header names ${h.appId} ${h.version}, not ${appId} ${e.version}.`;
        else if (h.headerSize + h.compressedSize !== obj.size) headerError = `The object is ${obj.size} bytes; its header says ${h.headerSize + h.compressedSize}.`;
      }
    }
    const digest = urlDigest(e.url);
    const file = objectKey ? objectKey.slice(objectKey.lastIndexOf('/') + 1) : null;
    return {
      version: e.version,
      url: e.url,
      releaseDate: e.releaseDate,
      description: e.description,
      objectKey,
      size: obj?.size ?? null,
      uploaded: obj ? obj.uploaded.toISOString() : null,
      header,
      headerError,
      keyMatches: header && activeKey ? header.signed && header.publicKey === activeKey : null,
      digestMatches: header && digest ? header.sha256.startsWith(digest) : null,
      downloads: perFile && file ? perFile.get(file) ?? 0 : null,
    };
  }));

  const linux = realKind === 'linux' ? linuxEntries(manifest?.doc) : [];
  for (const v of linux) {
    for (const rel of [v.tarball, v.manifest]) if (rel) namedKeys.add(`${appId}/${rel.replace(/^\/+/, '')}`);
  }

  const versions = new Map<string, number>();
  const hosts = new Map<string, number>();
  for (const g of groups) {
    const v = g.app_version?.trim() || 'unknown';
    versions.set(v, (versions.get(v) ?? 0) + g.total);
    const h = g.distribution_url?.trim() || '';
    if (h) hosts.set(h, (hosts.get(h) ?? 0) + g.total);
  }

  const manual = new Map<string, number | null>(settings ? [[appId, settings.customer_id]] : []);
  const customer = resolveCustomer(appId, await customerSources(env, manual, groups, appId));

  return {
    appId,
    kind,
    ...resolveController(realKind, own?.controller, groups),
    latest,
    distributionUrl,
    mixedHosts: named.mixedHosts,
    key: key ? { publicKey: key.value.public_key, source: key.value.source, createdAt: key.value.created_at, createdBy: key.value.created_by } : null,
    customer,
    controllers: {
      ...controllerStats(groups, latest),
      versions: [...versions].map(([version, count]) => ({ version, count })).sort((a, b) => compareVersions(b.version, a.version)),
      hosts: [...hosts].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count),
    },
    releases,
    linuxVersions: linux.map(({ version, released, description, sizeBytes, sha256 }) => ({ version, released, description, sizeBytes, sha256 })),
    otherObjects: objects.filter((o) => !namedKeys.has(o.key)).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
    // What a delete would take: every object under the folder.
    objects: { count: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0) },
    deleting: deleting ? { startedAt: deleting.value.started_at, actor: deleting.value.actor, reason: deleting.value.reason } : null,
    downloads: downloadDays(window, appId),
    ...(manifest?.error ? { manifestError: manifest.error } : {}),
  };
}

export function downloadDays(window: Awaited<ReturnType<typeof loadWindow>>, appId?: string): { configured: boolean; days: DayCounts[]; error?: string; missingDays?: number } {
  if (!window.configured) return { configured: false, days: [] };
  return { configured: true, days: dayCounts(window, appId), missingDays: window.missingDays, ...(window.error ? { error: window.error } : {}) };
}
