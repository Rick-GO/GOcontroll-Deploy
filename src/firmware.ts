// Module firmware on firmware.gocontroll.tech: the .srec files that go-modules flashes into the
// plug-in modules of a Moduline L4, M1 or HMI1, in the R2 bucket gocontroll-firmware (FIRMWARE_BUCKET).
//
// Deploy is a second producer next to the CI of the module repos (Module-*/.github/scripts/
// publish_firmware.py, run on a v* tag) and writes what that script writes, in the same order:
//
//   modules/<hw_id>/<file>.srec        the firmware, application/octet-stream
//   modules/<hw_id>/manifest.json      { id, name, hardware_version, releases: [{ sw_version, file,
//                                        date (DD/MM/YY), sha256, changelog }] }
//   modules/manifest.json              { updated (YYYY-MM-DD), modules: [{ id, name, hardware_version,
//                                        latest_firmware, manifest }] }
//
// The file name carries everything: 20-10-1-6-2-0-3.srec = hardware ID 20100106 (each of the first
// four parts zero-padded to two digits), firmware 2.0.3, hardware version 1.06. Contract:
// GOcontroll-Architecture/cloudflare/firmware/spec.md.
//
// Where Deploy differs from the script, on purpose:
//   - releases are sorted highest version first. go-modules takes releases[0] as the firmware to
//     flash; the script puts the newest upload first, so publishing an older version after a newer
//     one would make every controller go back. latest_firmware is that same highest version.
//   - latest_firmware never goes down (the deployment agent's rule, agent 08): the higher of what
//     it was and the highest release.
//   - a published .srec never changes: other bytes under an existing name are refused (409), the
//     correction gets a new version number. A version that is in the manifest already is refused
//     unless the colleague ticks "Publish again", which writes its entry again (same file, e.g. a
//     corrected changelog). The script overwrites the entry silently and skips the upload of an
//     existing file while still writing the SHA-256 of its own copy.
//   - the changelog is stored the way the CI reads it from a tag annotation (normaliseChangelog),
//     so the tag Deploy suggests afterwards makes the CI write the same entry: pushing it is a no-op.
//   - dry_run answers what would be written, without writing (the review before Publish).
//   - the manifests are written only over the version that was read (R2 etag): a publish at the
//     same moment (Deploy or CI) is not lost, this one is retried on the newer manifest.
//   - an .srec must have LF line ends. From a repository the browser sends the file as git holds
//     it at HEAD (never the Windows work tree's CRLF copy), so the bytes and SHA-256 are those the
//     CI publishes; loose files are converted from CRLF to LF.
//
// The audit log (STATE log/…) holds every publish with the manifests as they were before it, so a
// publish can be undone by writing those back (README, "Module firmware"). firmware-log/<hw_id>/
// <version>.json says who published a version from Deploy and from which commit; a version
// without one came from the CI.

import type { Env, User } from './env';
import { sha256, toHex } from './goco';
import { HttpError } from './lib/http';
import { audit, listAll, writeJson } from './state';

export const MODULES_PREFIX = 'modules/';
export const MASTER_MANIFEST_KEY = 'modules/manifest.json';
/** An .srec of an STM32 module is well under 2 MB; this leaves room. */
export const MAX_SREC_SIZE = 4 * 1024 * 1024;
export const MAX_CHANGELOG = 2000;
const FIRMWARE_LOG_PREFIX = 'firmware-log/';
const ATTEMPTS = 3;

/**
 * Module names for a hardware type that has no manifest yet, by the first six digits of the
 * hardware ID: the names the manifests use (the deployment agent's table, agent 08), which differ
 * from GOcontroll-Architecture/modules/naming.md for 202001 and 204001. An existing manifest's
 * name always wins and is never changed, then the name of another hardware version of the same
 * type, then this list.
 */
export const MODULE_TYPE_NAMES: Readonly<Record<string, string>> = {
  '201001': '6 Channel Input module',
  '201002': '10 Channel Input module',
  '201003': '4-20mA Input module',
  '201004': 'RTD Input module',
  '201005': 'Loadcell Input module',
  '202001': '2 Channel Output module', // naming.md: "2 Channel Power Bridge Module"; the manifests' name kept (agent 08)
  '202002': '6 Channel Output module',
  '202003': '10 Channel Output module',
  '203003': 'IR Communication Module',
  '203004': 'Multibus module',
  '204001': 'ANLEG RTC Control module', // not in naming.md (agent 08)
};

/** 20-10-1-6-2-0-3.srec: four hardware parts of one or two digits, three firmware parts. */
const SREC_NAME = /^(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.srec$/;

export interface SrecName { file: string; hwId: string; typeId: string; version: string; hardwareVersion: string }

/** The hardware ID and firmware version in an .srec file name, as publish_firmware.py reads them; null when it does not follow the convention. */
export function parseSrecName(file: string): SrecName | null {
  const m = SREC_NAME.exec(file);
  if (!m) return null;
  const hwId = m.slice(1, 5).map((p) => p.padStart(2, '0')).join('');
  return { file, hwId, typeId: hwId.slice(0, 6), version: m.slice(5, 8).join('.'), hardwareVersion: `1.${hwId.slice(6)}` };
}

/** Numeric version order (2.0.10 after 2.0.9). */
export function compareFirmwareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** YYYY-MM-DD (a date field) → DD/MM/YY, the date format of the module manifests. */
export function manifestDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(`${iso}T00:00:00Z`) : null;
  if (!m || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new HttpError(400, 'Fill in the release date.', 'released');
  }
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

/** The text of a manifest as publish_firmware.py writes it: json.dumps(indent=2, ensure_ascii=False), no trailing newline. */
export const firmwareManifestText = (doc: unknown): string => JSON.stringify(doc, null, 2);

/** One S-record: "S", the type digit, then hex. */
const SREC_LINE = /^S[0-9][0-9A-Fa-f]{6,}$/;

/** Cheap check of the bytes: the browser parsed every record and its checksum already. */
export function checkSrecBytes(bytes: Uint8Array): void {
  if (!bytes.length) throw new HttpError(400, 'The file is empty.', 'file');
  if (bytes.indexOf(13) >= 0) throw new HttpError(400, 'The file has CR line ends. Reload the page and choose it again.', 'file');
  const lines = new TextDecoder().decode(bytes).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length || !lines.every((line) => SREC_LINE.test(line))) throw new HttpError(400, 'This is not a Motorola S-record file.', 'file');
}

// ── Reading the manifests ────────────────────────────────────────────────────

interface Doc { value: Record<string, any>; etag: string; text: string }

async function readDoc(bucket: R2Bucket, key: string): Promise<Doc | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const text = await obj.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(409, `${key} on firmware.gocontroll.tech is not valid JSON. It has to be repaired before anything is published.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(409, `${key} on firmware.gocontroll.tech is not a manifest. It has to be repaired before anything is published.`);
  }
  return { value: value as Record<string, any>, etag: obj.etag, text };
}

async function writeDoc(bucket: R2Bucket, key: string, value: unknown, etag: string | null): Promise<boolean> {
  const onlyIf = etag ? { etagMatches: etag } : new Headers({ 'if-none-match': '*' });
  const done = await bucket.put(key, firmwareManifestText(value), { httpMetadata: { contentType: 'application/json' }, onlyIf });
  return done !== null;
}

const moduleManifestKey = (hwId: string) => `${MODULES_PREFIX}${hwId}/manifest.json`;
const firmwareLogKey = (hwId: string, version: string) => `${FIRMWARE_LOG_PREFIX}${hwId}/${version}.json`;

export interface FirmwareRelease {
  version: string;
  file: string;
  date: string;
  sha256: string;
  changelog: string;
  publishedBy: { email: string; at: string; source: FirmwareSource | null } | null;  // null: not from Deploy (the CI)
}

export interface FirmwareModule {
  id: string;
  name: string;
  hardwareVersion: string;
  latest: string | null;
  releases: FirmwareRelease[];
  error?: string;
}

export interface FirmwareOverview {
  updated: string | null;
  modules: FirmwareModule[];
  manifestError?: string;
  firmwareUrl: string;
  moduleTypeNames: Record<string, string>;
}

export interface FirmwareSource { repo: string; branch: string | null; commit: string | null; tag: string | null; path?: string | null; pushed?: boolean | null }

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Every module in modules/manifest.json with its releases (one read per module, in parallel). */
export async function firmwareOverview(env: Env): Promise<FirmwareOverview> {
  const out: FirmwareOverview = { updated: null, modules: [], firmwareUrl: firmwareBase(env), moduleTypeNames: { ...MODULE_TYPE_NAMES } };
  let master: Doc | null;
  try {
    master = await readDoc(env.FIRMWARE_BUCKET, MASTER_MANIFEST_KEY);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    out.manifestError = err.message;
    return out;
  }
  const logs = await listAll(env.STATE, { prefix: FIRMWARE_LOG_PREFIX, include: ['customMetadata'] });
  const published = new Map(logs.map((o) => [o.key, o.customMetadata ?? {}]));
  out.updated = master ? str(master.value.updated) || null : null;
  const entries: Record<string, unknown>[] = Array.isArray(master?.value.modules) ? master!.value.modules : [];
  out.modules = await Promise.all(entries.map(async (e): Promise<FirmwareModule> => {
    const id = str(e.id);
    const mod: FirmwareModule = { id, name: str(e.name), hardwareVersion: str(e.hardware_version), latest: str(e.latest_firmware) || null, releases: [] };
    try {
      const doc = /^\d{8}$/.test(id) ? await readDoc(env.FIRMWARE_BUCKET, moduleManifestKey(id)) : null;
      if (!doc) {
        mod.error = 'Its manifest is missing.';
        return mod;
      }
      const releases: Record<string, unknown>[] = Array.isArray(doc.value.releases) ? doc.value.releases : [];
      mod.releases = releases.map((r) => {
        const version = str(r.sw_version);
        const meta = published.get(firmwareLogKey(id, version));
        return {
          version,
          file: str(r.file),
          date: str(r.date),
          sha256: str(r.sha256),
          changelog: str(r.changelog),
          publishedBy: meta?.email ? { email: meta.email, at: meta.at ?? '', source: parseSource(meta.source) } : null,
        };
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      mod.error = err.message;
    }
    return mod;
  }));
  return out;
}

function parseSource(text: string | undefined): FirmwareSource | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as FirmwareSource;
  } catch {
    return null;
  }
}

/** The host a link to a firmware file uses: the first of FIRMWARE_URLS. */
export function firmwareBase(env: Env): string {
  return (env.FIRMWARE_URLS || 'https://firmware.gocontroll.tech').split(',')[0].trim().replace(/\/+$/, '');
}

// ── Publishing ───────────────────────────────────────────────────────────────

export interface FirmwarePublishResult {
  dryRun: boolean;          // true: nothing was written, this is what would be
  hwId: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
  date: string;
  changelog: string;        // as written: the way the CI reads it from a tag annotation
  moduleName: string;
  latest: string;           // latest_firmware after the publish
  latestBefore: string | null;
  objectWritten: boolean;   // false: the identical file was already there
  replacedRelease: boolean; // the version was in the manifest and its entry was replaced
  newModule: boolean;
  moduleManifest: string;   // the module's manifest as it is (or would be) written
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/**
 * The changelog as the CI reads it from a tag annotation: every line without trailing white space,
 * no blank lines, trimmed. Written like this, the annotation Deploy suggests for the tag makes the
 * CI write the same text, so pushing the tag changes nothing.
 */
export function normaliseChangelog(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (lines.some((l) => /^(RELEASE_DATE|DEPLOY_FILES):/.test(l))) {
    throw new HttpError(400, 'A changelog line cannot start with RELEASE_DATE: or DEPLOY_FILES: (the tag annotation uses those).', 'changelog');
  }
  return lines.join('\n').trim();
}

function sourceField(text: string): FirmwareSource | null {
  if (!text) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The source of the file could not be read.', 'source');
  }
  const s = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
  const repo = s(v?.repo, 120);
  if (!repo) return null;
  const commit = s(v.commit, 40);
  return {
    repo,
    branch: s(v.branch, 200),
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    tag: s(v.tag, 200),
    path: s(v.path, 300),
    pushed: typeof v.pushed === 'boolean' ? v.pushed : null,
  };
}

const releasesOf = (doc: Record<string, unknown> | null | undefined): Record<string, unknown>[] =>
  (Array.isArray(doc?.releases) ? doc!.releases as Record<string, unknown>[] : []);

/** The module's manifest with this release in it (a new manifest when there is none). */
function nextModuleDoc(mod: Doc | null, master: Doc | null, name: SrecName, entry: Record<string, unknown>, moduleName: string): Record<string, unknown> {
  const doc: Record<string, unknown> = mod ? { ...mod.value } : {
    id: name.hwId,
    name: moduleName || typeName(master?.value, name.typeId) || MODULE_TYPE_NAMES[name.typeId] || '',
    hardware_version: name.hardwareVersion,
    releases: [],
  };
  if (!str(doc.name)) throw new HttpError(400, `Fill in the name of module ${name.hwId}: it is not on firmware.gocontroll.tech yet.`, 'module_name');
  doc.releases = sortReleases([...releasesOf(doc).filter((r) => str(r.sw_version) !== name.version), entry]);
  return doc;
}

/**
 * modules/manifest.json with this module's latest_firmware: the highest release, never lower than
 * it was (the deployment agent's rule; go-web-ui shows it).
 */
function nextMasterDoc(master: Doc | null, modDoc: Record<string, unknown>, name: SrecName, at: string): { doc: Record<string, unknown>; latest: string; latestBefore: string | null } {
  const doc: Record<string, any> = master ? { ...master.value } : { updated: '', modules: [] };
  doc.updated = at.slice(0, 10);
  const modules: Record<string, unknown>[] = Array.isArray(doc.modules) ? doc.modules.map((m: Record<string, unknown>) => ({ ...m })) : [];
  const existing = modules.find((m) => str(m.id) === name.hwId);
  const highest = str(releasesOf(modDoc)[0]?.sw_version);
  const latestBefore = existing ? str(existing.latest_firmware) || null : null;
  const latest = latestBefore && /^\d+(\.\d+)*$/.test(latestBefore) && compareFirmwareVersions(latestBefore, highest) > 0 ? latestBefore : highest;
  if (existing) {
    existing.latest_firmware = latest;
  } else {
    modules.push({
      id: name.hwId,
      name: str(modDoc.name),
      hardware_version: str(modDoc.hardware_version) || name.hardwareVersion,
      latest_firmware: latest,
      manifest: moduleManifestKey(name.hwId),
    });
  }
  doc.modules = modules;
  return { doc, latest, latestBefore };
}

/**
 * Publish one .srec: the file, then its module's manifest, then modules/manifest.json. Form
 * fields: file (the .srec as git holds it: LF), released (YYYY-MM-DD), changelog, module_name (only
 * used for a hardware ID without a manifest), replace ('true': write the manifest entry of a
 * version that is published already again, with the same file), source (JSON { repo, branch,
 * commit, tag, path, pushed } of the local repository, for the log), dry_run ('true': check
 * everything and answer what would be written, write nothing).
 */
export async function publishFirmware(env: Env, user: User, form: FormData): Promise<FirmwarePublishResult> {
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose an .srec file.', 'file');
  const name = parseSrecName(file.name);
  if (!name) throw new HttpError(422, `${file.name} does not follow the naming of module firmware (e.g. 20-10-1-6-2-0-3.srec).`, 'file');
  if (file.size > MAX_SREC_SIZE) throw new HttpError(413, 'An .srec of a module is at most 4 MB.', 'file');
  const date = manifestDate(field(form, 'released'));
  const changelog = normaliseChangelog(field(form, 'changelog'));
  if (!changelog) throw new HttpError(400, 'Write what changed in this version.', 'changelog');
  if (changelog.length > MAX_CHANGELOG) throw new HttpError(400, `The changelog is at most ${MAX_CHANGELOG} characters.`, 'changelog');
  const moduleName = field(form, 'module_name').trim().slice(0, 80);
  const replace = field(form, 'replace') === 'true';
  const dryRun = field(form, 'dry_run') === 'true';
  const source = sourceField(field(form, 'source'));

  const bytes = new Uint8Array(await file.arrayBuffer());
  checkSrecBytes(bytes);
  const digest = toHex(await sha256(bytes));
  const objectKey = `${MODULES_PREFIX}${name.hwId}/${name.file}`;
  const modKey = moduleManifestKey(name.hwId);
  const bucket = env.FIRMWARE_BUCKET;
  const inManifest = (doc: Doc | null) => releasesOf(doc?.value).some((r) => str(r.sw_version) === name.version);

  // Everything that could refuse the publish is checked before anything is written.
  let mod = await readDoc(bucket, modKey);
  let master = await readDoc(bucket, MASTER_MANIFEST_KEY);
  const replacedRelease = inManifest(mod);
  if (replacedRelease && !replace) {
    throw new HttpError(409, `Firmware ${name.version} of ${name.hwId} is already published. Tick "Publish again" to write its manifest entry again (same file).`, 'replace', { conflict: 'release' });
  }
  const stored = await bucket.get(objectKey);
  const storedDigest = stored ? toHex(await sha256(new Uint8Array(await stored.arrayBuffer()))) : null;
  if (storedDigest !== null && storedDigest !== digest) {
    throw new HttpError(409, `firmware.gocontroll.tech already has a different ${name.file}. A published firmware never changes: give the correction a new version number.`, 'file', { conflict: 'file' });
  }
  const objectWritten = storedDigest === null;
  const at = new Date().toISOString();
  const entry = { sw_version: name.version, file: objectKey, date, sha256: digest, changelog };

  if (dryRun) {
    const modDoc = nextModuleDoc(mod, master, name, entry, moduleName);
    const { latest, latestBefore } = nextMasterDoc(master, modDoc, name, at);
    return {
      dryRun: true, hwId: name.hwId, version: name.version, file: objectKey, url: `${firmwareBase(env)}/${objectKey}`, sha256: digest,
      date, changelog, moduleName: str(modDoc.name), latest, latestBefore, objectWritten, replacedRelease, newModule: !mod,
      moduleManifest: firmwareManifestText(modDoc),
    };
  }

  if (objectWritten) {
    // Only where nothing is: a file that appeared meanwhile is never overwritten.
    const put = await bucket.put(objectKey, bytes, { httpMetadata: { contentType: 'application/octet-stream' }, onlyIf: new Headers({ 'if-none-match': '*' }) });
    if (!put) throw new HttpError(409, `${name.file} was published a moment ago by someone else. Reload the page.`, 'file', { conflict: 'file' });
  }

  // The module's manifest, over the version that was read.
  let modDoc: Record<string, unknown> = {};
  let previousModule: string | null = null;
  let newModule = false;
  for (let attempt = 0; ; attempt++) {
    if (attempt) {
      mod = await readDoc(bucket, modKey);
      master = await readDoc(bucket, MASTER_MANIFEST_KEY);
      if (inManifest(mod) && !replace) {
        throw new HttpError(409, `Firmware ${name.version} of ${name.hwId} was published a moment ago by someone else.`, 'replace', { conflict: 'release' });
      }
    }
    modDoc = nextModuleDoc(mod, master, name, entry, moduleName);
    if (await writeDoc(bucket, modKey, modDoc, mod?.etag ?? null)) {
      previousModule = mod?.text ?? null;
      newModule = !mod;
      break;
    }
    if (attempt + 1 >= ATTEMPTS) throw new HttpError(409, 'The manifest of this module changed while publishing. Try again.');
  }

  // modules/manifest.json, the same way.
  let previousMaster: string | null = null;
  let latest = '';
  let latestBefore: string | null = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt) master = await readDoc(bucket, MASTER_MANIFEST_KEY);
    const next = nextMasterDoc(master, modDoc, name, at);
    latest = next.latest;
    latestBefore = next.latestBefore;
    if (await writeDoc(bucket, MASTER_MANIFEST_KEY, next.doc, master?.etag ?? null)) {
      previousMaster = master?.text ?? null;
      break;
    }
    if (attempt + 1 >= ATTEMPTS) throw new HttpError(409, 'modules/manifest.json changed while publishing. Publish again: the file and the module manifest are in place already.');
  }

  await writeJson(env.STATE, firmwareLogKey(name.hwId, name.version), { at, email: user.email, sha256: digest, source }, undefined, {
    email: user.email,
    at,
    source: source ? JSON.stringify(source) : '',
  });
  await audit(env, {
    action: 'publish-firmware',
    app_id: `module-${name.hwId}`,
    version: name.version,
    actor: user.email,
    sha256: digest,
    size: bytes.length,
    replaced: replacedRelease,
    description: changelog,
    release_date: date,
    file: objectKey,
    source,
    previous_module_manifest: previousModule,
    previous_master_manifest: previousMaster,
  });

  return {
    dryRun: false, hwId: name.hwId, version: name.version, file: objectKey, url: `${firmwareBase(env)}/${objectKey}`, sha256: digest,
    date, changelog, moduleName: str(modDoc.name), latest, latestBefore, objectWritten, replacedRelease, newModule,
    moduleManifest: firmwareManifestText(modDoc),
  };
}

/** Highest version first; releases with an unreadable version keep their place at the end. */
function sortReleases(releases: Record<string, unknown>[]): Record<string, unknown>[] {
  const ok = (v: string) => /^\d+(\.\d+)*$/.test(v);
  return [...releases].sort((a, b) => {
    const va = str(a.sw_version);
    const vb = str(b.sw_version);
    if (!ok(va) || !ok(vb)) return ok(va) ? -1 : ok(vb) ? 1 : 0;
    return compareFirmwareVersions(vb, va);
  });
}

/** The name another hardware version of the same module type has in modules/manifest.json. */
function typeName(master: Record<string, any> | undefined, typeId: string): string {
  const modules: Record<string, unknown>[] = Array.isArray(master?.modules) ? master!.modules : [];
  return str(modules.find((m) => str(m.id).startsWith(typeId) && str(m.name))?.name);
}
