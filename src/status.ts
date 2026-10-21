// The status pages: every folder of the bucket with its releases, its customer, its
// controllers and downloads (overview), and one folder in detail.
//
// Customer of a folder, first that applies:
//   manual       assigned by hand in Deploy (STATE folders/<APP_ID>.json)
//   controllers  the most common client_id among the controllers reporting that App ID
//   project      a project whose provisioning names the App ID (gocontroll-db) → its customer
//                in gocontroll-business
//
// Cost (Worker CPU and R2 Class A operations): the overview lists the bucket
// once (not per folder) and reads one manifest per folder; the detail reads one header per
// release with a range read. Nothing is downloaded whole.

import type { Env } from './env';
import {
  compareVersions, distributionUrls, folderDistribution, latestOf, linuxEntries, listBucket, listFolder, manifestKey,
  manifestKind, objectKeyForUrl, readManifest, readStoredHeader, s1Entries, urlDigest, type FolderKind,
} from './bucket';
import { customerNames, projectCustomers } from './business';
import { dayCounts, fileDownloads, lastDays, loadWindow, type DayCounts } from './downloads';
import { toHex } from './goco';
import { controllerGroups, provisionedProjects, type ControllerGroup } from './moduline';
import { appIdsWithKey, assignedCustomers, loadFolderSettings, loadKey } from './state';
import { HttpError } from './lib/http';

export interface FolderCustomer { id: number; name: string; source: 'manual' | 'controllers' | 'project' }

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

// ── Overview ─────────────────────────────────────────────────────────────────

export async function overview(env: Env) {
  const [objects, keyed, manual, groups, window] = await Promise.all([
    listBucket(env.DEPLOY_BUCKET),
    appIdsWithKey(env),
    assignedCustomers(env),
    controllerGroups(env),
    loadWindow(env, 30),
  ]);

  const byFolder = new Map<string, { bytes: number; lastUpload: number | null }>();
  for (const o of objects) {
    const slash = o.key.indexOf('/');
    if (slash <= 0) continue; // an object at the top level is no folder
    const name = o.key.slice(0, slash);
    const f = byFolder.get(name) ?? { bytes: 0, lastUpload: null };
    f.bytes += o.size;
    const t = o.uploaded.getTime();
    if (f.lastUpload === null || t > f.lastUpload) f.lastUpload = t;
    byFolder.set(name, f);
  }
  // A key made before the first release still shows its folder.
  for (const id of keyed) if (!byFolder.has(id)) byFolder.set(id, { bytes: 0, lastUpload: null });

  const sources = await customerSources(env, manual, groups);
  const names = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));
  const folders = await Promise.all(names.map(async (appId) => {
    const stats = byFolder.get(appId)!;
    const manifest = await readManifest(env.DEPLOY_BUCKET, appId);
    const kind: FolderKind = manifestKind(manifest?.doc);
    const latest = latestOf(manifest?.doc, kind);
    const entries = kind === 's1' ? s1Entries(manifest?.doc) : [];
    const releases = kind === 's1' ? entries.length : kind === 'linux' ? linuxEntries(manifest?.doc).length : 0;
    return {
      appId,
      kind,
      latest,
      releases,
      bytes: stats.bytes,
      lastUpload: stats.lastUpload === null ? null : new Date(stats.lastUpload).toISOString(),
      distributionUrl: kind === 's1' ? folderDistribution(entries, latest).distributionUrl : null,
      hasKey: keyed.has(appId),
      customer: resolveCustomer(appId, sources),
      controllers: controllerStats(sources.groups.get(appId) ?? [], latest),
    };
  }));

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

// ── One folder ───────────────────────────────────────────────────────────────

/** The customer of one folder (as in the overview). */
export async function folderCustomer(env: Env, appId: string): Promise<FolderCustomer | null> {
  const [settings, groups] = await Promise.all([loadFolderSettings(env, appId), controllerGroups(env, appId)]);
  const manual = new Map<string, number | null>(settings ? [[appId, settings.customer_id]] : []);
  return resolveCustomer(appId, await customerSources(env, manual, groups, appId));
}

export async function folderDetail(env: Env, appId: string, days = 30) {
  const bases = distributionUrls(env.DISTRIBUTION_URLS);
  const [manifest, objects, key, settings, groups, window] = await Promise.all([
    readManifest(env.DEPLOY_BUCKET, appId),
    listFolder(env.DEPLOY_BUCKET, appId),
    loadKey(env, appId),
    loadFolderSettings(env, appId),
    controllerGroups(env, appId),
    loadWindow(env, days),
  ]);
  if (!manifest && !objects.length && !key && !settings && !groups.length) throw new HttpError(404, `There is no folder ${appId} in the bucket.`);

  const kind = manifestKind(manifest?.doc);
  const latest = latestOf(manifest?.doc, kind);
  const entries = kind === 's1' ? s1Entries(manifest?.doc) : [];
  const { distributionUrl, mixedHosts } = folderDistribution(entries, latest);
  const activeKey = key?.value.public_key ?? null;
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const named = new Set<string>([manifestKey(appId)]);
  const perFile = window.configured ? fileDownloads(window, appId) : null;

  const releases = await Promise.all(entries.map(async (e) => {
    const objectKey = objectKeyForUrl(e.url, bases);
    if (objectKey) named.add(objectKey);
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

  const linux = kind === 'linux' ? linuxEntries(manifest?.doc) : [];
  for (const v of linux) {
    for (const rel of [v.tarball, v.manifest]) if (rel) named.add(`${appId}/${rel.replace(/^\/+/, '')}`);
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
    latest,
    distributionUrl,
    mixedHosts,
    key: key ? { publicKey: key.value.public_key, source: key.value.source, createdAt: key.value.created_at, createdBy: key.value.created_by } : null,
    customer,
    controllers: {
      ...controllerStats(groups, latest),
      versions: [...versions].map(([version, count]) => ({ version, count })).sort((a, b) => compareVersions(b.version, a.version)),
      hosts: [...hosts].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count),
    },
    releases,
    linuxVersions: linux.map(({ version, released, description, sizeBytes, sha256 }) => ({ version, released, description, sizeBytes, sha256 })),
    otherObjects: objects.filter((o) => !named.has(o.key)).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
    downloads: downloadDays(window, appId),
    ...(manifest?.error ? { manifestError: manifest.error } : {}),
  };
}

export function downloadDays(window: Awaited<ReturnType<typeof loadWindow>>, appId?: string): { configured: boolean; days: DayCounts[]; error?: string; missingDays?: number } {
  if (!window.configured) return { configured: false, days: [] };
  return { configured: true, days: dayCounts(window, appId), missingDays: window.missingDays, ...(window.error ? { error: window.error } : {}) };
}
