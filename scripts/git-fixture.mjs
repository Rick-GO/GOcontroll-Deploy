// Make test/fixtures/git/fixture.json: public/js/git.js held against the git CLI.
//
//   node scripts/git-fixture.mjs
//
// Builds a throw-away repository with the git CLI in a temp dir and writes every file under
// its .git/ (base64, keyed by the path from the repository root, e.g. ".git/HEAD") together
// with what git itself says about it: HEAD, every commit (`git log --all`), every tag
// (`git for-each-ref refs/tags`), every object (`git cat-file --batch-all-objects`) and the
// `git log` of the ranges test/git.test.ts walks. Commit the result; the test then reads the
// same .git/ with public/js/git.js and expects git's answers.
//
// The repository covers, in this order:
//   1. commits on main and on a branch "feature", a --no-ff merge (two parents), an annotated
//      tag (v0.1.0) and a lightweight tag (v0.2.0); a commit message kept verbatim (leading
//      blank lines, trailing spaces) and a two-line subject paragraph; a non-ASCII author;
//   2. `git gc`: one pack with OFS_DELTA entries, all refs in packed-refs (with ^ peel lines);
//   3. two more commits and an annotated tag (v0.3.0), then `git repack -d` with
//      repack.useDeltaBaseOffset=false: a second pack with REF_DELTA entries, the tag ref loose;
//   4. two more commits, an annotated tag (v0.4.0) and a lightweight tag with a "/" in its
//      name (release/2026-01), all loose objects and loose refs.
// The script checks that each pack holds the delta kind it is there for and that loose objects
// are left, so a git that packs differently fails here and not quietly in the test.
//
// Names, e-mail addresses and dates are fixed (GIT_AUTHOR_DATE etc., several time zones), and
// no global or system git config is read, so the fixture is the same on every run (with the
// same git version). .git/index is left out: it holds work-tree timestamps.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'test', 'fixtures', 'git', 'fixture.json');

const work = mkdtempSync(join(tmpdir(), 'git-fixture-'));
const repo = join(work, 'repo');
const template = join(work, 'template'); // empty: no sample hooks, no description, no info/exclude
const globalConfig = join(work, 'gitconfig');
mkdirSync(template);
writeFileSync(globalConfig, '');

// A clean environment: nothing from the caller's repository or git config.
const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith('GIT_')) delete baseEnv[key];
Object.assign(baseEnv, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: globalConfig,
  HOME: work,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});

// 2026-01-05 09:00:00 UTC; every step is an hour later, so committer dates strictly increase.
const T0 = 1767603600;
let step = 0;
const ZONES = ['+0100', '+0200', '-0500', '+0000', '+0530', '-0230', '+0100', '+1200', '-0800', '+0200', '+0100', '+0000'];

const COMMITTER = { name: 'Build Server', email: 'build@example.com' };
const ALICE = { name: 'Alice Example', email: 'alice@example.com' };
const JORG = { name: 'Jörg Müller', email: 'joerg@example.com' };

/** Environment for one git command that creates a commit or tag at the next step. */
function at(author = ALICE, authorOffset = -600) {
  const t = T0 + step * 3600;
  const zone = ZONES[step % ZONES.length];
  const authorZone = ZONES[(step + 3) % ZONES.length];
  step++;
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: `${t + authorOffset} ${authorZone}`,
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
    GIT_COMMITTER_DATE: `${t} ${zone}`,
  };
}

/**
 * Run git in the fixture repository and return its stdout. Commands that write a reflog line
 * without making a commit (checkout, branch) get a fixed date too: half an hour after the last step.
 */
function git(args, env = {}, cwd = repo) {
  const still = {
    GIT_AUTHOR_NAME: COMMITTER.name,
    GIT_AUTHOR_EMAIL: COMMITTER.email,
    GIT_AUTHOR_DATE: `${T0 + step * 3600 - 1800} +0000`,
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
    GIT_COMMITTER_DATE: `${T0 + step * 3600 - 1800} +0000`,
  };
  return execFileSync('git', args, { cwd, env: { ...baseEnv, ...still, ...env }, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

const msgFile = join(work, 'message.txt');
function commit(message, { author, verbatim = false } = {}) {
  writeFileSync(msgFile, message);
  git(['add', '-A']);
  git(['commit', '-q', '-F', msgFile, ...(verbatim ? ['--cleanup=verbatim'] : [])], at(author));
  return git(['rev-parse', 'HEAD']).trim();
}
function annotatedTag(name, message, target = 'HEAD') {
  writeFileSync(msgFile, message);
  git(['tag', '-a', name, '-F', msgFile, target], at());
}
const write = (name, text) => writeFileSync(join(repo, name), text);

// A file large enough for git to store its versions as deltas: 300 lines, a few change each time.
function data(version) {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    const changed = (i * 7 + version * 13) % 37 === 0;
    lines.push(`channel ${String(i).padStart(3, '0')}: gain ${(i * 31) % 97}, offset ${changed ? version * 10 + i : i}, filter low-pass`);
  }
  return lines.join('\n') + '\n';
}

try {
  git(['init', '-q', `--template=${template}`, '--object-format=sha1', '--ref-format=files', '-b', 'main', repo], {}, work);
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.fsmonitor', 'false'],
  ]) git(['config', key, value]);

  const named = {};

  // 1. History with a branch and a merge.
  write('README.md', 'Module firmware\n');
  write('data.txt', data(1));
  named.c1 = commit('Initial import\n');

  write('data.txt', data(2));
  named.c2 = commit('Add the data file\n\nLonger body\nwith two lines.\n');
  annotatedTag('v0.1.0', 'Release 0.1.0\n\n- First release\n- Data file for every channel\n');

  git(['checkout', '-q', '-b', 'feature']);
  write('can.txt', 'CAN 2 enabled\n');
  write('data.txt', data(3));
  named.c3 = commit('Add CAN bus support\nfor the second channel\n\n- channel 2\n- termination\n');

  git(['checkout', '-q', 'main']);
  write('README.md', 'Module firmware for the Moduline\n');
  named.c4 = commit('Fix a typo in the README\n', { author: JORG });

  writeFileSync(msgFile, "Merge branch 'feature'\n");
  git(['merge', '-q', '--no-ff', '-F', msgFile, 'feature'], at());
  named.m5 = git(['rev-parse', 'HEAD']).trim();
  git(['tag', 'v0.2.0']); // lightweight

  write('data.txt', data(4));
  named.c6 = commit('\n\n  Tune the timing   \nof channel 4\t\n\n\n\nFirst body line\n\n  indented line  \n\n\n', { verbatim: true });

  // 2. Everything into one pack (OFS_DELTA), refs into packed-refs.
  git(['gc', '-q']);

  // 3. A second pack with REF_DELTA entries; the new tag ref stays loose.
  write('data.txt', data(5));
  named.c7 = commit('Update the calibration data\n');
  write('data.txt', data(6));
  write('version.txt', '0.3.0\n');
  named.c8 = commit('Prepare release 0.3.0\n');
  annotatedTag('v0.3.0', 'Release 0.3.0\n\nCalibration data updated.\n');
  git(['-c', 'repack.useDeltaBaseOffset=false', 'repack', '-q', '-d']);

  // 4. Loose objects and loose refs.
  write('diag.txt', 'diagnostics on\n');
  named.c9 = commit('Add diagnostics\n', { author: JORG });
  git(['tag', 'release/2026-01']); // lightweight, a "/" in the name
  write('data.txt', data(7));
  write('version.txt', '0.4.0\n');
  named.c10 = commit('Bump the version to 0.4.0\n');
  annotatedTag('v0.4.0', 'Release 0.4.0\n\n- Diagnostics\n- Calibration data\n');

  // ── Checks on the layout the test relies on ─────────────────────────────────
  const gitDir = join(repo, '.git');
  const packDir = join(gitDir, 'objects', 'pack');
  const packs = readdirSync(packDir).filter((f) => f.endsWith('.pack')).sort();
  /** Count the entry kinds of a pack from the offsets git verify-pack lists. */
  const kinds = (pack) => {
    const bytes = readFileSync(join(packDir, pack));
    const out = git(['verify-pack', '-v', join(packDir, pack.replace(/\.pack$/, '.idx'))]);
    const counts = { commit: 0, tree: 0, blob: 0, tag: 0, ofs_delta: 0, ref_delta: 0 };
    const names = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs_delta', 7: 'ref_delta' };
    for (const line of out.split('\n')) {
      const m = /^[0-9a-f]{40} \w+ +\d+ \d+ (\d+)/.exec(line);
      if (m) counts[names[(bytes[Number(m[1])] >> 4) & 7]]++;
    }
    return counts;
  };
  const packKinds = packs.map((p) => ({ pack: p, ...kinds(p) }));
  if (packKinds.length !== 2) throw new Error(`expected two packs, found ${packKinds.length}`);
  if (!packKinds.some((k) => k.ofs_delta > 0 && k.ref_delta === 0)) throw new Error('no pack with OFS_DELTA entries');
  if (!packKinds.some((k) => k.ref_delta > 0 && k.ofs_delta === 0)) throw new Error('no pack with REF_DELTA entries');
  const looseObjects = Number(/^count: (\d+)/m.exec(git(['count-objects', '-v']))[1]);
  if (!looseObjects) throw new Error('no loose objects left');
  const packedRefs = readFileSync(join(gitDir, 'packed-refs'), 'utf-8');
  if (!/^\^[0-9a-f]{40}$/m.test(packedRefs)) throw new Error('packed-refs has no peel lines');
  for (const ref of ['refs/tags/v0.3.0', 'refs/tags/v0.4.0', 'refs/tags/release/2026-01', 'refs/heads/main']) {
    statSync(join(gitDir, ...ref.split('/'))); // throws when the ref is not loose
  }

  // ── What git says ───────────────────────────────────────────────────────────
  const head = { commit: git(['rev-parse', 'HEAD']).trim(), branch: git(['symbolic-ref', '--short', 'HEAD']).trim() };

  const commits = {};
  const log = git(['log', '--all', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b%x00%x01']);
  for (const record of log.split('\x01')) {
    const fields = record.replace(/^\n/, '').split('\x00');
    if (fields.length < 9) continue;
    const [sha, parents, author, authorEmail, authorDate, committerDate, subject, body] = fields;
    commits[sha] = {
      parents: parents ? parents.split(' ') : [],
      author,
      authorEmail,
      authorDate,
      committerDate,
      subject,
      body: body.replace(/\s+$/, ''),
    };
  }

  const tags = [];
  const refs = git(['for-each-ref', 'refs/tags', '--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggerdate:iso-strict)%00%(contents)%00%01']);
  for (const record of refs.split('\x01')) {
    const fields = record.replace(/^\n/, '').split('\x00');
    if (fields.length < 7) continue;
    const [name, type, object, peeled, date, contents] = fields;
    const annotated = type === 'tag';
    tags.push({
      name,
      commit: annotated ? peeled : object,
      annotated,
      message: annotated ? contents.replace(/\s+$/, '') : null,
      date: annotated ? date : null,
    });
  }

  const objects = {};
  for (const line of git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']).split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (sha) objects[sha] = { type, size: Number(size) };
  }

  const ranges = [
    { from: 'c10' },
    { from: 'c10', max: 3 },
    { from: 'c10', exclude: 'v0.3.0' },
    { from: 'c10', exclude: 'v0.2.0' },
    { from: 'm5', exclude: 'v0.1.0' },
    { from: 'c3', exclude: 'c4' }, // two sides of the merge
    { from: 'c4', exclude: 'c3' },
    { from: 'c8', exclude: 'c1', max: 4 },
    { from: 'c10', exclude: 'c10' },
    { from: 'c1' },
  ];
  const rev = (n) => (named[n] ? named[n] : git(['rev-parse', `${n}^{commit}`]).trim());
  const logs = ranges.map((r) => {
    const from = rev(r.from);
    const exclude = r.exclude ? rev(r.exclude) : undefined;
    const args = ['log', '--format=%H', ...(r.max ? [`--max-count=${r.max}`] : []), from, ...(exclude ? [`^${exclude}`] : [])];
    return { label: `${r.exclude ? `${r.exclude}..` : ''}${r.from}${r.max ? ` (max ${r.max})` : ''}`, from, exclude, max: r.max, shas: git(args).split('\n').filter(Boolean) };
  });

  // ── Every file under .git/ ──────────────────────────────────────────────────
  // Except .git/index, the staging area: it holds the file system's timestamps of the work
  // tree, so it differs on every run, and the reader never looks at it.
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = relative(repo, full).split(sep).join('/');
      if (statSync(full).isDirectory()) walk(full);
      else if (path !== '.git/index') files[path] = readFileSync(full).toString('base64');
    }
  };
  walk(gitDir);

  const out = {
    _about: 'Generated by scripts/git-fixture.mjs with the git CLI; do not edit.',
    git_version: git(['--version']).trim(),
    coverage: { packs: packKinds, loose_objects: looseObjects },
    named,
    expected: { head, commits, tags, logs, objects },
    files,
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${relative(root, outFile)}: ${Object.keys(files).length} files, ${Object.keys(objects).length} objects, ${Object.keys(commits).length} commits, ${tags.length} tags`);
  console.log(JSON.stringify(out.coverage));
} finally {
  rmSync(work, { recursive: true, force: true });
}
