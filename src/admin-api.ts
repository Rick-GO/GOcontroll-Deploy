// What Deploy gives the hub's admin Worker (gocontroll-admin): the RPC entrypoint AdminApi with the
// tools of the MCP connector and the backup. Contract: GOcontroll-Architecture/cloudflare/admin-api/spec.md.
// No action here: publishing is what Deploy is for and stays with a colleague on the page.
//
// What a tool returns goes to an AI provider, so it never holds a private key, a sealed key, a token,
// or the address of a customer who downloaded an image (the log in gocontroll-images): the tools below
// build every result field by field from the app's own read functions, and the download figures come
// from src/images-stats.ts, which only keeps numbers. imagesOverview is not used here for that reason.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { compareVersions } from './bucket';
import { loadWindow } from './downloads';
import { compareFirmwareVersions, firmwareOverview, type FirmwareModule, type FirmwareRelease } from './firmware';
import { checkGitHub, githubToken } from './github';
import { imageReleases, type ReleaseView } from './images';
import { releaseName } from './images-format';
import { imagesStats } from './images-stats';
import {
  ADMIN_CONTRACT, AdminError, FROM_ARG, LIMIT_ARG, TO_ARG, describeTools, exportFile, exportFiles, exportPlan, exportRows, limitOf, rangeOf, runTool,
  type AdminActor, type AdminTool, type ExportScope,
} from './lib/admin-contract';
import { HttpError } from './lib/http';
import { secretConfigured } from './lib/secret';
import { folderParam } from './lib/validate';
import { controllerGroups } from './moduline';
import { listAll, readJson, sealedKeyCount, writeJson, type AuditEntry } from './state';
import { folderDetail, folderSummaries, type FolderSummary } from './status';
import { APP_VERSION } from './version';

const BASE = 'https://deploy.gocontroll.tools';
const appUrl = (appId: string) => `${BASE}/#/applications/${encodeURIComponent(appId)}`;
const FIRMWARE_URL = `${BASE}/#/firmware`;
const IMAGES_URL = `${BASE}/#/images`;

const DAY_MS = 86_400_000;
const MAX_LOG_READS = 300;
const MAX_LOG_MONTHS = 24;
const DRAFT_DAYS = 14;
const UPLOAD_DAYS = 1;
/** R2 drops a multipart upload that is never completed after this many days. */
const UPLOAD_EXPIRES_DAYS = 7;
/**
 * The last answer of firmware_repos. It takes two or three GitHub calls per repository, on the token
 * that tags and releases need too: asked in a loop it would use up the hourly quota and stop those. In
 * STATE, not in memory, so it holds across isolates.
 */
const REPOS_CACHE_KEY = 'cache/firmware-repos.json';
const REPOS_CACHE_MS = 5 * 60 * 1000;
/** What recent_publications shows unless it is asked for everything. */
const PUBLISHING = new Set(['publish', 'publish-linux', 'publish-firmware', 'github-release', 'images-publish', 'images-withdraw', 'distribution', 'delete-folder']);

const APP_ID_ARG = { type: 'string', maxLength: 200, description: 'App ID of the application (its folder), e.g. from `applications`.' };
const RELATION_ARG = { type: 'integer', minimum: 1, description: 'relations.id of the customer.' };

const page = <T>(items: T[], limit: number) => ({ items: items.slice(0, limit), total: items.length, truncated: items.length > limit });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** An HttpError is a sentence for a person: it reaches the model as an expected failure. */
async function expected<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) throw new AdminError(err.message);
    throw err;
  }
}

function applicationItem(f: FolderSummary) {
  return {
    app_id: f.appId,
    kind: f.kind,
    controller: f.controller,
    customer: f.customer ? { relation_id: f.customer.id, name: f.customer.name } : null,
    latest: f.latest,
    releases: f.releases,
    last_upload: f.lastUpload,
    has_public_key: f.hasKey,
    distribution_url: f.distributionUrl,
    controllers: { total: f.controllers.total, online: f.controllers.online, up_to_date: f.controllers.upToDate },
    url: appUrl(f.appId),
  };
}

/** DD/MM/YY of a module manifest as YYYY-MM-DD; anything else as it is. */
function isoDate(date: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : date;
}

const publisher = (r: FirmwareRelease) => r.publishedBy?.email ?? 'CI';

function moduleItem(m: FirmwareModule) {
  const newest = m.releases[0];
  return {
    id: m.id,
    name: m.name,
    hardware_version: m.hardwareVersion,
    latest_firmware: m.latest,
    newest_release: newest ? { version: newest.version, date: isoDate(newest.date), published_by: publisher(newest) } : null,
    releases: m.releases.length,
    ...(m.error ? { error: m.error } : {}),
    url: FIRMWARE_URL,
  };
}

/** What a release is called: "Moduline HMI1 · 1.07 - AV123 6.12.87". */
const imageLabel = (r: ReleaseView) => `${releaseName(r.controller, r.type)} ${r.version}`;

const bytesOf = (r: ReleaseView) => r.files.reduce((n, f) => n + f.size, 0);

/** The images per system (a controller, or one type of it), each with its latest published release. */
async function imageSystems(env: Env) {
  const [{ releases, uploads, catalogueError }, stats] = await Promise.all([imageReleases(env), imagesStats(env, new Date())]);
  const totals = new Map(stats.releases.map((r) => [r.release, r.total]));
  const systems = new Map<string, typeof releases>();
  for (const r of releases) {
    const key = `${r.controller}|${r.type}`;
    systems.set(key, [...(systems.get(key) ?? []), r]);
  }
  const items = [...systems.values()].map((rows) => {
    const published = rows.filter((r) => r.status === 'published');
    const latest = published[0];
    return {
      name: releaseName(rows[0].controller, rows[0].type),
      controller: rows[0].controller,
      type: rows[0].type || null,
      latest: latest ? {
        version: latest.version,
        released: latest.released,
        published_at: latest.published_at ?? null,
        published_by: latest.published_by ?? null,
        notes: latest.notes.slice(0, 300),
        files: latest.files.length,
        bytes: bytesOf(latest),
        complete_image: latest.files.some((f) => f.role === 'package'),
        downloads: totals.get(latest.key) ?? 0,
      } : null,
      published: published.length,
      drafts: rows.filter((r) => r.status === 'draft').map((r) => ({ version: r.version, created_by: r.created_by, updated_at: r.updated_at })),
    };
  });
  return {
    items,
    total: items.length,
    truncated: false,
    uploads_under_way: uploads.length,
    ...(catalogueError ? { catalogue_error: catalogueError } : {}),
    ...(stats.error ? { downloads_error: stats.error } : {}),
    url: IMAGES_URL,
  };
}

/** "2026/10" of every month from `from` to `to`, at most MAX_LOG_MONTHS. */
function logMonths(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
    out.push(d.toISOString().slice(0, 7).replace('-', '/'));
    if (out.length > MAX_LOG_MONTHS) throw new AdminError(`Ask for at most ${MAX_LOG_MONTHS} months.`);
  }
  return out;
}

type LogEntry = AuditEntry & { at: string };

/** The newest entries of the audit log from `from` to `to`; `more` when there were too many to read. */
async function logEntries(env: Env, from: string, to: string): Promise<{ entries: LogEntry[]; more: boolean }> {
  const listed = await Promise.all(logMonths(from, to).map((m) => listAll(env.STATE, { prefix: `log/${m}/` })));
  const keys = listed.flat().map((o) => o.key).filter((key) => {
    const day = key.slice('log/yyyy/mm/'.length, 'log/yyyy/mm/yyyy-mm-dd'.length);
    return day >= from && day <= to;
  }).sort().reverse();
  const read = await Promise.all(keys.slice(0, MAX_LOG_READS).map((key) => readJson<LogEntry>(env.STATE, key)));
  return { entries: read.flatMap((r) => (r ? [r.value] : [])), more: keys.length > MAX_LOG_READS };
}

/** A line of the audit log, without the manifests, hashes and public keys it holds. */
function logItem(e: LogEntry, labels: Map<string, string>) {
  const image = e.app_id.startsWith('image-') && e.version ? `${e.app_id.slice('image-'.length)}/${e.version}` : null;
  const subject = image ? labels.get(image) ?? image : e.app_id;
  return {
    at: e.at,
    action: e.action,
    subject,
    ...(e.version && !image ? { version: e.version } : {}),
    by: e.actor,
    ...(typeof e.signed === 'boolean' ? { signed: e.signed } : {}),
    ...(typeof e.replaced === 'boolean' ? { replaced: e.replaced } : {}),
    ...(typeof e.description === 'string' && e.description ? { description: e.description.slice(0, 300) } : {}),
  };
}

async function attention(env: Env) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const [folders, firmware, images, deleting, sealed, downloads, github] = await Promise.all([
    folderSummaries(env),
    firmwareOverview(env),
    imageReleases(env),
    listAll(env.STATE, { prefix: 'deleting/' }),
    sealedKeyCount(env),
    secretConfigured(env.CF_API_TOKEN),
    githubToken(env).then(Boolean, () => true),
  ]);
  const items: { severity: 'high' | 'medium' | 'low'; title: string; detail?: string; url?: string; due?: string }[] = [];

  for (const o of deleting) {
    const appId = o.key.slice('deleting/'.length, -'.json'.length);
    items.push({ severity: 'high', title: `Deleting ${appId} did not finish`, detail: 'Its objects are archived in part. Open the application and finish or check it.', url: appUrl(appId) });
  }
  if (firmware.manifestError) items.push({ severity: 'high', title: 'modules/manifest.json cannot be read', detail: firmware.manifestError, url: FIRMWARE_URL });
  for (const m of firmware.modules) {
    if (m.error) items.push({ severity: 'high', title: `Module ${m.id} ${m.name}: ${m.error}`, url: FIRMWARE_URL });
    else if (m.latest && m.releases[0] && m.latest !== m.releases[0].version) {
      items.push({
        severity: 'medium',
        title: `Module ${m.id} ${m.name}: latest_firmware is ${m.latest}, its first release ${m.releases[0].version}`,
        detail: 'Controllers flash the first release of the manifest; the web UI shows latest_firmware.',
        url: FIRMWARE_URL,
      });
    }
  }
  if (images.catalogueError) items.push({ severity: 'high', title: 'manifest.json of images.gocontroll.tech cannot be read', detail: images.catalogueError, url: IMAGES_URL });
  for (const r of images.releases) {
    if (r.status === 'published' && !r.inCatalogue && !images.catalogueError) {
      items.push({ severity: 'high', title: `${imageLabel(r)} is published but not in the catalogue`, detail: 'Customers cannot download it.', url: IMAGES_URL });
    }
    if (r.status === 'draft' && r.updated_at < iso(now - DRAFT_DAYS * DAY_MS)) {
      items.push({ severity: 'low', title: `${imageLabel(r)} is still a draft`, detail: `Last changed ${r.updated_at.slice(0, 10)} by ${r.updated_by}.`, url: IMAGES_URL });
    }
  }
  for (const u of images.uploads) {
    if (u.started_at < iso(now - UPLOAD_DAYS * DAY_MS)) {
      items.push({
        severity: 'medium', title: `The upload of ${u.name} did not finish`, detail: `Started ${u.started_at.slice(0, 10)} by ${u.started_by}.`, url: IMAGES_URL,
        due: iso(Date.parse(u.started_at) + UPLOAD_EXPIRES_DAYS * DAY_MS).slice(0, 10),
      });
    }
  }
  const behind = folders.filter((f) => f.latest && f.controllers.total > f.controllers.upToDate)
    .map((f) => ({ appId: f.appId, n: f.controllers.total - f.controllers.upToDate }))
    .sort((a, b) => b.n - a.n);
  if (behind.length) {
    const count = behind.reduce((n, b) => n + b.n, 0);
    items.push({
      severity: 'low',
      title: `${plural(count, 'controller')} of ${plural(behind.length, 'application')} not on the latest release`,
      detail: behind.slice(0, 10).map((b) => `${b.appId} (${b.n})`).join(', '),
      url: `${BASE}/#/applications`,
    });
  }
  if (sealed) items.push({ severity: 'low', title: `${plural(sealed, 'signing key')} of before 0.7.0 still sealed in Deploy`, detail: 'To decide: export it to 1Password or keep it as a fallback.', url: `${BASE}/#/applications` });
  if (!downloads) items.push({ severity: 'low', title: 'Download counts of S1 applications are off', detail: 'DEPLOY_CF_API_TOKEN is not in the Secrets Store.', url: `${BASE}/#/applications` });
  if (!github) items.push({ severity: 'low', title: 'Deploy cannot tag or release on GitHub', detail: 'DEPLOY_GITHUB_TOKEN is not set.', url: FIRMWARE_URL });
  return { items };
}

/** firmware_repos: the answer of the last REPOS_CACHE_MS, or GitHub's, which is then kept. */
async function firmwareRepos(env: Env) {
  const token = await githubToken(env).catch(() => undefined);
  if (!token) return { configured: false, note: 'GitHub is not set up (DEPLOY_GITHUB_TOKEN).' };
  const cached = await readJson<{ checked_at: string }>(env.STATE, REPOS_CACHE_KEY).catch(() => null);
  if (cached && Date.now() - Date.parse(cached.value.checked_at) < REPOS_CACHE_MS) return cached.value;
  const answer = await askGitHub(env);
  await writeJson(env.STATE, REPOS_CACHE_KEY, answer).catch((err) => console.error(`firmware_repos cache: ${(err as Error).message}`));
  return answer;
}

/** The module repositories Deploy published from, each against its branch on GitHub. */
async function askGitHub(env: Env) {
  const overview = await firmwareOverview(env);
  const newest = new Map<string, { module: string; version: string; at: string; branch: string | null; commit: string }>();
  let unknown = 0;
  for (const m of overview.modules) {
    if (!m.releases.some((r) => r.publishedBy?.source?.commit)) unknown++;
    for (const r of m.releases) {
      const source = r.publishedBy?.source;
      if (!source?.repo || !source.commit) continue;
      // The page stores the name of the folder; the repositories are in one GitHub organisation.
      const repo = source.repo.includes('/') ? source.repo : `GOcontroll/${source.repo}`;
      const had = newest.get(repo);
      if (!had || r.publishedBy!.at > had.at) newest.set(repo, { module: m.id, version: r.version, at: r.publishedBy!.at, branch: source.branch, commit: source.commit });
    }
  }
  const items = await Promise.all([...newest].map(async ([repo, p]) => {
    // One repository GitHub cannot be asked about is a line of its own, not the end of the answer.
    const check = await checkGitHub(env, repo, { branch: p.branch, commit: p.commit }).catch((err: unknown) => {
      if (err instanceof HttpError) return { sync: null, syncError: err.message };
      throw err;
    });
    return {
      repo,
      branch: check.sync?.branch ?? p.branch,
      published: { module: p.module, version: p.version, at: p.at, commit: p.commit.slice(0, 12) },
      state: check.sync?.state ?? null,
      commits_after_publish: check.sync?.githubNewer ?? null,
      newest_commit: check.sync?.head ? { date: check.sync.head.date, subject: check.sync.head.subject } : null,
      ...(check.syncError ? { error: check.syncError } : {}),
    };
  }));
  items.sort((a, b) => (b.commits_after_publish ?? 0) - (a.commits_after_publish ?? 0) || a.repo.localeCompare(b.repo));
  return {
    configured: true,
    checked_at: new Date().toISOString(),
    items,
    total: items.length,
    truncated: false,
    modules_without_a_known_commit: unknown,
    note: 'Only versions published from Deploy name their commit; versions from the CI (until 2026-10-29) do not.',
    url: FIRMWARE_URL,
  };
}

export const TOOLS: AdminTool<Env>[] = [
  {
    name: 'applications',
    title: 'Applications and their latest release',
    description: 'Every application (S1 firmware and Linux packages for M1, L4, HMI1) with its customer, controller type, latest version, number of releases, last upload and how many controllers run it, are online and are up to date, plus totals. Use for "what is deployed" and "what runs at this customer". The public key itself is not given, only whether there is one.',
    input: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['s1', 'linux', 'unknown'], description: 'Only this kind.' },
        controller: { type: 'string', maxLength: 40, description: 'Only this controller type, e.g. S1, M1, L4, HMI1.' },
        relation_id: RELATION_ARG,
        search: { type: 'string', maxLength: 100, description: 'Part of the App ID.' },
        limit: LIMIT_ARG,
      },
      additionalProperties: false,
    },
    kind: 'read',
    async run(env, args) {
      const all = await folderSummaries(env);
      const search = args.search?.toLowerCase();
      const found = all.filter((f) => (args.kind === undefined || f.kind === args.kind)
        && (args.controller === undefined || f.controller?.toLowerCase() === args.controller.toLowerCase())
        && (args.relation_id === undefined || f.customer?.id === args.relation_id)
        && (!search || f.appId.toLowerCase().includes(search)));
      return {
        ...page(found.map(applicationItem), limitOf(args)),
        totals: {
          applications: all.length,
          s1: all.filter((f) => f.kind === 's1').length,
          linux: all.filter((f) => f.kind === 'linux').length,
          releases: all.reduce((n, f) => n + f.releases, 0),
          controllers: all.reduce((n, f) => n + f.controllers.total, 0),
        },
      };
    },
  },
  {
    name: 'application',
    title: 'One application in detail',
    description: 'One application: its releases with date, description, size and whether they are signed with its key, the controllers per version and per distribution host, its customer, and downloads of the last 30 days where counted. Use after `applications`.',
    input: { type: 'object', properties: { app_id: APP_ID_ARG }, required: ['app_id'], additionalProperties: false },
    kind: 'read',
    run: (env, args) => expected(async () => {
      const appId = folderParam(args.app_id);
      const d = await folderDetail(env, appId);
      return {
        app_id: d.appId,
        kind: d.kind,
        controller: d.controller,
        customer: d.customer ? { relation_id: d.customer.id, name: d.customer.name } : null,
        latest: d.latest,
        distribution_url: d.distributionUrl,
        public_key: d.key ? { source: d.key.source, created_at: d.key.createdAt, created_by: d.key.createdBy } : null,
        controllers: {
          total: d.controllers.total,
          online: d.controllers.online,
          up_to_date: d.controllers.upToDate,
          versions: d.controllers.versions,
          hosts: d.controllers.hosts,
        },
        releases: d.releases.map((r) => ({
          version: r.version,
          release_date: r.releaseDate,
          description: r.description,
          size: r.size,
          signed: r.header?.signed ?? null,
          signed_with_this_key: r.keyMatches,
          downloads: r.downloads,
          ...(r.headerError ? { problem: r.headerError } : {}),
        })),
        linux_versions: d.linuxVersions.map((v) => ({ version: v.version, released: v.released, description: v.description, size: v.sizeBytes })),
        downloads: d.downloads.configured
          ? { configured: true, last_30_days: d.downloads.days.reduce((n, day) => n + (day.downloads ?? 0), 0), ...(d.downloads.error ? { error: d.downloads.error } : {}) }
          : { configured: false },
        ...(d.deleting ? { deleting: { started_at: d.deleting.startedAt, actor: d.deleting.actor } } : {}),
        ...(d.manifestError ? { manifest_error: d.manifestError } : {}),
        url: appUrl(d.appId),
      };
    }),
  },
  {
    name: 'rollout',
    title: 'Which controllers lag behind',
    description: 'Per application with controllers: how many run the latest release, how many do not, and the versions they run, most behind first. Use for "is everybody updated". Set `all` to include the applications that are fully up to date.',
    input: { type: 'object', properties: { all: { type: 'boolean', description: 'Also the applications without a controller behind.' }, limit: LIMIT_ARG }, additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const [folders, groups] = await Promise.all([folderSummaries(env), controllerGroups(env)]);
      const items = folders.filter((f) => f.controllers.total > 0).map((f) => {
        const versions = new Map<string, number>();
        for (const g of groups.filter((x) => x.app_id === f.appId)) {
          const v = g.app_version?.trim() || 'unknown';
          versions.set(v, (versions.get(v) ?? 0) + g.total);
        }
        return {
          app_id: f.appId,
          controller: f.controller,
          customer: f.customer?.name ?? null,
          latest: f.latest,
          controllers: f.controllers.total,
          online: f.controllers.online,
          up_to_date: f.controllers.upToDate,
          behind: f.controllers.total - f.controllers.upToDate,
          versions: [...versions].map(([version, count]) => ({ version, count })).sort((a, b) => compareVersions(b.version, a.version)),
          url: appUrl(f.appId),
        };
      }).filter((i) => args.all || i.behind > 0).sort((a, b) => b.behind - a.behind || a.app_id.localeCompare(b.app_id));
      return page(items, limitOf(args));
    },
  },
  {
    name: 'module_firmware',
    title: 'Module firmware',
    description: 'Every plug-in module on firmware.gocontroll.tech with its hardware version, latest_firmware, newest release and who published that (an address, or CI). Use for "which firmware is current on the modules".',
    input: { type: 'object', properties: { search: { type: 'string', maxLength: 100, description: 'Part of the module name or hardware ID.' } }, additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const overview = await firmwareOverview(env);
      const search = args.search?.toLowerCase();
      const found = overview.modules.filter((m) => !search || `${m.id} ${m.name}`.toLowerCase().includes(search));
      return {
        updated: overview.updated,
        ...page(found.map(moduleItem), 200),
        ...(overview.manifestError ? { manifest_error: overview.manifestError } : {}),
        url: FIRMWARE_URL,
      };
    },
  },
  {
    name: 'module_firmware_releases',
    title: 'Firmware history of one module',
    description: 'Every firmware release of one module with its date, changelog, who published it, and for a release from Deploy the repository and commit. Use after `module_firmware`.',
    input: { type: 'object', properties: { hw_id: { type: 'string', pattern: '^\\d{8}$', description: 'Hardware ID, 8 digits.' } }, required: ['hw_id'], additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const overview = await firmwareOverview(env);
      const m = overview.modules.find((x) => x.id === args.hw_id);
      if (!m) throw new AdminError(`There is no module ${args.hw_id} on firmware.gocontroll.tech.`);
      return {
        id: m.id,
        name: m.name,
        latest_firmware: m.latest,
        ...(m.error ? { error: m.error } : {}),
        items: m.releases.map((r) => ({
          version: r.version,
          date: isoDate(r.date),
          changelog: r.changelog,
          published_by: publisher(r),
          published_at: r.publishedBy?.at || null,
          repo: r.publishedBy?.source?.repo ?? null,
          commit: r.publishedBy?.source?.commit?.slice(0, 12) ?? null,
          tag: r.publishedBy?.source?.tag ?? null,
        })),
        total: m.releases.length,
        truncated: false,
        url: FIRMWARE_URL,
      };
    },
  },
  {
    name: 'firmware_repos',
    title: 'Module repositories ahead of what is published',
    description: 'For the module repositories Deploy published from: how many commits their branch on GitHub has after the last published firmware. Asks GitHub at most every 5 minutes; `checked_at` says when. Only versions published from Deploy are known; it says how many modules are not. Use for "is there unpublished firmware work".',
    kind: 'read',
    run: (env) => firmwareRepos(env),
  },
  {
    name: 'images',
    title: 'Images per controller',
    description: 'The Linux images for customers on images.gocontroll.tech per system (a controller, or one type of it such as "1.07 - AV123"): the latest published release with date, files, size, whether it holds a complete image and its downloads, how many are published, and the drafts. Use for "which image is current for the L4".',
    kind: 'read',
    run: (env) => imageSystems(env),
  },
  {
    name: 'image_downloads',
    title: 'Image downloads per month and release',
    description: 'How often images were downloaded from images.gocontroll.tech: per month the downloads, the number of different addresses, per country and per release, and the totals per release. Numbers only, never an address. Use for "who is using the images" in general terms.',
    input: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 60, description: 'How many months back, newest first. Default 12.' } }, additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const [stats, { releases }] = await Promise.all([imagesStats(env, new Date()), imageReleases(env)]);
      if (stats.error) throw new AdminError(stats.error);
      const labels = new Map(releases.map((r) => [r.key, imageLabel(r)]));
      const name = (key: string) => labels.get(key) ?? key;
      return {
        month: stats.month,
        total: stats.total,
        months: stats.months.slice(0, args.months ?? 12).map((m) => ({
          month: m.month,
          downloads: m.downloads,
          different_addresses: m.addresses,
          complete: m.final,
          countries: Object.fromEntries(Object.entries(m.countries).map(([code, n]) => [code || 'unknown', n])),
          releases: Object.entries(m.releases).map(([key, n]) => ({ release: name(key), downloads: n })).sort((a, b) => b.downloads - a.downloads),
        })),
        releases: stats.releases.map((r) => ({ release: name(r.release), total: r.total, this_month: r.thisMonth, last_month: r.lastMonth })),
        url: IMAGES_URL,
      };
    },
  },
  {
    name: 'application_downloads',
    title: 'Downloads of S1 firmware',
    description: 'How often controllers downloaded S1 firmware from the distribution hosts in the last `days` days, per application and per file: an estimate from Cloudflare\'s analytics. Says configured: false while the Cloudflare token is not set.',
    input: {
      type: 'object',
      properties: { app_id: APP_ID_ARG, days: { type: 'integer', minimum: 1, maximum: 30, description: 'Days back, today included. Default 30.' }, limit: LIMIT_ARG },
      additionalProperties: false,
    },
    kind: 'read',
    async run(env, args) {
      const days = args.days ?? 30;
      const window = await loadWindow(env, days);
      if (!window.configured) return { configured: false, note: 'Download counts are off until DEPLOY_CF_API_TOKEN is in the Secrets Store.' };
      const apps = new Map<string, { downloads: number; header_reads: number; manifest_reads: number; files: Map<string, number> }>();
      for (const day of window.known) {
        for (const [appId, a] of Object.entries(day.apps ?? {})) {
          if (args.app_id !== undefined && appId !== args.app_id) continue;
          const total = apps.get(appId) ?? { downloads: 0, header_reads: 0, manifest_reads: 0, files: new Map() };
          total.downloads += a.downloads;
          total.header_reads += a.headerReads;
          total.manifest_reads += a.manifestReads;
          for (const [file, n] of Object.entries(a.bins)) total.files.set(file, (total.files.get(file) ?? 0) + n);
          apps.set(appId, total);
        }
      }
      const items = [...apps].map(([appId, a]) => ({
        app_id: appId, downloads: a.downloads, header_reads: a.header_reads, manifest_reads: a.manifest_reads,
        files: [...a.files].map(([file, n]) => ({ file, downloads: n })).sort((x, y) => y.downloads - x.downloads),
      })).sort((a, b) => b.downloads - a.downloads);
      return { configured: true, days, days_without_counts: window.missingDays, ...(window.error ? { error: window.error } : {}), ...page(items, limitOf(args)) };
    },
  },
  {
    name: 'recent_publications',
    title: 'What was published, and by whom',
    description: 'The audit log, newest first, default the last 30 days: S1 and Linux releases, module firmware, GitHub releases, images published or withdrawn, moved or deleted applications, with who did it and when. Set `all` to include signing, key changes, settings and image drafts.',
    input: { type: 'object', properties: { from: FROM_ARG, to: TO_ARG, all: { type: 'boolean', description: 'Every action, not only what was published.' }, limit: LIMIT_ARG }, additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const { from, to } = rangeOf(args, 30);
      const [{ entries, more }, { releases }] = await Promise.all([logEntries(env, from, to), imageReleases(env)]);
      const labels = new Map(releases.map((r) => [r.key, imageLabel(r)]));
      const wanted = entries.filter((e) => args.all || PUBLISHING.has(e.action));
      const limit = limitOf(args);
      return { from, to, items: wanted.slice(0, limit).map((e) => logItem(e, labels)), total: wanted.length, truncated: more || wanted.length > limit, url: `${BASE}/#/applications` };
    },
  },
  {
    name: 'attention',
    title: 'What needs attention',
    description: 'What needs action in Deploy now: an unfinished delete, firmware or image manifests that cannot be read or do not agree, unfinished uploads, old drafts, controllers behind the latest release, and open setup such as missing tokens. Reads the buckets and databases only.',
    kind: 'read',
    run: (env) => attention(env),
  },
  {
    name: 'customer',
    title: 'One relation in Deploy',
    description: 'The applications of one relation (assigned by hand, or derived from its controllers or a provisioned project), with their controllers, or { none: true }.',
    input: { type: 'object', properties: { relation_id: { type: 'integer', minimum: 1, description: 'relations.id.' } }, required: ['relation_id'], additionalProperties: false },
    kind: 'read',
    async run(env, args) {
      const folders = (await folderSummaries(env)).filter((f) => f.customer?.id === args.relation_id);
      if (!folders.length) return { none: true };
      return {
        relation_id: args.relation_id,
        name: folders[0].customer!.name,
        applications: folders.map(applicationItem),
        controllers: folders.reduce((n, f) => n + f.controllers.total, 0),
        url: `${BASE}/#/applications`,
      };
    },
  },
];

/**
 * The backup: Deploy has no D1, its data is the state bucket, whole, except uploads under way and the
 * cache. The sealed keys of before 0.7.0 stay in as they are: useless without DEPLOY_SIGNING_KEYS_KEY in the
 * Secrets Store, and without them the keys would be gone. Published files stay out: large, and they
 * come from the builds.
 */
export function exportScope(env: Env, scope: string): ExportScope {
  if (scope !== 'deploy') throw new AdminError(`Unknown scope: ${scope}.`);
  return {
    databases: [],
    stores: [{
      name: 'gocontroll-deploy-state',
      store: env.STATE,
      skip: {
        'images/uploads/': 'Uploads under way: R2 drops an upload after 7 days, and it cannot go on after a restore.',
        'cache/': 'Cache: the last answer of GitHub, asked again after 5 minutes.',
      },
    }],
    skipped: [
      { what: 'gocontroll-deploy', reason: 'Release artefacts: S1 binaries and Linux packages, large, and they come from the builds. A replaced or deleted one is archived in gocontroll-deploy-state.' },
      { what: 'gocontroll-firmware', reason: 'Release artefacts: module firmware and its manifests, large, and they come from the builds.' },
      { what: 'gocontroll-images', reason: 'Release artefacts: controller images, large, and they come from the builds. The records of the releases are in gocontroll-deploy-state.' },
      { what: 'gocontroll-images/downloads/', reason: 'Download log with the e-mail address per download, kept 13 months, not in the state bucket. The monthly counts without addresses are (images/stats/).' },
    ],
  };
}

export class AdminApi extends WorkerEntrypoint<Env> {
  describe() {
    return {
      contract: ADMIN_CONTRACT, id: 'deploy', title: 'Deploy', version: APP_VERSION, url: BASE,
      tools: describeTools(TOOLS), scopes: ['deploy'],
    };
  }

  call(name: string, args: object, actor: AdminActor) {
    return runTool(TOOLS, this.env, name, args, actor);
  }

  async exportPlan(scope: string, includeFiles: boolean) {
    return exportPlan(exportScope(this.env, scope), includeFiles);
  }

  async exportRows(scope: string, database: string, table: string, after: number | null, limit: number) {
    return exportRows(exportScope(this.env, scope), database, table, after, limit);
  }

  async exportFiles(scope: string, store: string, cursor: string | null) {
    return exportFiles(exportScope(this.env, scope), store, cursor);
  }

  async exportFile(scope: string, store: string, key: string) {
    return exportFile(exportScope(this.env, scope), store, key);
  }
}
