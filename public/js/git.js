// @ts-check
// A read-only Git repository reader for the browser: Publish reads the local source
// repository of a module firmware (a folder the colleague picks with showDirectoryPicker() or
// an <input webkitdirectory>) to suggest a changelog: the annotation of a version tag, or the
// commit subjects since the previous version tag. Nothing is ever written to the repository.
//
// What it reads, all from <folder>/.git (or from the chosen folder itself when that is a .git
// folder):
//   - refs: HEAD (a branch or a bare commit id), loose refs and packed-refs (with its ^ peel
//     lines); tags under refs/tags, also with a "/" in their name;
//   - files of a commit (fileAt): its tree, followed path by path, to the blob, so Publish sends
//     the bytes git holds (LF) rather than a Windows work tree's copy (CRLF with core.autocrlf);
//   - the remote: origin's URL in config and its tracking branch (refs/remotes/origin/<branch>),
//     to tell whether HEAD has been pushed (reaches);
//   - objects: loose (objects/xx/…, one zlib stream each) and packed (every objects/pack/*.idx,
//     version 2 with the large-offset table, and its .pack), including OFS_DELTA and REF_DELTA
//     entries whose base is in the same pack, in another pack or loose. Every object that is
//     read is checked against its SHA-1.
// Inflating uses DecompressionStream('deflate') (zlib, RFC 1950). Chrome rejects bytes after
// the end of a zlib stream, so a packed object is cut out exactly: it ends where the next
// object of its pack begins (the sorted offsets of the .idx), or 20 bytes (the checksum)
// before the end of the pack. Only those slices are read (Blob.slice), never a whole pack; the
// parsed .idx files and the inflated objects are kept per Repo, within a memory budget.
//
// Not supported, each with a GitError that says so: a .git that is a file (a worktree or a
// submodule), SHA-256 repositories (extensions.objectformat), the reftable ref store
// (extensions.refstorage) and pack index version 1. Objects borrowed from another repository
// (objects/info/alternates) cannot be read, because only the chosen folder is visible: they
// show up as missing objects. In a shallow clone (.git/shallow) the history walk stops at the
// shallow commits, as git log does.
//
// Pure logic over a DirReader (no DOM): test/git.test.ts runs it in workerd against a
// repository made with the git CLI (scripts/git-fixture.mjs).

/** A repository this cannot read, or a damaged one. The message is meant for the colleague. */
export class GitError extends Error {}

/** @typedef {{ name: string, kind: 'file' | 'directory' }} DirEntry */
/**
 * @typedef {{ list(path: string): Promise<DirEntry[] | null>, file(path: string): Promise<Blob | null> }} DirReader
 *   paths are relative to the chosen folder, '/'-separated, '' = the folder itself; null = does not exist
 */

/** @typedef {'commit' | 'tree' | 'blob' | 'tag'} ObjectType */
/** @typedef {{ type: ObjectType, data: Uint8Array }} GitObject */
/**
 * @typedef {{ sha: string, parents: string[], author: string, authorEmail: string, authorDate: string,
 *   committerDate: string, subject: string, body: string }} Commit
 *   dates are ISO 8601 in the time zone they were made in, as git log's %aI / %cI ("Z" for UTC);
 *   subject is git's %s (the first paragraph on one line), body the rest without trailing whitespace
 */
/**
 * @typedef {{ name: string, commit: string, annotated: boolean, message: string | null, date: string | null }} Tag
 *   name without refs/tags/; commit is the tag peeled to its commit; message (the annotation,
 *   without a signature and trailing whitespace) and date (the tagger's) only for an annotated tag
 */
/** @typedef {{ commit: string, branch: string | null }} Head  branch null when HEAD is detached */

const SHA = /^[0-9a-f]{40}$/;

/** Commits marked as reachable from `exclude` in log() at most (see Repo.log). */
export const EXCLUDE_LIMIT = 5000;
/** Longest delta chain followed (git itself writes at most 4095). */
const MAX_DELTA_DEPTH = 4096;
/** Bytes of inflated objects kept per Repo, per cache. */
const CACHE_BYTES = 32 * 1024 * 1024;

/** @param {string} sha */
const short = (sha) => sha.slice(0, 12);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** @param {Uint8Array} bytes */
function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += HEX[b];
  return s;
}
/** @param {string} sha  40 hex characters */
function fromHex(sha) {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(sha.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** A commit id from the caller, lower case; GitError when it is none. @param {string} sha */
function checkSha(sha) {
  const s = String(sha ?? '').trim().toLowerCase();
  if (!SHA.test(s)) throw new GitError(`"${sha}" is not a commit id (40 hexadecimal characters).`);
  return s;
}

// ── Folders ──────────────────────────────────────────────────────────────────

/** Whether an error of the File System Access API means "not there" (or "not that kind"). @param {unknown} err */
const notThere = (err) => {
  const name = typeof err === 'object' && err && 'name' in err ? err.name : '';
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};

/**
 * The parts of a FileSystemDirectoryHandle this uses, so the module also type-checks without
 * the DOM typings (the tests run it in workerd). values() is read through a cast: it is in the
 * DOM's async-iterable typings, which public/js does not load.
 * @typedef {{
 *   getDirectoryHandle(name: string): Promise<DirectoryHandle>,
 *   getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>,
 * }} DirectoryHandle
 */
/** @typedef {{ values(): AsyncIterable<{ name: string, kind: string }> }} DirectoryValues */

/**
 * A DirReader over a folder from showDirectoryPicker() (a FileSystemDirectoryHandle).
 * Directory handles are kept once found.
 * @param {DirectoryHandle} handle
 * @returns {DirReader}
 */
export function dirFromHandle(handle) {
  /** @type {Map<string, DirectoryHandle>} */
  const dirs = new Map([['', handle]]);

  /** @param {string} path @returns {Promise<DirectoryHandle | null>} */
  async function dir(path) {
    const known = dirs.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const parent = await dir(cut < 0 ? '' : path.slice(0, cut));
    if (!parent) return null;
    try {
      const found = await parent.getDirectoryHandle(path.slice(cut + 1));
      dirs.set(path, found);
      return found;
    } catch (err) {
      if (notThere(err)) return null;
      throw err;
    }
  }

  return {
    async list(path) {
      const d = await dir(path);
      if (!d) return null;
      const values = /** @type {DirectoryValues} */ (/** @type {unknown} */ (d)).values();
      /** @type {DirEntry[]} */
      const out = [];
      for await (const entry of values) out.push({ name: entry.name, kind: entry.kind === 'directory' ? 'directory' : 'file' });
      return out;
    },
    async file(path) {
      const cut = path.lastIndexOf('/');
      const d = await dir(cut < 0 ? '' : path.slice(0, cut));
      if (!d) return null;
      try {
        return await (await d.getFileHandle(path.slice(cut + 1))).getFile();
      } catch (err) {
        if (notThere(err)) return null;
        throw err;
      }
    },
  };
}

/** @typedef {Blob & { name: string, webkitRelativePath?: string }} FileLike  a File */

/**
 * A DirReader over the files of an <input webkitdirectory>: their webkitRelativePath starts
 * with the name of the chosen folder, which is cut off ("firmware/.git/HEAD" is ".git/HEAD").
 * @param {ArrayLike<FileLike> | Iterable<FileLike>} files  a FileList or File[]
 * @returns {DirReader}
 */
export function dirFromFiles(files) {
  /** @type {Map<string, FileLike>} */
  const byPath = new Map();
  /** @type {Map<string, Map<string, 'file' | 'directory'>>} */
  const dirs = new Map([['', new Map()]]);
  for (const f of Array.from(files)) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    const segs = parts.length > 1 ? parts.slice(1) : parts;
    for (let i = 0; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      let children = dirs.get(parent);
      if (!children) dirs.set(parent, (children = new Map()));
      children.set(segs[i], i === segs.length - 1 ? 'file' : 'directory');
    }
    byPath.set(segs.join('/'), f);
  }
  return {
    async list(path) {
      const children = dirs.get(path);
      return children ? [...children].map(([name, kind]) => ({ name, kind })) : null;
    },
    async file(path) {
      return byPath.get(path) ?? null;
    },
  };
}

// ── zlib and deltas ──────────────────────────────────────────────────────────

/**
 * Inflate one complete zlib stream (RFC 1950), or null when it does not inflate.
 * @param {Uint8Array} bytes
 */
async function inflate(bytes) {
  try {
    const stream = new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Apply a git delta (the data of an OFS_DELTA or REF_DELTA entry) to its base: two sizes as
 * varints (base, result), then copy instructions (bit 7 set: offset and size bytes selected
 * by bits 0–3 and 4–6, size 0 meaning 0x10000) and insert instructions (1–127 literal bytes).
 * @param {Uint8Array} base
 * @param {Uint8Array} delta
 * @returns {Uint8Array}
 */
export function applyDelta(base, delta) {
  let pos = 0;
  const damaged = () => new GitError('The repository is damaged: a delta does not fit its base object.');
  const byte = () => {
    if (pos >= delta.length) throw damaged();
    return delta[pos++];
  };
  const varint = () => {
    let value = 0;
    let scale = 1;
    let b;
    do {
      b = byte();
      value += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80);
    return value;
  };
  if (varint() !== base.length) throw damaged();
  const size = varint();
  const out = new Uint8Array(size);
  let at = 0;
  while (pos < delta.length) {
    const cmd = byte();
    if (cmd & 0x80) {
      let offset = 0;
      let length = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) offset += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) length += byte() * 2 ** (8 * i);
      if (!length) length = 0x10000;
      if (offset + length > base.length || at + length > size) throw damaged();
      out.set(base.subarray(offset, offset + length), at);
      at += length;
    } else if (cmd) {
      if (pos + cmd > delta.length || at + cmd > size) throw damaged();
      out.set(delta.subarray(pos, pos + cmd), at);
      at += cmd;
      pos += cmd;
    } else {
      throw damaged(); // opcode 0 is reserved
    }
  }
  if (at !== size) throw damaged();
  return out;
}

// ── Pack index (.idx, version 2) ─────────────────────────────────────────────

/**
 * @typedef {{ count: number, names: Uint8Array, offsets: Float64Array, find(sha: string): number }} PackIndex
 *   names: count × 20 bytes, sorted; offsets in the same order; find() gives the pack offset of
 *   an object, or -1
 */

/**
 * Parse a pack index, version 2: magic ff 74 4f 63, version, 256 fan-out counts, the sorted
 * SHA-1s, their CRC-32s, 4-byte offsets (bit 31 set: an index into the 8-byte large-offset
 * table) and two checksums.
 * @param {Uint8Array} bytes
 * @returns {PackIndex}
 */
export function parsePackIndex(bytes) {
  const damaged = () => new GitError('The repository is damaged: a pack index (objects/pack/*.idx) cannot be read.');
  if (bytes.length < 8 + 1024 + 40) throw damaged();
  if (bytes[0] !== 0xff || bytes[1] !== 0x74 || bytes[2] !== 0x4f || bytes[3] !== 0x63) {
    throw new GitError('The repository has a pack index of version 1, which is not supported: run "git gc" in it first.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4) !== 2) throw new GitError(`The repository has a pack index of version ${view.getUint32(4)}, which is not supported.`);
  const fanout = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    fanout[i] = view.getUint32(8 + 4 * i);
    if (i && fanout[i] < fanout[i - 1]) throw damaged();
  }
  const count = fanout[255];
  const namesAt = 8 + 1024;
  const offsetsAt = namesAt + 24 * count; // after the names and the CRC-32s
  const largeAt = offsetsAt + 4 * count;
  if (bytes.length < largeAt + 40) throw damaged();
  const largeCount = (bytes.length - 40 - largeAt) / 8;
  const offsets = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = view.getUint32(offsetsAt + 4 * i);
    if (v & 0x80000000) {
      const k = v & 0x7fffffff;
      if (k >= largeCount) throw damaged();
      offsets[i] = view.getUint32(largeAt + 8 * k) * 2 ** 32 + view.getUint32(largeAt + 8 * k + 4);
    } else {
      offsets[i] = v;
    }
  }
  const names = bytes.subarray(namesAt, namesAt + 20 * count);
  return {
    count,
    names,
    offsets,
    find(sha) {
      const key = fromHex(sha);
      let lo = key[0] ? fanout[key[0] - 1] : 0;
      let hi = fanout[key[0]];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        let cmp = 0;
        for (let j = 0; j < 20 && !cmp; j++) cmp = names[20 * mid + j] - key[j];
        if (!cmp) return offsets[mid];
        if (cmp < 0) lo = mid + 1;
        else hi = mid;
      }
      return -1;
    },
  };
}

/** @typedef {{ name: string, blob: Blob, index: PackIndex, ends: Float64Array }} Pack  ends: the offsets, sorted */

// ── Commits and tags ─────────────────────────────────────────────────────────

const UTF8 = new TextDecoder();
/** git's isspace: ASCII only. */
const BLANK = /^[ \t\n\v\f\r]*$/;
/** @param {string} s */
const trimEnd = (s) => s.replace(/[ \t\n\v\f\r]+$/, '');

/**
 * Split a commit or tag object into its headers (continuation lines skipped) and message.
 * @param {string} text
 */
function splitObject(text) {
  const end = text.indexOf('\n\n');
  /** @type {Map<string, string[]>} */
  const headers = new Map();
  for (const line of (end < 0 ? text : text.slice(0, end)).split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const values = headers.get(key) ?? [];
    values.push(sp < 0 ? '' : line.slice(sp + 1));
    headers.set(key, values);
  }
  return { headers, message: end < 0 ? '' : text.slice(end + 2) };
}

/**
 * Decode a commit or tag in the encoding its "encoding" header names (UTF-8 otherwise).
 * @param {Uint8Array} data
 */
function decodeObject(data) {
  const text = UTF8.decode(data);
  const parsed = splitObject(text);
  const encoding = parsed.headers.get('encoding')?.[0];
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    try {
      return splitObject(new TextDecoder(encoding).decode(data));
    } catch {
      // an encoding the browser does not know: keep UTF-8
    }
  }
  return parsed;
}

/**
 * ISO 8601 in the given zone, like git's iso-strict ("Z" for +0000).
 * @param {number} seconds @param {string} zone  e.g. "+0130"
 */
function isoDate(seconds, zone) {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(zone);
  const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date((seconds + minutes * 60) * 1000);
  if (Number.isNaN(local.getTime())) return '';
  const base = local.toISOString().slice(0, 19);
  return m && minutes ? `${base}${m[1]}${m[2]}:${m[3]}` : `${base}Z`;
}

/**
 * "Name <email> 1767603600 +0100" (author, committer, tagger).
 * @param {string | undefined} line
 */
function ident(line = '') {
  const lt = line.indexOf('<');
  const gt = lt < 0 ? -1 : line.indexOf('>', lt);
  const [stamp = '', zone = '+0000'] = line.slice(line.lastIndexOf('>') + 1).trim().split(/\s+/);
  const time = /^-?\d+$/.test(stamp) ? Number(stamp) : 0;
  return {
    name: (lt < 0 ? line : line.slice(0, lt)).trim(),
    email: gt < 0 ? '' : line.slice(lt + 1, gt),
    time,
    date: isoDate(time, zone),
  };
}

/**
 * git's subject (%s: blank lines skipped, the first paragraph with its lines' trailing
 * whitespace removed, joined with spaces) and the body after it (without trailing whitespace).
 * @param {string} message
 */
function splitMessage(message) {
  const lines = message.split('\n');
  let i = 0;
  while (i < lines.length && BLANK.test(lines[i])) i++;
  const subject = [];
  while (i < lines.length && !BLANK.test(lines[i])) subject.push(trimEnd(lines[i++]));
  while (i < lines.length && BLANK.test(lines[i])) i++;
  return { subject: subject.join(' '), body: trimEnd(lines.slice(i).join('\n')) };
}

/** A signature line that starts the end of a signed tag's message (git's parse_signed_buffer). */
const SIGNATURE = /^-----BEGIN (PGP SIGNATURE|PGP MESSAGE|SSH SIGNATURE|SIGNED MESSAGE)-----/;

/**
 * @param {string} sha @param {Uint8Array} data
 * @returns {Entry}  time: the committer date in seconds, for ordering; tree: the id of its root tree
 */
function parseCommit(sha, data) {
  const { headers, message } = decodeObject(data);
  const parents = headers.get('parent') ?? [];
  if (!headers.has('tree') || parents.some((p) => !SHA.test(p))) {
    throw new GitError(`The repository is damaged: commit ${short(sha)} cannot be read.`);
  }
  const author = ident(headers.get('author')?.[0]);
  const committer = ident(headers.get('committer')?.[0]);
  return {
    commit: { sha, parents: [...parents], author: author.name, authorEmail: author.email, authorDate: author.date, committerDate: committer.date, ...splitMessage(message) },
    time: committer.time,
    tree: /** @type {string[]} */ (headers.get('tree'))[0],
  };
}

/**
 * One entry of a tree object (mode SP name NUL 20-byte id), or null.
 * @param {Uint8Array} data @param {string} name
 * @returns {{ mode: string, sha: string } | null}
 */
function treeEntry(data, name) {
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(32, at);
    const nul = sp < 0 ? -1 : data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new GitError('The repository is damaged: a tree cannot be read.');
    if (UTF8.decode(data.subarray(sp + 1, nul)) === name) {
      return { mode: UTF8.decode(data.subarray(at, sp)), sha: toHex(data.subarray(nul + 1, nul + 21)) };
    }
    at = nul + 21;
  }
  return null;
}

/** @param {string} sha @param {Uint8Array} data */
function parseTag(sha, data) {
  const { headers, message } = decodeObject(data);
  const object = headers.get('object')?.[0] ?? '';
  if (!SHA.test(object)) throw new GitError(`The repository is damaged: tag object ${short(sha)} cannot be read.`);
  let cut = message.length;
  let at = 0;
  for (const line of message.split('\n')) {
    if (SIGNATURE.test(line)) cut = at;
    at += line.length + 1;
  }
  const tagger = headers.get('tagger')?.[0];
  return { object, message: trimEnd(message.slice(0, cut)), date: tagger ? ident(tagger).date : null };
}

// ── Caches and the commit queue ──────────────────────────────────────────────

/** Inflated objects by key, dropping the oldest when over budget. */
class ObjectCache {
  /** @param {number} budget  bytes */
  constructor(budget) {
    this.budget = budget;
    this.bytes = 0;
    /** @type {Map<string, GitObject>} */
    this.map = new Map();
  }

  /** @param {string} key */
  get(key) {
    return this.map.get(key);
  }

  /** @param {string} key @param {GitObject} obj */
  set(key, obj) {
    if (this.map.has(key)) return;
    this.map.set(key, obj);
    this.bytes += obj.data.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.budget || k === key) break;
      this.map.delete(k);
      this.bytes -= v.data.length;
    }
  }
}

/** @typedef {{ commit: Commit, time: number, tree: string }} Entry */

/** Commits by committer date, newest first; equal dates in the order they came in (as git). */
class CommitQueue {
  constructor() {
    /** @type {{ entry: Entry, seq: number }[]} */
    this.heap = [];
    this.seq = 0;
  }

  get size() {
    return this.heap.length;
  }

  /** @param {number} a @param {number} b  whether heap[a] comes before heap[b] */
  before(a, b) {
    const x = this.heap[a];
    const y = this.heap[b];
    return x.entry.time !== y.entry.time ? x.entry.time > y.entry.time : x.seq < y.seq;
  }

  /** @param {number} a @param {number} b */
  swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
  }

  /** @param {Entry} entry */
  push(entry) {
    this.heap.push({ entry, seq: this.seq++ });
    for (let i = this.heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** @returns {Entry} */
  pop() {
    const top = this.heap[0];
    const last = /** @type {{ entry: Entry, seq: number }} */ (this.heap.pop());
    if (this.heap.length) {
      this.heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.heap.length && this.before(l, best)) best = l;
        if (r < this.heap.length && this.before(r, best)) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top.entry;
  }
}

// ── The repository ───────────────────────────────────────────────────────────

const TYPES = /** @type {Record<number, ObjectType>} */ ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });
const OFS_DELTA = 6;
const REF_DELTA = 7;

/**
 * A repository opened by openRepo(). Read-only; reads and caches as it goes.
 */
export class Repo {
  /**
   * @param {DirReader} dir  the chosen folder
   * @param {string} gitDir  '.git', or '' when the chosen folder is the .git folder
   */
  constructor(dir, gitDir) {
    this.dir = dir;
    this.gitDir = gitDir;
    /** @type {Head} */
    this.head = { commit: '', branch: null };
    /** @type {Set<string>} commits whose parents a shallow clone does not have */
    this.shallow = new Set();
    /** @type {Promise<Pack[]> | null} */
    this.packsLoaded = null;
    /** @type {Promise<Map<string, { sha: string, peeled: string | null }>> | null} */
    this.packedRefsLoaded = null;
    this.objects = new ObjectCache(CACHE_BYTES); // by SHA-1
    this.bases = new ObjectCache(CACHE_BYTES); // packed objects by pack and offset
    /** @type {Map<string, Entry>} */
    this.commits = new Map();
  }

  /** @param {string} path  relative to the git dir */
  path(path) {
    return this.gitDir ? `${this.gitDir}/${path}` : path;
  }

  /** @param {string} path  relative to the git dir */
  async text(path) {
    const blob = await this.dir.file(this.path(path));
    return blob ? blob.text() : null;
  }

  /** Read config, HEAD and shallow. Called once by openRepo(). */
  async init() {
    let section = '';
    for (const raw of ((await this.text('config')) ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[\s*([A-Za-z0-9.-]+)/.exec(line);
      if (header) {
        section = header[1].toLowerCase();
        continue;
      }
      const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*"?([^"#;\s]*)/.exec(line);
      if (section !== 'extensions' || !kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].toLowerCase();
      if (key === 'objectformat' && value !== 'sha1') {
        throw new GitError(`This repository uses ${value} object ids; only SHA-1 repositories are supported.`);
      }
      if (key === 'refstorage' && value !== 'files') {
        throw new GitError(`This repository keeps its refs in ${value}, which is not supported.`);
      }
    }

    const head = (await this.text('HEAD'))?.trim();
    if (!head) throw new GitError('The repository is damaged: it has no HEAD.');
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const commit = await this.resolveRef(ref);
      const branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      if (!commit) throw new GitError(`The repository has no commits yet on ${branch}.`);
      this.head = { commit, branch };
    } else if (SHA.test(head)) {
      this.head = { commit: head, branch: null };
    } else {
      throw new GitError('The repository is damaged: HEAD cannot be read.');
    }

    for (const line of ((await this.text('shallow')) ?? '').split(/\r?\n/)) {
      if (SHA.test(line.trim())) this.shallow.add(line.trim());
    }
  }

  // ── Refs ──

  /** packed-refs: name → { sha, peeled } (peeled: the ^ line under an annotated tag). */
  packedRefs() {
    this.packedRefsLoaded ??= (async () => {
      /** @type {Map<string, { sha: string, peeled: string | null }>} */
      const refs = new Map();
      /** @type {{ sha: string, peeled: string | null } | null} */
      let last = null;
      for (const raw of ((await this.text('packed-refs')) ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('^')) {
          if (last && SHA.test(line.slice(1))) last.peeled = line.slice(1);
          continue;
        }
        const sp = line.indexOf(' ');
        const sha = line.slice(0, sp);
        if (sp < 0 || !SHA.test(sha)) {
          last = null;
          continue;
        }
        last = { sha, peeled: null };
        refs.set(line.slice(sp + 1).trim(), last);
      }
      return refs;
    })();
    return this.packedRefsLoaded;
  }

  /**
   * The object a ref points to (loose ref first, then packed-refs; symbolic refs followed), or null.
   * @param {string} name  e.g. refs/heads/main
   * @returns {Promise<string | null>}
   */
  async resolveRef(name) {
    let ref = name;
    for (let depth = 0; depth < 10; depth++) {
      if (!/^refs\/./.test(ref) || ref.split('/').some((s) => !s || s === '.' || s === '..')) {
        throw new GitError(`The repository is damaged: "${ref}" is not a ref name.`);
      }
      const text = (await this.text(ref))?.trim();
      if (text === undefined) return (await this.packedRefs()).get(ref)?.sha ?? null;
      if (text.startsWith('ref:')) {
        ref = text.slice(4).trim();
        continue;
      }
      if (!SHA.test(text)) throw new GitError(`The repository is damaged: ${ref} cannot be read.`);
      return text;
    }
    throw new GitError(`The repository is damaged: ${name} refers to itself.`);
  }

  /**
   * Loose refs below a directory, into `into` (name → object id).
   * @param {string} prefix  e.g. refs/tags @param {Map<string, string>} into @param {number} [depth]
   */
  async looseRefs(prefix, into, depth = 0) {
    if (depth > 20) return;
    for (const entry of (await this.dir.list(this.path(prefix))) ?? []) {
      const name = `${prefix}/${entry.name}`;
      if (entry.kind === 'directory') await this.looseRefs(name, into, depth + 1);
      else if (!entry.name.endsWith('.lock')) {
        const sha = await this.resolveRef(name);
        if (sha) into.set(name, sha);
      }
    }
  }

  /**
   * Every tag that leads to a commit, sorted by name (as git for-each-ref). Loose refs win over
   * packed-refs; an annotated tag is read for its message and date and peeled (also a tag of a
   * tag). A tag of a tree or a blob is left out.
   * @returns {Promise<Tag[]>}
   */
  async tags() {
    /** @type {Map<string, string>} */
    const refs = new Map();
    for (const [name, ref] of await this.packedRefs()) if (name.startsWith('refs/tags/')) refs.set(name, ref.sha);
    await this.looseRefs('refs/tags', refs);
    /** @type {Tag[]} */
    const out = [];
    for (const name of [...refs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      let sha = /** @type {string} */ (refs.get(name));
      let obj = await this.readObject(sha);
      /** @type {{ message: string, date: string | null } | null} */
      let annotation = null;
      for (let depth = 0; obj.type === 'tag'; depth++) {
        if (depth > 10) throw new GitError(`The repository is damaged: tag ${name.slice(10)} does not lead to a commit.`);
        const tag = parseTag(sha, obj.data);
        annotation ??= { message: tag.message, date: tag.date };
        sha = tag.object;
        obj = await this.readObject(sha);
      }
      if (obj.type !== 'commit') continue;
      out.push({ name: name.slice(10), commit: sha, annotated: !!annotation, message: annotation?.message ?? null, date: annotation?.date ?? null });
    }
    return out;
  }

  // ── Objects ──

  /** The packs, their .idx parsed and their header checked; once per Repo. */
  packs() {
    this.packsLoaded ??= (async () => {
      const dir = 'objects/pack';
      const listing = (await this.dir.list(this.path(dir))) ?? [];
      const names = new Set(listing.filter((e) => e.kind === 'file').map((e) => e.name));
      /** @type {Pack[]} */
      const packs = [];
      for (const idxName of [...names].filter((n) => n.endsWith('.idx')).sort()) {
        const name = idxName.slice(0, -4);
        if (!names.has(`${name}.pack`)) continue; // an index without its pack is not in use
        const idxBlob = await this.dir.file(this.path(`${dir}/${idxName}`));
        const blob = await this.dir.file(this.path(`${dir}/${name}.pack`));
        if (!idxBlob || !blob) continue;
        const index = parsePackIndex(new Uint8Array(await idxBlob.arrayBuffer()));
        const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        const view = new DataView(head.buffer);
        if (head.length < 12 || view.getUint32(0) !== 0x5041434b || ![2, 3].includes(view.getUint32(4)) || view.getUint32(8) !== index.count) {
          throw new GitError(`The repository is damaged: ${name}.pack does not match its index.`);
        }
        packs.push({ name, blob, index, ends: Float64Array.from(index.offsets).sort() });
      }
      return packs;
    })();
    return this.packsLoaded;
  }

  /**
   * Read an object by its SHA-1: from a pack, else loose. Checked against its id.
   * @param {string} sha
   * @returns {Promise<GitObject>}
   */
  async readObject(sha) {
    return this.object(checkSha(sha), 0);
  }

  /** @param {string} sha @param {number} depth  delta chain followed so far */
  async object(sha, depth) {
    const cached = this.objects.get(sha);
    if (cached) return cached;
    /** @type {GitObject | null} */
    let obj = null;
    for (const pack of await this.packs()) {
      const offset = pack.index.find(sha);
      if (offset >= 0) {
        obj = await this.packed(pack, offset, depth);
        break;
      }
    }
    obj ??= await this.loose(sha);
    if (!obj) throw await this.missing(sha);
    const header = new TextEncoder().encode(`${obj.type} ${obj.data.length}\0`);
    const whole = new Uint8Array(header.length + obj.data.length);
    whole.set(header);
    whole.set(obj.data, header.length);
    if (toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))) !== sha) {
      throw new GitError(`The repository is damaged: object ${short(sha)} does not match its id.`);
    }
    this.objects.set(sha, obj);
    return obj;
  }

  /** @param {string} sha @returns {Promise<GitObject | null>} */
  async loose(sha) {
    const blob = await this.dir.file(this.path(`objects/${sha.slice(0, 2)}/${sha.slice(2)}`));
    if (!blob) return null;
    const all = await inflate(new Uint8Array(await blob.arrayBuffer()));
    const nul = all ? all.indexOf(0) : -1;
    const [type, size] = all && nul > 0 ? UTF8.decode(all.subarray(0, nul)).split(' ') : [];
    if (!all || !['commit', 'tree', 'blob', 'tag'].includes(type) || Number(size) !== all.length - nul - 1) {
      throw new GitError(`The repository is damaged: object ${short(sha)} cannot be read.`);
    }
    return { type: /** @type {ObjectType} */ (type), data: all.subarray(nul + 1) };
  }

  /** The error for an object that is nowhere. @param {string} sha */
  async missing(sha) {
    const borrowed = await this.dir.file(this.path('objects/info/alternates'));
    return new GitError(
      borrowed
        ? `Object ${short(sha)} is not in this repository: it borrows objects from another one (objects/info/alternates), which is not supported.`
        : `The repository is damaged: object ${short(sha)} is missing.`,
    );
  }

  /**
   * The object at an offset of a pack, its delta chain resolved.
   * @param {Pack} pack @param {number} offset @param {number} depth
   * @returns {Promise<GitObject>}
   */
  async packed(pack, offset, depth) {
    const key = `${pack.name}@${offset}`;
    const cached = this.bases.get(key);
    if (cached) return cached;
    const damaged = () => new GitError(`The repository is damaged: ${pack.name}.pack cannot be read at offset ${offset}.`);
    if (depth > MAX_DELTA_DEPTH) throw damaged();
    // The entry ends where the next one starts, or before the pack's 20-byte checksum.
    const ends = pack.ends;
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ends[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    const end = lo < ends.length ? ends[lo] : pack.blob.size - 20;
    if (!(end > offset)) throw damaged();
    const raw = new Uint8Array(await pack.blob.slice(offset, end).arrayBuffer());
    let pos = 0;
    const byte = () => {
      if (pos >= raw.length) throw damaged();
      return raw[pos++];
    };
    let b = byte();
    const kind = (b >> 4) & 7;
    let size = b & 15;
    let scale = 16;
    while (b & 0x80) {
      b = byte();
      size += (b & 0x7f) * scale;
      scale *= 128;
    }
    /** @type {GitObject | null} */
    let base = null;
    if (kind === OFS_DELTA) {
      b = byte();
      let back = b & 0x7f;
      while (b & 0x80) {
        b = byte();
        back = (back + 1) * 128 + (b & 0x7f);
      }
      if (back <= 0 || back > offset) throw damaged();
      base = await this.packed(pack, offset - back, depth + 1);
    } else if (kind === REF_DELTA) {
      if (pos + 20 > raw.length) throw damaged();
      base = await this.object(toHex(raw.subarray(pos, pos + 20)), depth + 1);
      pos += 20;
    } else if (!TYPES[kind]) {
      throw damaged();
    }
    const data = await inflate(raw.subarray(pos));
    if (!data || data.length !== size) throw damaged();
    /** @type {GitObject} */
    const obj = base ? { type: base.type, data: applyDelta(base.data, data) } : { type: TYPES[kind], data };
    this.bases.set(key, obj);
    return obj;
  }

  // ── Files and the remote ──

  /**
   * The bytes of a file in a commit, or null when that commit has no such file (or the path is
   * a folder or a submodule).
   * @param {string} commitSha
   * @param {string} path  '/'-separated, from the root of the repository
   * @returns {Promise<Uint8Array | null>}
   */
  async fileAt(commitSha, path) {
    const parts = path.split('/').filter(Boolean);
    let tree = (await this.entry(checkSha(commitSha))).tree;
    for (const [i, part] of parts.entries()) {
      const obj = await this.object(checkSha(tree), 0);
      if (obj.type !== 'tree') throw new GitError(`The repository is damaged: ${short(tree)} is not a tree.`);
      const found = treeEntry(obj.data, part);
      if (!found) return null;
      const folder = found.mode === '40000';
      if (i < parts.length - 1) {
        if (!folder) return null;
        tree = found.sha;
        continue;
      }
      if (folder || found.mode === '160000') return null;
      const blob = await this.object(found.sha, 0);
      return blob.type === 'blob' ? blob.data : null;
    }
    return null;
  }

  /**
   * The URL of a remote in .git/config, or null.
   * @param {string} [remote]
   * @returns {Promise<string | null>}
   */
  async remoteUrl(remote = 'origin') {
    let inRemote = false;
    for (const raw of ((await this.text('config')) ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
      if (header) {
        inRemote = header[1].toLowerCase() === 'remote' && header[2] === remote;
        continue;
      }
      const kv = /^url\s*=\s*"?([^"\s]+)"?/i.exec(line);
      if (inRemote && kv) return kv[1];
    }
    return null;
  }

  /**
   * The commit a remote-tracking branch points to (as of the last fetch), or null.
   * @param {string} branch @param {string} [remote]
   * @returns {Promise<string | null>}
   */
  async remoteBranch(branch, remote = 'origin') {
    return this.resolveRef(`refs/remotes/${remote}/${branch}`);
  }

  /**
   * Whether `target` is `from` or one of its ancestors; null when that was not settled within
   * `limit` commits.
   * @param {string} from @param {string} target @param {number} [limit]
   * @returns {Promise<boolean | null>}
   */
  async reaches(from, target, limit = EXCLUDE_LIMIT) {
    const goal = checkSha(target);
    const start = checkSha(from);
    if (start === goal) return true;
    const seen = new Set([start]);
    const queue = new CommitQueue();
    queue.push(await this.entry(start));
    while (queue.size) {
      if (seen.size > limit) return null;
      for (const p of this.parentsOf(queue.pop())) {
        if (p === goal) return true;
        if (seen.has(p)) continue;
        seen.add(p);
        queue.push(await this.entry(p));
      }
    }
    return false;
  }

  // ── History ──

  /** @param {string} sha @returns {Promise<Entry>} */
  async entry(sha) {
    const known = this.commits.get(sha);
    if (known) return known;
    const obj = await this.object(sha, 0);
    if (obj.type !== 'commit') throw new GitError(`${short(sha)} is a ${obj.type}, not a commit.`);
    const entry = parseCommit(sha, obj.data);
    this.commits.set(sha, entry);
    return entry;
  }

  /**
   * One commit.
   * @param {string} sha
   * @returns {Promise<Commit>}
   */
  async readCommit(sha) {
    return (await this.entry(checkSha(sha))).commit;
  }

  /** The parents a walk follows: none for a shallow commit. @param {Entry} e */
  parentsOf(e) {
    return this.shallow.has(e.commit.sha) ? [] : e.commit.parents;
  }

  /**
   * The commits reachable from `from` and not from `exclude` (git log exclude..from), newest
   * committer date first, at most `max`.
   *
   * First everything reachable from `exclude` is marked, newest first, up to EXCLUDE_LIMIT
   * (5000) commits; then the walk from `from` skips marked commits and does not go past them.
   * When `exclude` has more history than that and `from` branched off before the 5000th
   * newest of it, older commits can show up; `max` bounds the result either way.
   *
   * @param {{ from: string, exclude?: string | null, max?: number }} options
   * @returns {Promise<Commit[]>}
   */
  async log({ from, exclude = null, max = 200 }) {
    const start = checkSha(from);
    const limit = Math.max(0, Math.floor(max));
    /** @type {Set<string>} */
    const hidden = new Set();
    if (exclude) {
      const sha = checkSha(exclude);
      const queue = new CommitQueue();
      hidden.add(sha);
      queue.push(await this.entry(sha));
      while (queue.size && hidden.size < EXCLUDE_LIMIT) {
        for (const p of this.parentsOf(queue.pop())) {
          if (hidden.has(p)) continue;
          hidden.add(p);
          queue.push(await this.entry(p));
        }
      }
    }
    /** @type {Commit[]} */
    const out = [];
    if (hidden.has(start) || !limit) return out;
    const queue = new CommitQueue();
    const seen = new Set([start]);
    queue.push(await this.entry(start));
    while (queue.size && out.length < limit) {
      const e = queue.pop();
      out.push(e.commit);
      if (out.length === limit) break;
      for (const p of this.parentsOf(e)) {
        if (seen.has(p) || hidden.has(p)) continue;
        seen.add(p);
        queue.push(await this.entry(p));
      }
    }
    return out;
  }
}

/**
 * Open the repository in a chosen folder: its .git folder, or the folder itself when it is a
 * .git folder (HEAD, objects/ and refs/). Null when there is none.
 * @param {DirReader} dir
 * @returns {Promise<Repo | null>}
 */
export async function openRepo(dir) {
  let gitDir = '.git';
  if (!(await dir.list('.git'))) {
    if (await dir.file('.git')) {
      throw new GitError('This folder is a Git worktree or submodule (its .git is a file that points elsewhere), which is not supported: choose the folder of the main repository.');
    }
    if (!((await dir.file('HEAD')) && (await dir.list('objects')) && (await dir.list('refs')))) return null;
    gitDir = '';
  }
  const repo = new Repo(dir, gitDir);
  await repo.init();
  return repo;
}
