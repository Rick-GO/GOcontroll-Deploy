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
//   - a version that is already in the module's manifest, or a file name that already holds other
//     bytes, is refused (409) unless the colleague chose to replace it; the replaced .srec is kept
//     in STATE (firmware-replaced/…) first. The script overwrites the entry silently and skips the
//     upload of an existing file while still writing the SHA-256 of its own copy.
//   - the manifests are written only over the version that was read (R2 etag): a publish at the
//     same moment (Deploy or CI) is not lost, this one is retried on the newer manifest.
//   - an .srec must have LF line ends. The browser converts CRLF (a Windows checkout with
//     core.autocrlf) to LF, so the bytes and SHA-256 are those of the file in git, which is what
//     the CI publishes.
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
 * hardware ID (GOcontroll-Architecture/modules/naming.md). An existing manifest's name always
 * wins, then the name of another hardware version of the same type, then this list.
 */
export const MODULE_TYPE_NAMES: Readonly<Record<string, string>> = {
  '201001': '6 Channel Input module',
  '201002': '10 Channel Input module',
  '201003': '4-20mA Input module',
  '201004': 'RTD Input module',
  '201005': 'Loadcell Input module',
  '202001': '2 Channel Power Bridge module',
  '202002': '6 Channel Output module',
  '202003': '10 Channel Output module',
  '203003': 'IR Communication Module',
  '203004': 'Multibus module',
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

export interface FirmwareSource { repo: string; branch: string | null; commit: string | null; tag: string | null }

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
  hwId: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
  date: string;
  latest: string;
  objectWritten: boolean;   // false: the identical file was already there
  replacedRelease: boolean; // the version was in the manifest and was replaced
  replacedFile: boolean;    // other bytes were under this name and were archived first
  newModule: boolean;
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
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
  return { repo, branch: s(v.branch, 200), commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, tag: s(v.tag, 200) };
}

/**
 * Publish one .srec: the file, then its module's manifest, then modules/manifest.json. Form
 * fields: file (the .srec, LF line ends), released (YYYY-MM-DD), changelog, module_name (only used
 * for a hardware ID without a manifest), replace ('true' to replace an existing version or file),
 * source (JSON { repo, branch, commit, tag } of the local repository, for the log).
 */
export async function publishFirmware(env: Env, user: User, form: FormData): Promise<FirmwarePublishResult> {
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose an .srec file.', 'file');
  const name = parseSrecName(file.name);
  if (!name) throw new HttpError(422, `${file.name} does not follow the naming of module firmware (e.g. 20-10-1-6-2-0-3.srec).`, 'file');
  if (file.size > MAX_SREC_SIZE) throw new HttpError(413, 'An .srec of a module is at most 4 MB.', 'file');
  const date = manifestDate(field(form, 'released'));
  const changelog = field(form, 'changelog').trim();
  if (!changelog) throw new HttpError(400, 'Write what changed in this version.', 'changelog');
  if (changelog.length > MAX_CHANGELOG) throw new HttpError(400, `The changelog is at most ${MAX_CHANGELOG} characters.`, 'changelog');
  const moduleName = field(form, 'module_name').trim().slice(0, 80);
  const replace = field(form, 'replace') === 'true';
  const source = sourceField(field(form, 'source'));

  const bytes = new Uint8Array(await file.arrayBuffer());
  checkSrecBytes(bytes);
  const digest = toHex(await sha256(bytes));
  const objectKey = `${MODULES_PREFIX}${name.hwId}/${name.file}`;
  const modKey = moduleManifestKey(name.hwId);
  const bucket = env.FIRMWARE_BUCKET;

  // Everything that could refuse the publish is checked before anything is written.
  let mod = await readDoc(bucket, modKey);
  const inManifest = (doc: Doc | null) => (Array.isArray(doc?.value.releases) ? doc!.value.releases as Record<string, unknown>[] : [])
    .some((r) => str(r.sw_version) === name.version);
  const replacedRelease = inManifest(mod);
  if (replacedRelease && !replace) {
    throw new HttpError(409, `Firmware ${name.version} of ${name.hwId} is already published. Choose Replace to publish it again.`, 'replace', { conflict: 'release' });
  }
  const storedObject = await bucket.get(objectKey);
  const stored = storedObject ? new Uint8Array(await storedObject.arrayBuffer()) : null;
  const storedDigest = stored ? toHex(await sha256(stored)) : null;
  const replacedFile = storedDigest !== null && storedDigest !== digest;
  if (replacedFile && !replace) {
    throw new HttpError(409, `firmware.gocontroll.tech already has a different ${name.file}. Choose Replace to overwrite it (the old file is kept in the archive).`, 'replace', { conflict: 'file' });
  }

  const at = new Date().toISOString();
  if (replacedFile) {
    await env.STATE.put(`firmware-replaced/${name.hwId}/${name.file}/${at.replace(/[:.]/g, '-')}.srec`, stored!, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { sha256: storedDigest!, replaced_by: user.email },
    });
  }
  const objectWritten = storedDigest !== digest;
  if (objectWritten) {
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  }

  // The module's manifest, over the version that was read.
  const entry = { sw_version: name.version, file: objectKey, date, sha256: digest, changelog };
  let previousModule: string | null = null;
  let releases: Record<string, unknown>[] = [];
  let newModule = false;
  let master: Doc | null = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt) mod = await readDoc(bucket, modKey);
    if (attempt && inManifest(mod) && !replace) {
      throw new HttpError(409, `Firmware ${name.version} of ${name.hwId} was published a moment ago by someone else.`, 'replace', { conflict: 'release' });
    }
    if (!mod) master = await readDoc(bucket, MASTER_MANIFEST_KEY);
    const doc: Record<string, any> = mod ? { ...mod.value } : {
      id: name.hwId,
      name: moduleName || typeName(master?.value, name.typeId) || MODULE_TYPE_NAMES[name.typeId] || '',
      hardware_version: name.hardwareVersion,
      releases: [],
    };
    if (!str(doc.name)) throw new HttpError(400, `Fill in the name of module ${name.hwId}: it is not on firmware.gocontroll.tech yet.`, 'module_name');
    releases = (Array.isArray(doc.releases) ? doc.releases as Record<string, unknown>[] : []).filter((r) => str(r.sw_version) !== name.version);
    releases.push(entry);
    releases = sortReleases(releases);
    doc.releases = releases;
    if (await writeDoc(bucket, modKey, doc, mod?.etag ?? null)) {
      previousModule = mod?.text ?? null;
      newModule = !mod;
      break;
    }
    if (attempt + 1 >= ATTEMPTS) throw new HttpError(409, 'The manifest of this module changed while publishing. Try again.');
  }
  const latest = str(releases[0]?.sw_version);

  // modules/manifest.json, the same way.
  let previousMaster: string | null = null;
  for (let attempt = 0; ; attempt++) {
    master = await readDoc(bucket, MASTER_MANIFEST_KEY);
    const doc: Record<string, any> = master ? { ...master.value } : { updated: '', modules: [] };
    doc.updated = at.slice(0, 10);
    const modules: Record<string, unknown>[] = Array.isArray(doc.modules) ? doc.modules.map((m: Record<string, unknown>) => ({ ...m })) : [];
    const existing = modules.find((m) => str(m.id) === name.hwId);
    if (existing) {
      existing.latest_firmware = latest;
    } else {
      const modDoc = await readDoc(bucket, modKey);
      modules.push({
        id: name.hwId,
        name: str(modDoc?.value.name) || moduleName || MODULE_TYPE_NAMES[name.typeId] || '',
        hardware_version: str(modDoc?.value.hardware_version) || name.hardwareVersion,
        latest_firmware: latest,
        manifest: modKey,
      });
    }
    doc.modules = modules;
    if (await writeDoc(bucket, MASTER_MANIFEST_KEY, doc, master?.etag ?? null)) {
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
    replaced: replacedRelease || replacedFile,
    description: changelog,
    release_date: date,
    file: objectKey,
    source,
    previous_module_manifest: previousModule,
    previous_master_manifest: previousMaster,
  });

  return {
    hwId: name.hwId,
    version: name.version,
    file: objectKey,
    url: `${firmwareBase(env)}/${objectKey}`,
    sha256: digest,
    date,
    latest,
    objectWritten,
    replacedRelease,
    replacedFile,
    newModule,
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
