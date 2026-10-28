// public/js/git.js: the read-only Git reader Publish uses to suggest a changelog.
// test/fixtures/git/fixture.json is a repository made with the git CLI (scripts/git-fixture.mjs):
// every file of its .git/ plus git's own answers (HEAD, commits, tags, objects, git log of
// several ranges). The reader runs here in workerd, which has the same Blob,
// DecompressionStream and crypto.subtle as a browser, over a DirReader built on that map.

import { describe, expect, it } from 'vitest';
import {
  EXCLUDE_LIMIT,
  GitError,
  applyDelta,
  dirFromFiles,
  dirFromHandle,
  openRepo,
  parsePackIndex,
  type DirReader,
  type Repo,
} from '../public/js/git.js';
import fixture from './fixtures/git/fixture.json';

type ExpectedCommit = { parents: string[]; author: string; authorEmail: string; authorDate: string; committerDate: string; subject: string; body: string };
type Range = { label: string; from: string; exclude?: string; max?: number; shas: string[] };

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const FILES: Record<string, Uint8Array> = Object.fromEntries(Object.entries(fixture.files as Record<string, string>).map(([k, v]) => [k, unb64(v)]));
const named = fixture.named as Record<string, string>;
const expected = fixture.expected;
const commits = expected.commits as unknown as Record<string, ExpectedCommit>;
const objects = expected.objects as unknown as Record<string, { type: string; size: number }>;
const ranges = expected.logs as unknown as Range[];
const enc = (s: string) => new TextEncoder().encode(s);

type Read = { path: string; start: number; end: number };

/** A Blob over bytes that records every read of its contents. */
function trackedBlob(path: string, bytes: Uint8Array, reads: Read[]): Blob {
  const blob = new Blob([bytes]);
  const whole = () => reads.push({ path, start: 0, end: bytes.length });
  return {
    size: bytes.length,
    type: '',
    slice(start = 0, end = bytes.length) {
      reads.push({ path, start, end });
      return blob.slice(start, end);
    },
    arrayBuffer() {
      whole();
      return blob.arrayBuffer();
    },
    text() {
      whole();
      return blob.text();
    },
    stream() {
      whole();
      return blob.stream();
    },
  } as unknown as Blob;
}

/** A DirReader over a map of path → bytes (directories are implied by the paths). */
function mapReader(files: Record<string, Uint8Array>, reads?: Read[]): DirReader {
  return {
    async list(path) {
      if (path in files) return null;
      const prefix = path ? `${path}/` : '';
      const kids = new Map<string, 'file' | 'directory'>();
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const cut = rest.indexOf('/');
        kids.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'directory');
      }
      return kids.size || !path ? [...kids].map(([name, kind]) => ({ name, kind })) : null;
    },
    async file(path) {
      const bytes = files[path];
      if (!bytes) return null;
      return reads ? trackedBlob(path, bytes, reads) : new Blob([bytes]);
    },
  };
}

/** The fixture with some files replaced (bytes or text) or removed (null). */
function variant(changes: Record<string, Uint8Array | string | null>): Record<string, Uint8Array> {
  const out = { ...FILES };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) delete out[path];
    else out[path] = typeof value === 'string' ? enc(value) : value;
  }
  return out;
}

async function open(files: Record<string, Uint8Array> = FILES, reads?: Read[]): Promise<Repo> {
  const repo = await openRepo(mapReader(files, reads));
  if (!repo) throw new Error('no repository');
  return repo;
}

/** The error a promise rejects with (the test fails when it does not). */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

const packPath = (pack: string) => `.git/objects/pack/${pack}`;

describe('the fixture repository, against the git CLI', () => {
  it('covers two packs (OFS_DELTA and REF_DELTA), packed-refs and loose objects and refs', () => {
    const packs = fixture.coverage.packs;
    expect(packs.some((p) => p.ofs_delta > 0)).toBe(true);
    expect(packs.some((p) => p.ref_delta > 0)).toBe(true);
    expect(fixture.coverage.loose_objects).toBeGreaterThan(0);
    expect(new TextDecoder().decode(FILES['.git/packed-refs'])).toMatch(/^\^[0-9a-f]{40}$/m);
    expect(Object.keys(FILES)).toContain('.git/refs/tags/v0.4.0');
  });

  it('reads HEAD: the branch and its commit', async () => {
    const repo = await open();
    expect(repo.head).toEqual(expected.head);
    expect(repo.head).toEqual({ commit: named.c10, branch: 'main' });
  });

  it('lists the tags as git for-each-ref does: loose and packed, annotated and lightweight', async () => {
    const tags = await (await open()).tags();
    expect(tags).toEqual(expected.tags);
    expect(tags.map((t) => [t.name, t.annotated])).toEqual([
      ['release/2026-01', false],
      ['v0.1.0', true],
      ['v0.2.0', false],
      ['v0.3.0', true],
      ['v0.4.0', true],
    ]);
  });

  it('reads every commit as git log does (%s, %b, %aI, %cI, non-ASCII names)', async () => {
    const repo = await open();
    expect(Object.keys(commits)).toHaveLength(10);
    for (const [sha, c] of Object.entries(commits)) {
      expect(await repo.readCommit(sha)).toEqual({ sha, ...c });
    }
    // The verbatim message: leading blank lines skipped, trailing whitespace of each subject line cut.
    expect((await repo.readCommit(named.c6)).subject).toBe('  Tune the timing of channel 4');
    expect((await repo.readCommit(named.c4)).author).toBe('Jörg Müller');
    expect((await repo.readCommit(named.m5)).parents).toEqual([named.c4, named.c3]);
  });

  it.each(ranges.map((r) => [r.label, r] as const))('git log %s', async (_label, r) => {
    const log = await (await open()).log({ from: r.from, exclude: r.exclude, max: r.max });
    expect(log.map((c) => c.sha)).toEqual(r.shas);
  });

  it('reads every object, from both packs and loose, each checked against its SHA-1', async () => {
    const reads: Read[] = [];
    const repo = await open(FILES, reads);
    expect(Object.keys(objects).length).toBeGreaterThan(30);
    for (const [sha, o] of Object.entries(objects)) {
      const obj = await repo.readObject(sha);
      expect([sha, obj.type, obj.data.length]).toEqual([sha, o.type, o.size]);
    }
    // Packs are only read in slices, never as a whole.
    for (const p of fixture.coverage.packs) {
      const path = packPath(p.pack);
      const size = FILES[path].length;
      const slices = reads.filter((r) => r.path === path);
      expect(slices.length).toBeGreaterThan(p.commit);
      for (const r of slices) expect(r.end - r.start).toBeLessThan(size - 20);
    }
    expect(reads.some((r) => /^\.git\/objects\/[0-9a-f]{2}\//.test(r.path))).toBe(true);
  });

  it('reads the same through dirFromFiles and dirFromHandle', async () => {
    for (const dir of [dirFromFiles(inputFiles(FILES)), dirFromHandle(fakeHandle(FILES) as Parameters<typeof dirFromHandle>[0])]) {
      const repo = await openRepo(dir);
      expect(repo?.head).toEqual(expected.head);
      expect(await repo?.tags()).toEqual(expected.tags);
      expect((await repo?.log({ from: named.c10, exclude: named.c6 }))?.map((c) => c.sha)).toEqual([named.c10, named.c9, named.c8, named.c7]);
    }
  });

  it('opens the .git folder itself when that is the chosen folder', async () => {
    const inner = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k.slice('.git/'.length), v]));
    const repo = await open(inner);
    expect(repo.head).toEqual(expected.head);
    expect(await repo.tags()).toEqual(expected.tags);
  });

  it('reads a detached HEAD and a HEAD on a branch that is only in packed-refs', async () => {
    expect((await open(variant({ '.git/HEAD': `${named.c4}\n` }))).head).toEqual({ commit: named.c4, branch: null });
    expect((await open(variant({ '.git/HEAD': 'ref: refs/heads/feature\n' }))).head).toEqual({ commit: named.c3, branch: 'feature' });
  });

  it('stops at the shallow commits of a shallow clone', async () => {
    const repo = await open(variant({ '.git/shallow': `${named.c2}\n` }));
    const all = ranges.find((r) => r.label === 'c10')!.shas;
    expect((await repo.log({ from: named.c10 })).map((c) => c.sha)).toEqual(all.filter((s) => s !== named.c1));
  });

  it('limits the log to max (200 by default) and checks the commit ids it is given', async () => {
    const repo = await open();
    expect(await repo.log({ from: named.c10, max: 0 })).toEqual([]);
    expect(await repo.log({ from: named.c10.toUpperCase(), max: 1 })).toHaveLength(1);
    expect(EXCLUDE_LIMIT).toBe(5000);
    const err = await rejection(repo.log({ from: 'v0.4.0' }));
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toBe('"v0.4.0" is not a commit id (40 hexadecimal characters).');
    const tagObject = Object.entries(objects).find(([, o]) => o.type === 'tag')![0];
    expect((await rejection(repo.readCommit(tagObject))).message).toBe(`${tagObject.slice(0, 12)} is a tag, not a commit.`);
  });
});

describe('folders that are no repository, or not one this reads', () => {
  it('gives null for a folder without .git', async () => {
    expect(await openRepo(mapReader({ 'README.md': enc('x'), 'src/main.c': enc('int main;') }))).toBeNull();
  });

  it('refuses a .git that is a file (a worktree or a submodule) with a clear message', async () => {
    const err = await rejection(openRepo(mapReader({ '.git': enc('gitdir: ../.git/modules/firmware\n'), 'main.c': enc('') })));
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/worktree or submodule.*not supported/);
  });

  it('refuses SHA-256 repositories and the reftable ref store', async () => {
    const sha256 = await rejection(open(variant({ '.git/config': '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n' })));
    expect(sha256.message).toBe('This repository uses sha256 object ids; only SHA-1 repositories are supported.');
    const reftable = await rejection(open(variant({ '.git/config': '[extensions]\n\trefstorage = reftable\n' })));
    expect(reftable.message).toBe('This repository keeps its refs in reftable, which is not supported.');
  });

  it('says so when the branch has no commits yet', async () => {
    const err = await rejection(open(variant({ '.git/HEAD': 'ref: refs/heads/empty\n' })));
    expect(err.message).toBe('The repository has no commits yet on empty.');
  });
});

/** A zlib stream of bytes. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('damaged repositories', () => {
  const looseC10 = `.git/objects/${named.c10.slice(0, 2)}/${named.c10.slice(2)}`;
  const looseC9 = `.git/objects/${named.c9.slice(0, 2)}/${named.c9.slice(2)}`;

  it('refuses a loose object that does not inflate, or holds something else than its id says', async () => {
    expect(FILES[looseC10]).toBeDefined();
    const garbage = await rejection((await open(variant({ [looseC10]: new Uint8Array([0x78, 0x9c, 1, 2, 3, 4]) }))).readCommit(named.c10));
    expect(garbage).toBeInstanceOf(GitError);
    expect(garbage.message).toBe(`The repository is damaged: object ${named.c10.slice(0, 12)} cannot be read.`);
    const other = await deflate(enc('blob 5\0hello'));
    const wrong = await rejection((await open(variant({ [looseC10]: other }))).readObject(named.c10));
    expect(wrong.message).toBe(`The repository is damaged: object ${named.c10.slice(0, 12)} does not match its id.`);
  });

  it('names a missing object, and alternates when the repository borrows objects', async () => {
    const missing = await rejection((await open(variant({ [looseC9]: null }))).log({ from: named.c10 }));
    expect(missing).toBeInstanceOf(GitError);
    expect(missing.message).toBe(`The repository is damaged: object ${named.c9.slice(0, 12)} is missing.`);
    const borrowed = await rejection((await open(variant({ [looseC9]: null, '.git/objects/info/alternates': '/elsewhere/objects\n' }))).readCommit(named.c9));
    expect(borrowed.message).toMatch(/borrows objects from another one \(objects\/info\/alternates\), which is not supported/);
  });

  it('refuses a damaged pack entry and a pack that does not match its index', async () => {
    const pack = fixture.coverage.packs.find((p) => p.ref_delta > 0)!.pack;
    const index = parsePackIndex(FILES[packPath(pack.replace(/\.pack$/, '.idx'))]);
    const offset = index.find(named.c8);
    expect(offset).toBeGreaterThan(0);
    const bytes = FILES[packPath(pack)].slice();
    for (let i = 4; i < 12; i++) bytes[offset + i] ^= 0x55;
    const entry = await rejection((await open(variant({ [packPath(pack)]: bytes }))).readCommit(named.c8));
    expect(entry).toBeInstanceOf(GitError);
    expect(entry.message).toMatch(/^The repository is damaged: (pack-[0-9a-f]+\.pack cannot be read at offset \d+|object [0-9a-f]{12} does not match its id)\.$/);

    const header = FILES[packPath(pack)].slice();
    header[0] = 0;
    const err = await rejection((await open(variant({ [packPath(pack)]: header }))).readCommit(named.c1));
    expect(err.message).toBe(`The repository is damaged: ${pack.replace(/\.pack$/, '')}.pack does not match its index.`);
  });
});

describe('deltas', () => {
  const base = enc('Hello, world! This is the base text.');

  it('copies and inserts (a hand-made delta)', () => {
    // base size 36, result size 34; copy 0+7, insert "Git", copy 12+24
    const delta = new Uint8Array([0x24, 0x22, 0x90, 0x07, 0x03, 0x47, 0x69, 0x74, 0x91, 0x0c, 0x18]);
    expect(base.length).toBe(36);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe('Hello, Git! This is the base text.');
  });

  it('reads multi-byte sizes, a second offset byte and size 0 as 0x10000', () => {
    const big = new Uint8Array(0x10100).map((_, i) => (i * 7) & 0xff);
    // base 0x10100 = 80 82 04, result 0x10000 = 80 80 04; copy with only offset byte 1 (0x100), no size bytes
    const out = applyDelta(big, new Uint8Array([0x80, 0x82, 0x04, 0x80, 0x80, 0x04, 0x82, 0x01]));
    expect(out.length).toBe(0x10000);
    expect([...out.subarray(0, 4)]).toEqual([...big.subarray(0x100, 0x104)]);
    expect(out[0xffff]).toBe(big[0x100ff]);
  });

  it.each([
    ['a base of another size', [0x25, 0x01, 0x01, 0x41]],
    ['the reserved opcode 0', [0x24, 0x01, 0x00]],
    ['a copy beyond the base', [0x24, 0x05, 0x91, 0x20, 0x05]],
    ['a result shorter than announced', [0x24, 0x05, 0x90, 0x03]],
    ['a result longer than announced', [0x24, 0x02, 0x90, 0x03]],
    ['a truncated insert', [0x24, 0x05, 0x05, 0x41]],
    ['a truncated size', [0xa4]],
  ])('refuses %s', (_name, delta) => {
    expect(() => applyDelta(base, new Uint8Array(delta))).toThrow(new GitError('The repository is damaged: a delta does not fit its base object.'));
  });
});

/** A version-2 pack index for the given (sorted) object ids and offsets; offsets ≥ 2^31 go to the large-offset table. */
function idx(entries: [string, number][]): Uint8Array {
  const n = entries.length;
  const large = entries.filter(([, o]) => o >= 2 ** 31);
  const out = new Uint8Array(8 + 1024 + 28 * n + 8 * large.length + 40);
  const view = new DataView(out.buffer);
  out.set([0xff, 0x74, 0x4f, 0x63]);
  view.setUint32(4, 2);
  for (let b = 0; b < 256; b++) view.setUint32(8 + 4 * b, entries.filter(([sha]) => parseInt(sha.slice(0, 2), 16) <= b).length);
  const namesAt = 8 + 1024;
  const offsetsAt = namesAt + 24 * n;
  const largeAt = offsetsAt + 4 * n;
  entries.forEach(([sha, offset], i) => {
    out.set(sha.match(/../g)!.map((h) => parseInt(h, 16)), namesAt + 20 * i);
    if (offset >= 2 ** 31) {
      const k = large.findIndex(([s]) => s === sha);
      view.setUint32(offsetsAt + 4 * i, 0x80000000 | k);
      view.setUint32(largeAt + 8 * k, Math.floor(offset / 2 ** 32));
      view.setUint32(largeAt + 8 * k + 4, offset % 2 ** 32);
    } else {
      view.setUint32(offsetsAt + 4 * i, offset);
    }
  });
  return out;
}

describe('pack index', () => {
  const a = `10${'ab'.repeat(19)}`;
  const b = `f0${'cd'.repeat(19)}`;

  it('reads 4-byte offsets and the 8-byte large-offset table', () => {
    const index = parsePackIndex(idx([[a, 12], [b, 2 ** 32 + 16]]));
    expect(index.count).toBe(2);
    expect([...index.offsets]).toEqual([12, 2 ** 32 + 16]);
    expect(index.find(a)).toBe(12);
    expect(index.find(b)).toBe(2 ** 32 + 16);
    expect(index.find(`10${'ab'.repeat(18)}ac`)).toBe(-1);
    expect(index.find('0'.repeat(40))).toBe(-1);
  });

  it('agrees with git verify-pack on the fixture packs', async () => {
    for (const p of fixture.coverage.packs) {
      const index = parsePackIndex(FILES[packPath(p.pack.replace(/\.pack$/, '.idx'))]);
      expect(index.count).toBe(p.commit + p.tree + p.blob + p.tag + p.ofs_delta + p.ref_delta);
    }
  });

  it('refuses version 1 and a truncated index', () => {
    expect(() => parsePackIndex(new Uint8Array(2000))).toThrow('pack index of version 1, which is not supported');
    expect(() => parsePackIndex(idx([[a, 12]]).subarray(0, 1090))).toThrow('a pack index (objects/pack/*.idx) cannot be read');
  });
});

// ── The two folder readers, over the fixture ─────────────────────────────────

/** Files as an <input webkitdirectory> gives them: webkitRelativePath starts with the chosen folder. */
function inputFiles(files: Record<string, Uint8Array>, root = 'firmware'): File[] {
  return Object.entries(files).map(([path, bytes]) => {
    const f = new File([bytes], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: `${root}/${path}` });
    return f;
  });
}

const domError = (name: string) => new DOMException(name, name);

/** A stand-in for a FileSystemDirectoryHandle over the map, failing as the browser does. */
function fakeHandle(files: Record<string, Uint8Array>, prefix = '', fail?: string): unknown {
  const isDir = (p: string) => Object.keys(files).some((k) => k.startsWith(`${p}/`));
  return {
    kind: 'directory',
    async getDirectoryHandle(name: string) {
      const p = prefix + name;
      if (p in files) throw domError('TypeMismatchError');
      if (!isDir(p)) throw domError('NotFoundError');
      return fakeHandle(files, `${p}/`, fail);
    },
    async getFileHandle(name: string) {
      const p = prefix + name;
      if (fail) throw domError(fail);
      if (!(p in files)) throw domError(isDir(p) ? 'TypeMismatchError' : 'NotFoundError');
      return { kind: 'file', name, getFile: async () => new File([files[p]], name) };
    },
    async *values() {
      const seen = new Set<string>();
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const cut = rest.indexOf('/');
        const name = cut < 0 ? rest : rest.slice(0, cut);
        if (seen.has(name)) continue;
        seen.add(name);
        yield { kind: cut < 0 ? 'file' : 'directory', name };
      }
    },
  };
}

describe('folder readers', () => {
  const small = { 'README.md': enc('readme'), 'src/main.c': enc('int main;'), 'src/lib/a.h': enc('#pragma once') };

  it.each([
    ['dirFromFiles', () => dirFromFiles(inputFiles(small))],
    ['dirFromHandle', () => dirFromHandle(fakeHandle(small) as Parameters<typeof dirFromHandle>[0])],
  ])('%s lists folders and reads files; null for what is not there', async (_name, make) => {
    const dir = make();
    const sorted = (entries: { name: string; kind: string }[] | null) => entries?.slice().sort((x, y) => x.name.localeCompare(y.name));
    expect(sorted(await dir.list(''))).toEqual([{ name: 'README.md', kind: 'file' }, { name: 'src', kind: 'directory' }]);
    expect(sorted(await dir.list('src'))).toEqual([{ name: 'lib', kind: 'directory' }, { name: 'main.c', kind: 'file' }]);
    expect(await (await dir.file('src/lib/a.h'))?.text()).toBe('#pragma once');
    expect(await dir.list('README.md')).toBeNull();
    expect(await dir.list('nothing')).toBeNull();
    expect(await dir.file('src')).toBeNull();
    expect(await dir.file('src/nothing.c')).toBeNull();
    expect(await dir.file('nothing/a.c')).toBeNull();
  });

  it('dirFromFiles takes a file without a relative path by its name', async () => {
    const dir = dirFromFiles([new File([enc('x')], 'loose.txt')]);
    expect(await dir.list('')).toEqual([{ name: 'loose.txt', kind: 'file' }]);
  });

  it('dirFromHandle passes on errors other than "not there"', async () => {
    const dir = dirFromHandle(fakeHandle(small, '', 'NotAllowedError') as Parameters<typeof dirFromHandle>[0]);
    expect((await rejection(dir.file('README.md'))).name).toBe('NotAllowedError');
  });
});
