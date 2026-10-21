// @ts-check
// Linux application packages (M1, L4, HMI1) in the browser: what a Linux release of Deploy
// writes, built here so the Worker only checks and stores it (DESIGN-v3, the go-deploy
// contract in GOcontroll-Architecture/cloudflare/linux-application/spec.md §3–§4).
//
// The producer this mirrors is the CI pipeline of the skill r2-application-deploy-setup:
//   build-package.py     update.tar.gz = gzip(tar of the directory files/), and the version
//                        manifest {manifest_version, app_id, version, released, description,
//                        files[], post_install?} as json.dumps(indent=2) + "\n"
//   post-install.sh.tmpl the post-install script that restarts services (POST_INSTALL_TEMPLATE
//                        below is that file, byte for byte, with LF line endings)
//   upload-r2.py         the version order (semver_key) that decides latest_version
// test/package.test.ts holds this module against those scripts (fixtures made by
// `python -I scripts/tar-fixture.py`): the same manifest text, the same rendered script, and
// Python's tarfile reading back what buildTar() writes.
//
// Pure functions and Web APIs only (no DOM): it runs in the browser, in workerd (tests) and
// under Node (the fixture script).

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A package or file that will not do; the message is meant for the colleague. */
export class PackageError extends Error {}

// ── The post-install script ──────────────────────────────────────────────────

/** r2-application-deploy-setup/post-install.sh.tmpl, byte for byte. */
export const POST_INSTALL_TEMPLATE = [
  '#!/bin/bash',
  '# Post-install hook for go-deploy.',
  '# Auto-generated from .github/scripts/post-install.sh.tmpl during package build.',
  '# Restarts the services declared in .github/r2-deploy.config.json::post_install.services.',
  'set -e',
  '',
  'SERVICES="{{services_space_separated}}"',
  '',
  'for svc in $SERVICES; do',
  '  if systemctl list-unit-files --type=service | grep -q "^${svc}\\.service"; then',
  '    echo "Restarting ${svc}..."',
  '    systemctl restart "${svc}" || echo "WARN: failed to restart ${svc}"',
  '  else',
  '    echo "INFO: service ${svc} not found, skipping"',
  '  fi',
  'done',
  '',
  'echo "Post-install complete."',
  '',
].join('\n');

/** The script's name in the tarball (and the one name a package file cannot have). */
export const POST_INSTALL_NAME = 'post-install.sh';

/** Services suggested in the Package card. */
export const SERVICE_SUGGESTIONS = ['nodered', 'go-simulink'];

/** The largest tarball the Worker takes. */
export const MAX_TARBALL = 100 * 1024 * 1024;

/** build-package.py render_post_install(). @param {string[]} services */
export const renderPostInstall = (services) => POST_INSTALL_TEMPLATE.split('{{services_space_separated}}').join(services.join(' '));

/**
 * The services of a script that is exactly the template rendered for them, else null
 * (a script of its own).
 * @param {string} script
 */
export function servicesOf(script) {
  const m = /^SERVICES="([^"\n]*)"$/m.exec(script);
  if (!m) return null;
  const services = m[1].split(' ').filter(Boolean);
  return renderPostInstall(services) === script ? services : null;
}

/**
 * @typedef {{ name: string, destination: string, mode: string, owner?: string, group?: string }} PackageFile
 *   name: the basename in files/ of the tarball
 * @typedef {{ mode: 'none' } | { mode: 'services', services: string[] } | { mode: 'script', script: string }} PostInstall
 * @typedef {{ owner: string, group: string, files: PackageFile[], post_install: PostInstall }} PackageDefinition
 */

/** The text of files/post-install.sh, or null for none. @param {PostInstall} p */
function postInstallText(p) {
  if (p.mode === 'services') return renderPostInstall(p.services);
  if (p.mode === 'script') return p.script;
  return null;
}

// ── Names, versions and the package definition ───────────────────────────────

/** Why a new Linux App ID will not do (r2-deploy.config.json app_id), or null. @param {string} appId */
export function linuxAppIdProblem(appId) {
  if (!appId) return 'Enter an App ID.';
  if (appId.length > 64) return 'An App ID is at most 64 characters.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(appId)) {
    return 'A Linux App ID is lower case: letters, digits, ".", "_" and "-", and it starts with a letter or digit.';
  }
  return null;
}

/** Why a Linux release version will not do (upload-r2.py allows a pre-release like 1.0.1-r), or null. @param {string} v */
export function linuxVersionProblem(v) {
  if (!v) return 'Enter the version.';
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) return 'The version is major.minor.patch, with an optional pre-release such as 1.0.1-r.';
  return null;
}

/**
 * upload-r2.py semver_key(): the numbers, then a release above its pre-release, then the
 * pre-release text. @param {string} v
 * @returns {[number[], boolean, string]}
 */
function semverKey(v) {
  const at = v.indexOf('-');
  const base = at < 0 ? v : v.slice(0, at);
  const pre = at < 0 ? '' : v.slice(at + 1);
  const parts = base.split('.');
  const nums = parts.every((p) => /^\s*[+-]?\d+\s*$/.test(p)) ? parts.map((p) => Number.parseInt(p, 10)) : [0];
  return [nums, pre === '', pre];
}

/** Order two Linux versions as upload-r2.py does (negative when a is lower). @param {string} a @param {string} b */
export function compareLinuxVersions(a, b) {
  const [an, ar, ap] = semverKey(a);
  const [bn, br, bp] = semverKey(b);
  for (let i = 0; i < Math.min(an.length, bn.length); i++) if (an[i] !== bn[i]) return an[i] < bn[i] ? -1 : 1;
  if (an.length !== bn.length) return an.length < bn.length ? -1 : 1;
  if (ar !== br) return ar ? 1 : -1;
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

/** The next patch after latest ("1.2.3" and "1.2.3-r" give "1.2.4"); "1.0.0" without one. @param {string | null | undefined} latest */
export function nextPatch(latest) {
  const m = latest ? /^(\d+)\.(\d+)\.(\d+)/.exec(latest) : null;
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

const NAME_RE = /^[^/\\\0-\x1f\x7f]+$/;
const ACCOUNT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/;

/**
 * Why one file of a package will not do, or null.
 * @param {PackageFile} f @param {PackageFile[]} all  the whole list (for the duplicate check)
 */
export function packageFileProblem(f, all) {
  const name = f.name ?? '';
  if (!name) return 'Give the file a name (its name in files/ of the tarball).';
  if (!NAME_RE.test(name) || name === '.' || name === '..') return `"${name}" is not a plain file name: no "/" or "\\".`;
  if (name === POST_INSTALL_NAME) return `"${POST_INSTALL_NAME}" is the post-install script; choose it under "After install".`;
  if (enc.encode(name).length > 94) return `"${name}" is too long for the tarball (at most 94 bytes).`;
  if (all.filter((o) => o.name === name).length > 1) return `"${name}" is in the package twice; every name in files/ has to be unique.`;
  if (!/^\/[^\0-\x1f\x7f]*$/.test(f.destination ?? '')) return `The destination of "${name}" has to be an absolute path, starting with "/".`;
  if (!/^[0-7]{3,4}$/.test(f.mode ?? '')) return `The mode of "${name}" is an octal number such as 0644 or 0755.`;
  for (const [what, v] of /** @type {[string, string | undefined][]} */ ([['owner', f.owner], ['group', f.group]])) {
    if (v !== undefined && v !== '' && (!ACCOUNT_RE.test(v) || v.length > 32)) return `The ${what} of "${name}" is not a user or group name.`;
  }
  return null;
}

/** Why a package definition will not do, or null. @param {PackageDefinition} def */
export function definitionProblem(def) {
  for (const [what, v] of /** @type {[string, string][]} */ ([['owner', def.owner], ['group', def.group]])) {
    if (!ACCOUNT_RE.test(v ?? '') || v.length > 32) return `The default ${what} is not a user or group name.`;
  }
  if (!def.files?.length) return 'A package holds at least one file.';
  for (const f of def.files) {
    const p = packageFileProblem(f, def.files);
    if (p) return p;
  }
  const pi = def.post_install;
  if (pi?.mode === 'services') {
    if (!pi.services.length) return 'Name at least one service to restart, or choose no post-install.';
    const bad = pi.services.find((s) => !/^[A-Za-z0-9@._:-]+$/.test(s));
    if (bad !== undefined) return `"${bad}" is not a service name.`;
  } else if (pi?.mode === 'script') {
    if (!pi.script.trim()) return 'The post-install script is empty: write one, or choose no post-install.';
  } else if (pi?.mode !== 'none') {
    return 'Choose what happens after install.';
  }
  return null;
}

/** "flows.json" for "node-red/flows.json" (Path(source).name on the CI runner). @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * A package definition from a CI pipeline's .github/r2-deploy.config.json.
 * @param {any} config  the parsed JSON
 * @returns {{ definition: PackageDefinition, appId: string | null }}
 */
export function definitionFromConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.files)) {
    throw new PackageError('This is not an r2-deploy.config.json: it has no "files" list.');
  }
  /** @type {PackageFile[]} */
  const files = config.files.map((/** @type {any} */ e, /** @type {number} */ i) => {
    if (!e || typeof e.source !== 'string') throw new PackageError(`File ${i + 1} in the config has no "source".`);
    /** @type {PackageFile} */
    const f = { name: basename(e.source), destination: String(e.destination ?? ''), mode: String(e.mode ?? '') };
    if (typeof e.owner === 'string') f.owner = e.owner;
    if (typeof e.group === 'string') f.group = e.group;
    return f;
  });
  const pi = config.post_install;
  return {
    appId: typeof config.app_id === 'string' ? config.app_id : null,
    definition: {
      owner: typeof config.owner === 'string' ? config.owner : 'root',
      group: typeof config.group === 'string' ? config.group : 'root',
      files,
      post_install: pi && pi.enabled
        ? { mode: 'services', services: Array.isArray(pi.services) ? pi.services.map(String) : [] }
        : { mode: 'none' },
    },
  };
}

/**
 * A package definition from a published version manifest (files[] only: the post-install
 * script is in the tarball). Owner and group of a file are kept only where they differ
 * from root.
 * @param {any} manifest
 * @returns {PackageDefinition}
 */
export function definitionFromVersionManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) throw new PackageError('The version manifest has no "files" list.');
  return {
    owner: 'root',
    group: 'root',
    files: manifest.files.map((/** @type {any} */ e) => {
      /** @type {PackageFile} */
      const f = { name: basename(String(e.source ?? '')), destination: String(e.destination ?? ''), mode: String(e.mode ?? '0644') };
      if (typeof e.owner === 'string' && e.owner !== 'root') f.owner = e.owner;
      if (typeof e.group === 'string' && e.group !== 'root') f.group = e.group;
      return f;
    }),
    post_install: { mode: 'none' },
  };
}

// ── The version manifest ─────────────────────────────────────────────────────

/**
 * JSON as Python's json.dumps(obj, indent=2) + "\n" writes it (ensure_ascii: every
 * character from U+007F up as \uXXXX, astral ones as their surrogate pair).
 * @param {unknown} value
 */
export const pythonJson = (value) => `${JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;

/**
 * @typedef {{ name: string, destination: string, owner: string, group: string, mode: string, sha256: string }} ManifestFileInput
 */

/**
 * The version manifest of build-package.py, its keys in the same order.
 * @param {{ appId: string, version: string, released: string, description: string, files: ManifestFileInput[],
 *   postInstallSha256: string | null }} o
 */
export function versionManifest(o) {
  /** @type {Record<string, unknown>} */
  const manifest = {
    manifest_version: 1,
    app_id: o.appId,
    version: o.version,
    released: o.released,
    description: o.description,
    files: o.files.map((f) => ({
      source: `files/${f.name}`, destination: f.destination, owner: f.owner, group: f.group, mode: f.mode, sha256: f.sha256,
    })),
  };
  if (o.postInstallSha256) manifest.post_install = { source: `files/${POST_INSTALL_NAME}`, interpreter: '/bin/bash', sha256: o.postInstallSha256 };
  return manifest;
}

/** Today in UTC, YYYY-MM-DD (the "released" of a version). */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

// ── SHA-256, gzip ────────────────────────────────────────────────────────────

/** Lower-case hex SHA-256 (hashlib hexdigest). @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes)));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** @param {Uint8Array} bytes @param {CompressionStream | DecompressionStream} t */
async function through(bytes, t) {
  const stream = new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {Uint8Array} bytes */
export const gzip = (bytes) => through(bytes, new CompressionStream('gzip'));

/** @param {Uint8Array} bytes */
export async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new PackageError('This is not a gzip file (update.tar.gz starts with 1f 8b).');
  try {
    return await through(bytes, new DecompressionStream('gzip'));
  } catch {
    throw new PackageError('The gzip file is damaged or cut short.');
  }
}

// ── tar (ustar) ──────────────────────────────────────────────────────────────

const BLOCK = 512;
const RECORD = 20 * BLOCK; // tarfile.RECORDSIZE

/** @param {Uint8Array} h @param {number} offset @param {number} length @param {string} text */
function put(h, offset, length, text) {
  const b = enc.encode(text);
  if (b.length > length) throw new PackageError(`"${text}" does not fit in a tar header field of ${length} bytes.`);
  h.set(b, offset);
}

/** tarfile itn() for ustar: octal digits, zero-padded, then NUL. @param {number} n @param {number} width */
const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;

/**
 * One 512-byte ustar header, as tarfile writes one: uid/gid 0, magic "ustar\0" + "00",
 * checksum "%06o\0 ".
 * @param {{ name: string, mode: number, size: number, mtime: number, type: '0' | '5', uname: string, gname: string }} e
 */
function header(e) {
  const h = new Uint8Array(BLOCK);
  let name = e.name;
  let prefix = '';
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  put(h, 0, 100, name);
  put(h, 100, 8, octal(e.mode & 0o7777, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  put(h, 124, 12, octal(e.size, 12));
  put(h, 136, 12, octal(e.mtime, 12));
  h.fill(0x20, 148, 156);
  h[156] = e.type.charCodeAt(0);
  put(h, 257, 6, 'ustar\0');
  put(h, 263, 2, '00');
  put(h, 265, 32, e.uname);
  put(h, 297, 32, e.gname);
  put(h, 329, 8, octal(0, 8));
  put(h, 337, 8, octal(0, 8));
  put(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 7, `${sum.toString(8).padStart(6, '0')}\0`);
  return h;
}

/**
 * @typedef {{ name: string, data: Uint8Array, mode: string, owner: string, group: string }} TarFile
 *   name: the basename under files/; mode: octal text such as "0644"
 */

/**
 * The tar of build-package.py's `tar.add(files_dir, arcname="files")`: the directory entry
 * "files/" (0755), then every file as "files/<name>" in name order, two zero blocks, and
 * padding to a whole 10240-byte record.
 * @param {TarFile[]} files
 * @param {{ mtime: number, owner: string, group: string }} o  mtime in whole seconds
 */
export function buildTar(files, o) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @type {Uint8Array[]} */
  const parts = [header({ name: 'files/', mode: 0o755, size: 0, mtime: o.mtime, type: '5', uname: o.owner, gname: o.group })];
  for (const f of sorted) {
    parts.push(header({ name: `files/${f.name}`, mode: Number.parseInt(f.mode, 8), size: f.data.length, mtime: o.mtime, type: '0', uname: f.owner, gname: f.group }));
    parts.push(f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  let size = parts.reduce((n, p) => n + p.length, 0) + 2 * BLOCK;
  size += (RECORD - (size % RECORD)) % RECORD;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** @param {Uint8Array} b @param {number} offset @param {number} length */
const text = (b, offset, length) => {
  const field = b.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return dec.decode(nul < 0 ? field : field.subarray(0, nul));
};

/** An octal number field, or base-256 (GNU, for large values). @param {Uint8Array} b @param {number} offset @param {number} length */
function number(b, offset, length) {
  if (b[offset] & 0x80) {
    let n = 0;
    for (let i = offset + 1; i < offset + length; i++) n = n * 256 + b[i];
    return n;
  }
  const t = text(b, offset, length).trim();
  return t ? Number.parseInt(t, 8) : 0;
}

/** The records of a pax extended header ("<len> <key>=<value>\n"). @param {Uint8Array} data */
function paxRecords(data) {
  /** @type {Record<string, string>} */
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number.parseInt(dec.decode(data.subarray(at, space)), 10);
    if (!(len > 0)) break;
    const record = dec.decode(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * @typedef {{ name: string, type: 'file' | 'dir' | 'other', mode: number, size: number, mtime: number,
 *   uname: string, gname: string, data: Uint8Array }} TarEntry
 */

/**
 * Read a tar: ustar, and the pax and GNU long-name headers Python's tarfile and GNU tar
 * write. Directory names keep their trailing "/".
 * @param {Uint8Array} bytes
 * @returns {TarEntry[]}
 */
export function readTar(bytes) {
  /** @type {TarEntry[]} */
  const out = [];
  /** @type {Record<string, string>} */
  let pax = {};
  /** @type {string | null} */
  let longName = null;
  let at = 0;
  while (at + BLOCK <= bytes.length) {
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== number(h, 148, 8)) throw new PackageError(`The tar header at byte ${at} is damaged (checksum).`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const size = pax.size !== undefined ? Number(pax.size) : number(h, 124, 12);
    const start = at + BLOCK;
    if (start + size > bytes.length) throw new PackageError('The tar is cut short.');
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = { ...pax, ...paxRecords(data) }; continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(data, 0, data.length); continue; }
    const ustar = text(h, 257, 6).startsWith('ustar');
    const prefix = ustar ? text(h, 345, 155) : '';
    const short = text(h, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${short}` : short);
    out.push({
      name: type === '5' && !name.endsWith('/') ? `${name}/` : name,
      type: type === '5' ? 'dir' : type === '0' || type === '7' ? 'file' : 'other',
      mode: number(h, 100, 8),
      size,
      mtime: pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : number(h, 136, 12),
      uname: pax.uname ?? text(h, 265, 32),
      gname: pax.gname ?? text(h, 297, 32),
      data,
    });
    pax = {};
    longName = null;
  }
  return out;
}

// ── A whole release ──────────────────────────────────────────────────────────

/**
 * @typedef {{ tar: Uint8Array, tarGz: Uint8Array, sha256: string, size: number, files: ManifestFileInput[],
 *   postInstall: string | null, postInstallSha256: string | null }} BuiltTarball
 * @typedef {BuiltTarball & { manifest: Record<string, unknown>, manifestText: string }} BuiltPackage
 */

/**
 * update.tar.gz from a package definition and the chosen files, as build-package.py builds
 * it, with the SHA-256 of every file (the version manifest is versionManifest(): it alone
 * depends on the version and the description).
 * @param {{ definition: PackageDefinition, contents: Map<string, Uint8Array>, mtime?: number }} o
 *   contents: the bytes per package file name
 * @returns {Promise<BuiltTarball>}
 */
export async function buildTarball(o) {
  const def = o.definition;
  /** @type {ManifestFileInput[]} */
  const files = [];
  /** @type {TarFile[]} */
  const tarFiles = [];
  for (const f of def.files) {
    const data = o.contents.get(f.name);
    if (!data) throw new PackageError(`Choose the file for "${f.name}".`);
    const owner = f.owner || def.owner || 'root';
    const group = f.group || def.group || 'root';
    files.push({ name: f.name, destination: f.destination, owner, group, mode: f.mode, sha256: await sha256Hex(data) });
    tarFiles.push({ name: f.name, data, mode: f.mode, owner, group });
  }
  const postInstall = postInstallText(def.post_install);
  let postInstallSha256 = null;
  if (postInstall !== null) {
    const data = enc.encode(postInstall);
    postInstallSha256 = await sha256Hex(data);
    tarFiles.push({ name: POST_INSTALL_NAME, data, mode: '0755', owner: def.owner || 'root', group: def.group || 'root' });
  }
  const tar = buildTar(tarFiles, { mtime: o.mtime ?? Math.floor(Date.now() / 1000), owner: def.owner || 'root', group: def.group || 'root' });
  const tarGz = await gzip(tar);
  if (tarGz.length > MAX_TARBALL) throw new PackageError(`The tarball is ${tarGz.length} bytes; Deploy takes at most 100 MB.`);
  return { tar, tarGz, sha256: await sha256Hex(tarGz), size: tarGz.length, files, postInstall, postInstallSha256 };
}

/**
 * update.tar.gz and manifest.json together, as build-package.py builds them from
 * r2-deploy.config.json.
 * @param {{ appId: string, version: string, released: string, description: string, definition: PackageDefinition,
 *   contents: Map<string, Uint8Array>, mtime?: number }} o
 * @returns {Promise<BuiltPackage>}
 */
export async function buildPackage(o) {
  const t = await buildTarball(o);
  const manifest = versionManifest({
    appId: o.appId, version: o.version, released: o.released, description: o.description, files: t.files, postInstallSha256: t.postInstallSha256,
  });
  return { ...t, manifest, manifestText: pythonJson(manifest) };
}

/**
 * Check a built package (a CI dist/: update.tar.gz + manifest.json) before it is sent as it
 * is: every files[] entry and the post-install script are in the tarball with the SHA-256
 * the manifest gives (go-deploy refuses a file whose hash differs).
 * @param {Uint8Array} tarGz @param {any} manifest
 * @returns {Promise<{ problems: string[], entries: TarEntry[], postInstall: string | null }>}
 */
export async function checkBuiltPackage(tarGz, manifest) {
  const entries = readTar(await gunzip(tarGz));
  const byName = new Map(entries.filter((e) => e.type === 'file').map((e) => [e.name.replace(/^\.\//, ''), e]));
  /** @type {string[]} */
  const problems = [];
  for (const f of Array.isArray(manifest?.files) ? manifest.files : []) {
    const e = byName.get(String(f.source));
    if (!e) { problems.push(`${f.source} is in manifest.json but not in update.tar.gz.`); continue; }
    if (typeof f.sha256 === 'string' && (await sha256Hex(e.data)) !== f.sha256.toLowerCase()) problems.push(`${f.source} in the tarball does not have the SHA-256 manifest.json gives.`);
  }
  const pi = byName.get(`files/${POST_INSTALL_NAME}`);
  if (manifest?.post_install?.sha256 && pi && (await sha256Hex(pi.data)) !== String(manifest.post_install.sha256).toLowerCase()) {
    problems.push('files/post-install.sh in the tarball does not have the SHA-256 manifest.json gives.');
  }
  return { problems, entries, postInstall: pi ? dec.decode(pi.data) : null };
}
