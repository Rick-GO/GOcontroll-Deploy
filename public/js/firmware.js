// @ts-check
// Firmware (#/firmware): module firmware on firmware.gocontroll.tech, which go-modules flashes into
// the plug-in modules of an L4, M1 or HMI1. The modules with their releases, and Publish firmware.
//
// This page does what the Moduline Module Firmware Deployer (agent 08) did by hand, with its rules:
//   1. Source: the module's repository folder (preferred) or loose .srec files. From a folder the
//      page finds every <...>-BOOT/<name>.srec (as the CI does) and reads .git in the browser
//      (git.js, read only). Module and version come from the file name (20-10-1-6-2-0-3.srec =
//      20100106, 2.0.3).
//   2. The file published is the one git holds at HEAD, never the work tree's copy: a Windows
//      checkout (core.autocrlf) has CRLF where git and the CI have LF, so its SHA-256 would differ.
//      A file that is not committed, or differs from the commit, cannot be published: commit it
//      first. Choosing the folder asks GitHub whether HEAD is the newest commit of its branch
//      (src/github.ts checkGitHub): GitHub ahead (pull first), HEAD not pushed, or both, is said
//      loudly; without GitHub, from origin/<branch> as of the last fetch. Loose files are converted
//      to LF.
//   3. Release date: the tag's RELEASE_DATE when tag v<version> exists (the safety net uses it),
//      otherwise the date of the .srec file. Changelog: the tag's text, otherwise typed, with the
//      commits since the previous version tag beside it.
//   4. A published firmware never changes; a version that is published already only gets its
//      manifest entry written again (Publish again), with the same bytes.
//   5. Review before writing: every file is sent as a dry run first (the Worker checks it and
//      answers what it would write); only after the colleague confirms is it published, lowest
//      version first.
//   6. Afterwards, per version: tag v<version> with exactly the annotation the CI reads (RELEASE_DATE,
//      DEPLOY_FILES, the changelog as stored), so the CI run that it starts writes the same entry,
//      and the GitHub release with the .srec attached. Deploy does both on GitHub itself (ticked in
//      the review, src/github.ts) when it has a token, the repository folder was chosen and HEAD is
//      pushed; otherwise, or when GitHub refuses, it gives the annotation and the commands.
//   7. The safety net (the repository's own publish-firmware.yml): what it would do differently.

import { api, ApiError, errorText, postForm } from './api.js';
import { fmtDateTime, plural, shortHash } from './format.js';
import { dirFromFiles, dirFromHandle, GitError, openRepo } from './git.js';
import { act, copyButton, esc, hydrateIcons, saveBlob, toast, uniqueId } from './lib.js';
import {
  annotationMatches, changelogFromTag, compareVersions, githubSlug, githubUrl, localDay, parseSrecName, previousTag, releaseDateFromTag,
  safetyNetFindings, syncState, tagAnnotation, toLf,
} from './release-helpers.js';
import { parseSrec } from './source.js';
import { badge, confirmDialog, formDialog, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {{ version: string, file: string, date: string, sha256: string, changelog: string,
 *   publishedBy: { email: string, at: string, source: Source | null } | null }} FwRelease
 * @typedef {{ id: string, name: string, hardwareVersion: string, latest: string | null, releases: FwRelease[], error?: string }} FwModule
 * @typedef {{ updated: string | null, modules: FwModule[], manifestError?: string, firmwareUrl: string, moduleTypeNames: Record<string, string>,
 *   github?: { configured: boolean, repos: string } }} FwOverview
 *   github: whether Deploy can set tags and make releases itself (DEPLOY_GITHUB_TOKEN), and in which repositories
 * @typedef {{ repo: string, branch: string | null, commit: string | null, tag: string | null, path?: string | null, pushed?: boolean | null }} Source
 * @typedef {import('./release-helpers.js').SrecName} SrecName
 * @typedef {import('./release-helpers.js').Tag} Tag
 * @typedef {{ path: string, name: SrecName | null, original: File, bytes: Uint8Array | null, sha256: string | null, fromGit: boolean,
 *   modified: number, error: string | null, status: 'new' | 'same' | 'differs' | 'bad', selected: boolean }} Candidate
 * @typedef {{ commit: string, branch: string | null }} Head
 * @typedef {{ sha: string, subject: string, authorDate: string }} Commit
 * @typedef {{ repo: string, head: Head | null, tags: Tag[], gitError: string | null,
 *   log: (opts: { from: string, exclude?: string, max?: number }) => Promise<Commit[]>,
 *   fileAt: ((commit: string, path: string) => Promise<Uint8Array | null>) | null,
 *   reaches: ((from: string, target: string) => Promise<boolean | null>) | null,
 *   pushed: boolean | null, trackingNewer: boolean | null, github: string | null, slug: string | null, findings: string[],
 *   githubCheck?: { readable: boolean, error: string | null, sync?: GitHubSync | null, syncError?: string | null } | null,
 *   sync?: Sync | null }} RepoInfo
 *   githubCheck: whether Deploy can tag and release in slug, and HEAD against its branch there (GET /api/firmware/github)
 *   pushed: HEAD is on its branch (true), is not (false), or that cannot be told (null): from origin/<branch>
 *     as of the last fetch, then from GitHub when Deploy could ask (sync)
 *   trackingNewer: origin/<branch> (as of the last fetch) has commits HEAD does not have
 *   sync: HEAD against the newest commit of its branch, said above the files
 * @typedef {import('./release-helpers.js').GitHubSync} GitHubSync
 * @typedef {import('./release-helpers.js').Sync} Sync
 * @typedef {{ released: string, changelog: string, replace: boolean, names: Record<string, string> }} GroupValues
 * @typedef {{ dryRun: boolean, hwId: string, version: string, file: string, url: string, sha256: string, date: string, changelog: string,
 *   moduleName: string, latest: string, latestBefore: string | null, objectWritten: boolean, replacedRelease: boolean,
 *   newModule: boolean, moduleManifest: string }} PublishAnswer
 */

const hex = (/** @type {ArrayBuffer} */ b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const CHANGELOG_HINT = 'One line in English: what changes for the user of the module (go-modules shows it).';

// ── The page ─────────────────────────────────────────────────────────────────

/** @param {Ctx} ctx */
export async function renderFirmware(ctx) {
  const nav = ctx.nav;
  setHero({
    title: 'Module firmware',
    lede: 'Firmware for the plug-in modules of the Moduline L4, M1 and HMI1 on firmware.gocontroll.tech. go-modules on a controller flashes the newest version of each module.',
  });
  /** @type {FwOverview} */
  const data = await api('GET', '/firmware');
  if (stale(ctx, nav)) return;
  ctx.view.innerHTML = `
    ${data.manifestError ? `<section class="panel"><div class="notice err">${esc(data.manifestError)}</div></section>` : ''}
    ${kpis(data)}
    <section class="panel" id="fw-publish">
      <div class="panel-head"><h2>Publish firmware</h2></div>
      <p class="text">Choose the module's source folder (its repository, e.g. Module-Input). Deploy finds the .srec files in its -BOOT folders and publishes them as git holds them at HEAD, so commit and push the firmware first. Loose .srec files work too, without those checks. Nothing in the folder is changed.</p>
      <div class="btn-row">
        <button type="button" class="btn primary" data-pick-folder data-icon="document">Choose the source folder…</button>
        <label class="btn" data-icon="arrow-up-tray"><span>Choose .srec files…</span><input type="file" class="sr-only" accept=".srec" multiple data-pick-files></label>
        <input type="file" class="sr-only" webkitdirectory data-pick-dir-fallback aria-hidden="true" tabindex="-1">
      </div>
      <div class="drop fw-drop" data-drop>
        <span class="drop-icon" data-icon="arrow-up-tray"></span>
        <span class="drop-text"><strong>Or drop the folder or .srec files here</strong></span>
        <span class="drop-hint">File names like 20-10-1-6-2-0-3.srec: hardware 20100106, firmware 2.0.3.</span>
      </div>
      <div data-candidates></div>
    </section>
    <section class="panel" id="fw-modules">${modulesPanel(data)}</section>`;
  hydrateIcons(ctx.view);
  wirePublish(ctx, data);
}

/** @param {FwOverview} d */
const modulesPanel = (d) => `<div class="panel-head"><h2>Modules</h2><span class="sub">${esc(d.firmwareUrl.replace(/^https:\/\//, ''))}/modules/manifest.json</span></div>
  ${moduleList(d)}`;

/** @param {FwOverview} d */
function kpis(d) {
  const releases = d.modules.reduce((n, m) => n + m.releases.length, 0);
  const fromDeploy = d.modules.reduce((n, m) => n + m.releases.filter((r) => r.publishedBy).length, 0);
  /** @param {string} label @param {string} value @param {string} sub */
  const tile = (label, value, sub) => `<div class="kpi"><span class="kpi-label">${esc(label)}</span><span class="kpi-value num">${esc(value)}</span><span class="kpi-sub">${esc(sub)}</span></div>`;
  return `<section class="kpis" aria-label="Totals">
    ${tile('Modules', String(d.modules.length), 'hardware versions with firmware')}
    ${tile('Releases', String(releases), `${fromDeploy} published from Deploy`)}
    ${tile('Last update', d.updated ?? '—', 'of modules/manifest.json')}
  </section>`;
}

/** Every module with its releases, newest first. @param {FwOverview} d */
function moduleList(d) {
  if (!d.modules.length) return '<p class="muted">No module firmware is published yet.</p>';
  const sorted = [...d.modules].sort((a, b) => a.id.localeCompare(b.id));
  return `<div class="fw-modules">${sorted.map((m) => `<details class="fw-module">
    <summary>
      <span class="fw-title"><strong>${esc(m.name || m.id)}</strong> <span class="muted">HW ${esc(m.hardwareVersion)}</span></span>
      <span class="fw-meta mono">${esc(m.id)}</span>
      <span class="fw-meta">${m.latest ? badge(m.latest, 'brand', 'Latest firmware') : badge('none', 'warn')}</span>
      <span class="fw-meta muted">${esc(m.releases[0]?.date ?? '')} · ${plural(m.releases.length, 'release')}</span>
    </summary>
    ${m.error ? `<div class="notice err">${esc(m.error)}</div>` : ''}
    ${m.releases.length ? `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>Version</th><th>Date</th><th>Changelog</th><th>SHA-256</th><th>Published</th></tr></thead>
      <tbody>${m.releases.map((r, i) => {
        const id = uniqueId('sha');
        return `<tr>
        <td data-label="Version" class="mono"><a href="${esc(`${d.firmwareUrl}/${r.file}`)}" rel="noopener">${esc(r.version)}</a>${i === 0 ? ` ${badge('flashed', 'ok', 'go-modules flashes the first release')}` : ''}</td>
        <td data-label="Date" class="mono">${esc(r.date)}</td>
        <td data-label="Changelog" class="desc pre">${esc(r.changelog)}</td>
        <td data-label="SHA-256" class="mono"><span id="${id}" hidden>${esc(r.sha256)}</span>${esc(shortHash(r.sha256))} ${copyButton(id, 'SHA-256')}</td>
        <td data-label="Published">${r.publishedBy ? `${esc(r.publishedBy.email)}<div class="cell-sub">${esc(fmtDateTime(r.publishedBy.at))}${
          r.publishedBy.source ? ` · ${esc(r.publishedBy.source.repo)}${r.publishedBy.source.commit ? ` @ ${esc(r.publishedBy.source.commit.slice(0, 7))}` : ''}` : ''}</div>`
          : '<span class="muted">CI of the module repository</span>'}</td>
      </tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">No releases in its manifest.</p>'}
  </details>`).join('')}</div>`;
}

// ── Choosing the source ──────────────────────────────────────────────────────

/** @param {Ctx} ctx @param {FwOverview} data */
function wirePublish(ctx, data) {
  const root = /** @type {HTMLElement} */ (ctx.view.querySelector('#fw-publish'));
  const out = /** @type {HTMLElement} */ (root.querySelector('[data-candidates]'));
  const fallback = /** @type {HTMLInputElement} */ (root.querySelector('[data-pick-dir-fallback]'));
  const files = /** @type {HTMLInputElement} */ (root.querySelector('[data-pick-files]'));
  const drop = /** @type {HTMLElement} */ (root.querySelector('[data-drop]'));

  /** @param {() => Promise<{ repo: RepoInfo | null, files: { path: string, file: File }[] }>} load */
  const show = async (load) => {
    out.innerHTML = '<div class="loading"><span class="spinner dark"></span> Reading…</div>';
    try {
      const { repo, files: found } = await load();
      await drawCandidates(ctx, out, data, repo, found);
    } catch (err) {
      out.innerHTML = `<div class="notice err">${esc(errorText(err))}</div>`;
    }
  };

  root.querySelector('[data-pick-folder]')?.addEventListener('click', async () => {
    const picker = /** @type {any} */ (window).showDirectoryPicker;
    if (typeof picker !== 'function') { fallback.click(); return; }
    let handle;
    try {
      handle = await picker({ id: 'module-firmware', mode: 'read' });
    } catch (err) {
      if (/** @type {Error} */ (err).name !== 'AbortError') toast(errorText(err), 'err');
      return;
    }
    show(() => fromDir(handle.name, dirFromHandle(handle)));
  });
  fallback.addEventListener('change', () => {
    const list = [...(fallback.files ?? [])];
    fallback.value = '';
    if (!list.length) return;
    const name = /** @type {any} */ (list[0]).webkitRelativePath?.split('/')[0] ?? 'folder';
    show(() => fromDir(name, dirFromFiles(list)));
  });
  files.addEventListener('change', () => {
    const list = [...(files.files ?? [])];
    files.value = '';
    if (list.length) show(async () => ({ repo: null, files: list.map((f) => ({ path: f.name, file: f })) }));
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const items = [...(e.dataTransfer?.items ?? [])];
    // A folder: its handle where the browser gives one (Chrome, Edge).
    for (const item of items) {
      const getHandle = /** @type {any} */ (item).getAsFileSystemHandle;
      if (typeof getHandle !== 'function') continue;
      const handle = await getHandle.call(item);
      if (handle?.kind === 'directory') { show(() => fromDir(handle.name, dirFromHandle(handle))); return; }
    }
    const list = [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith('.srec'));
    if (!list.length) { toast('Drop the source folder or .srec files.', 'err'); return; }
    show(async () => ({ repo: null, files: list.map((f) => ({ path: f.name, file: f })) }));
  });
}

/** The text of a file in the chosen folder, or null. @param {import('./git.js').DirReader} dir @param {string} path */
async function textOf(dir, path) {
  const blob = await dir.file(path).catch(() => null);
  return blob ? blob.text() : null;
}

/**
 * The .srec files in the folder's <...>-BOOT folders (as the CI: *-BOOT/*.srec), its git state and
 * its safety net.
 * @param {string} name @param {import('./git.js').DirReader} dir
 * @returns {Promise<{ repo: RepoInfo, files: { path: string, file: File }[] }>}
 */
async function fromDir(name, dir) {
  const top = await dir.list('');
  if (!top) throw new Error('The folder cannot be read.');
  /** @type {{ path: string, file: File }[]} */
  const found = [];
  for (const boot of top.filter((e) => e.kind === 'directory' && e.name.endsWith('-BOOT'))) {
    for (const f of (await dir.list(boot.name)) ?? []) {
      if (f.kind !== 'file' || !f.name.toLowerCase().endsWith('.srec')) continue;
      const blob = await dir.file(`${boot.name}/${f.name}`);
      if (blob) found.push({ path: `${boot.name}/${f.name}`, file: blob instanceof File ? blob : new File([blob], f.name) });
    }
  }
  if (!found.length) throw new Error(`${name} has no .srec files in a -BOOT folder. Choose the module's repository, or the .srec files themselves.`);
  /** @type {RepoInfo} */
  const repo = {
    repo: name, head: null, tags: [], gitError: null, log: async () => [], fileAt: null, reaches: null,
    pushed: null, trackingNewer: null, github: null, slug: null, findings: [],
  };
  try {
    const r = await openRepo(dir);
    if (!r) {
      repo.gitError = 'This folder is not a git repository: Deploy cannot check that the files are committed, and suggests no changelog.';
    } else {
      repo.head = r.head;
      repo.tags = await r.tags();
      repo.log = (opts) => r.log(opts);
      repo.fileAt = (commit, path) => r.fileAt(commit, path);
      repo.reaches = (from, target) => r.reaches(from, target);
      const remoteUrl = await r.remoteUrl();
      repo.github = githubUrl(remoteUrl);
      repo.slug = githubSlug(remoteUrl);
      if (r.head.branch) {
        const remote = await r.remoteBranch(r.head.branch).catch(() => null);
        repo.pushed = remote ? await r.reaches(remote, r.head.commit) : null;
        const reached = remote ? await r.reaches(r.head.commit, remote).catch(() => null) : null;
        repo.trackingNewer = reached === null ? null : !reached;
      }
    }
  } catch (err) {
    repo.gitError = err instanceof GitError ? err.message : `The git history could not be read: ${errorText(err)}`;
  }
  // The safety net, read from the work tree (what a tag push would run).
  const workflow = await textOf(dir, '.github/workflows/publish-firmware.yml');
  const scriptPath = workflow ? /run:\s*python3?\s+(\S+\.py)/.exec(workflow)?.[1] ?? null : null;
  const script = scriptPath ? await textOf(dir, scriptPath) : null;
  /** @type {any} */ (repo).safetyNet = { workflow, script, scriptPath };
  return { repo, files: found };
}

/**
 * Read, check and compare every file with what firmware.gocontroll.tech has. From a repository the
 * bytes are those of HEAD; the work tree's copy only has to agree with them.
 * @param {FwOverview} data @param {{ path: string, file: File }[]} found @param {RepoInfo | null} repo
 * @returns {Promise<Candidate[]>}
 */
async function readCandidates(data, found, repo) {
  const byId = new Map(data.modules.map((m) => [m.id, m]));
  return Promise.all(found.map(async ({ path, file }) => {
    const name = parseSrecName(file.name);
    /** @type {Candidate} */
    const c = { path, name, original: file, bytes: null, sha256: null, fromGit: false, modified: file.lastModified, error: null, status: 'bad', selected: false };
    if (!name) { c.error = 'The name does not follow the convention (e.g. 20-10-1-6-2-0-3.srec).'; return c; }
    try {
      const work = toLf(await file.text());
      if (repo?.head && repo.fileAt) {
        const committed = await repo.fileAt(repo.head.commit, path);
        if (!committed) throw new Error('Not committed. Commit and push it first: Deploy publishes the file as git holds it at HEAD.');
        if (new TextDecoder().decode(committed) !== work) throw new Error('Differs from the committed file. Commit it first: Deploy publishes what git holds at HEAD.');
        c.bytes = committed;
        c.fromGit = true;
      } else {
        c.bytes = new TextEncoder().encode(work);
      }
      parseSrec(new TextDecoder().decode(c.bytes));
      c.sha256 = hex(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (c.bytes)));
    } catch (err) {
      c.error = errorText(err);
      return c;
    }
    const published = byId.get(name.hwId)?.releases.find((r) => r.version === name.version);
    c.status = !published ? 'new' : published.sha256 === c.sha256 ? 'same' : 'differs';
    if (c.status === 'differs') c.error = 'firmware.gocontroll.tech has other bytes for this version. A published firmware never changes: give the correction a new version number.';
    c.selected = c.status === 'new';
    return c;
  }));
}

// ── The files found, grouped per version ─────────────────────────────────────

/**
 * @param {Ctx} ctx @param {HTMLElement} out @param {FwOverview} data
 * @param {RepoInfo | null} repo @param {{ path: string, file: File }[]} found
 */
async function drawCandidates(ctx, out, data, repo, found) {
  const candidates = (await readCandidates(data, found, repo)).sort((a, b) =>
    (a.name && b.name ? compareVersions(b.name.version, a.name.version) || a.name.hwId.localeCompare(b.name.hwId) : a.name ? -1 : 1));
  const versions = [...new Set(candidates.filter((c) => c.name).map((c) => /** @type {SrecName} */ (c.name).version))];
  const suggestions = new Map(await Promise.all(versions.map(async (v) => /** @type {const} */ ([v, await suggest(repo, v)]))));
  const statusBadge = (/** @type {Candidate} */ c) => ({
    new: badge('New', 'info'),
    same: badge('Published', 'ok', 'This version is on firmware.gocontroll.tech with these exact bytes'),
    differs: badge('Published, other bytes', 'err', 'This version is on firmware.gocontroll.tech, but the file differs'),
    bad: badge('Cannot be used', 'err'),
  })[c.status];
  if (repo?.slug && data.github?.configured) {
    // Every time a folder is chosen: can Deploy tag there, and is HEAD the newest commit on GitHub?
    const q = new URLSearchParams({ repo: repo.slug });
    if (repo.head) q.set('commit', repo.head.commit);
    if (repo.head?.branch) q.set('branch', repo.head.branch);
    repo.githubCheck = await api('GET', `/firmware/github?${q}`)
      .catch((err) => ({ readable: false, error: errorText(err), syncError: errorText(err) }));
  }
  if (repo?.head) {
    const github = repo.githubCheck?.sync ?? null;
    const headReachesGithub = github?.state === 'not-on-github' && github.head && repo.reaches
      ? await repo.reaches(repo.head.commit, github.head.sha).catch(() => null) : null;
    repo.sync = syncState({
      github, headReachesGithub, branch: repo.head.branch, pushed: repo.pushed, trackingNewer: repo.trackingNewer,
      reason: !data.github?.configured ? 'GitHub is not set up (DEPLOY_GITHUB_TOKEN)'
        : !repo.slug ? 'origin is not a GitHub repository'
        : repo.githubCheck?.syncError ?? null,
    });
    repo.pushed = repo.sync.pushed;
  }
  const safety = /** @type {any} */ (repo)?.safetyNet;
  if (repo && safety) {
    repo.findings = safetyNetFindings({ ...safety, names: candidates.filter((c) => c.name).map((c) => moduleName(data, /** @type {SrecName} */ (c.name).hwId)) });
  }

  out.innerHTML = `
    ${repo ? `<div class="notice${repo.gitError ? ' warn' : ''}">${repoLine(repo)}</div>` : '<div class="notice warn">Files chosen without their repository: Deploy cannot check that they are the committed files (it converts CRLF to LF), and you write the changelog yourself.</div>'}
    ${repo?.sync ? syncNotice(repo.sync, /** @type {Head} */ (repo.head)) : ''}
    ${repo?.findings.length ? `<div class="notice warn"><strong>The safety net</strong> (this repository's publish-firmware.yml, which pushing the tag starts):
      <ul class="plain-list">${repo.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div class="section-label">Files found</div>
    <div class="table-wrap"><table class="data cards fw-files">
      <thead><tr><th><span class="sr-only">Publish</span></th><th>File</th><th>Module</th><th>Version</th><th>File date</th><th>Status</th></tr></thead>
      <tbody>${candidates.map((c, i) => {
        const usable = c.status === 'new' || c.status === 'same';
        return `<tr${usable ? '' : ' class="inactive"'}>
        <td data-label="Publish"><input type="checkbox" data-pick="${i}"${c.selected ? ' checked' : ''}${usable ? '' : ' disabled'} aria-label="Publish ${esc(c.original.name)}"></td>
        <td data-label="File" class="mono">${esc(c.path)}${c.error ? `<div class="cell-sub error">${esc(c.error)}</div>` : ''}${
          c.fromGit ? '<div class="cell-sub">as committed at HEAD</div>' : ''}</td>
        <td data-label="Module">${c.name ? `${esc(moduleName(data, c.name.hwId) || '—')}<div class="cell-sub mono">${esc(c.name.hwId)} · HW ${esc(c.name.hardwareVersion)}</div>` : '—'}</td>
        <td data-label="Version" class="mono">${esc(c.name?.version ?? '—')}</td>
        <td data-label="File date">${esc(fmtDateTime(new Date(c.modified).toISOString()))}</td>
        <td data-label="Status">${statusBadge(c)}</td>
      </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div data-groups></div>
    <div class="btn-row"><button type="button" class="btn primary" data-publish data-icon="cloud-arrow-up">Review…</button></div>
    <div data-results></div>`;
  hydrateIcons(out);

  const groupsEl = /** @type {HTMLElement} */ (out.querySelector('[data-groups]'));
  const publishBtn = /** @type {HTMLButtonElement} */ (out.querySelector('[data-publish]'));
  /** @type {Map<string, GroupValues>} */
  const values = new Map();

  const drawGroups = () => {
    // Keep what was typed when the selection changes.
    groupsEl.querySelectorAll('[data-group]').forEach((g) => {
      const v = /** @type {HTMLElement} */ (g).dataset.group ?? '';
      const val = values.get(v);
      if (!val) return;
      val.released = /** @type {HTMLInputElement} */ (g.querySelector('[name=released]')).value;
      val.changelog = /** @type {HTMLTextAreaElement} */ (g.querySelector('[name=changelog]')).value;
      val.replace = Boolean(/** @type {HTMLInputElement | null} */ (g.querySelector('[name=replace]'))?.checked);
      g.querySelectorAll('[data-name-for]').forEach((n) => { val.names[/** @type {HTMLElement} */ (n).dataset.nameFor ?? ''] = /** @type {HTMLInputElement} */ (n).value; });
    });
    const chosen = candidates.filter((c) => c.selected && c.name);
    /** @type {Map<string, Candidate[]>} */
    const byVersion = new Map();
    for (const c of chosen) byVersion.set(/** @type {SrecName} */ (c.name).version, [...(byVersion.get(/** @type {SrecName} */ (c.name).version) ?? []), c]);
    groupsEl.innerHTML = [...byVersion.entries()].map(([version, list]) => {
      const s = suggestions.get(version);
      if (!values.has(version)) {
        values.set(version, { released: s?.released ?? localDay(Math.max(...list.map((c) => c.modified))), changelog: s?.text ?? '', replace: false, names: {} });
      }
      const val = /** @type {GroupValues} */ (values.get(version));
      const unnamed = list.filter((c) => !moduleName(data, /** @type {SrecName} */ (c.name).hwId));
      const again = list.some((c) => c.status === 'same');
      const idDate = uniqueId('fw-date');
      const idLog = uniqueId('fw-log');
      return `<div class="fw-group" data-group="${esc(version)}">
        <h3>Version ${esc(version)} <span class="muted">· ${plural(list.length, 'file')}: ${list.map((c) => esc(/** @type {SrecName} */ (c.name).hwId)).join(', ')}</span></h3>
        <div class="form-grid two">
          <div class="field"><label for="${idDate}">Release date</label><input type="date" id="${idDate}" name="released" value="${esc(val.released)}" required>
            <div class="hint">${esc(s?.released ? `From tag ${s.tag}, which the safety net uses too.` : 'The date of the .srec file.')} In the manifest as DD/MM/YY.</div></div>
          ${unnamed.map((c) => {
            const n = /** @type {SrecName} */ (c.name);
            const id = uniqueId('fw-name');
            return `<div class="field"><label for="${id}">Name of module ${esc(n.hwId)}</label>
              <input id="${id}" data-name-for="${esc(n.hwId)}" value="${esc(val.names[n.hwId] ?? '')}" maxlength="80" placeholder="e.g. 6 Channel Input module" required>
              <div class="hint">New on firmware.gocontroll.tech: go-modules shows this name.</div></div>`;
          }).join('')}
          <div class="field span-2"><label for="${idLog}">Changelog</label>
            <textarea id="${idLog}" name="changelog" rows="3" maxlength="2000" required placeholder="e.g. Improvement on supply rail precharge mechanism">${esc(val.changelog)}</textarea>
            <div class="hint">${esc(s?.hint ?? CHANGELOG_HINT)}</div></div>
        </div>
        ${s?.commits.length ? `<details class="fw-commits"${s.text ? '' : ' open'}><summary>${esc(s.commitsLabel)}</summary>
          <ul class="plain-list mono">${s.commits.map((c) => `<li><span class="muted">${esc(c.sha.slice(0, 7))}</span> ${esc(c.subject)}</li>`).join('')}</ul>
          <button type="button" class="btn sm" data-use-commits="${esc(version)}">Use the commit subjects</button></details>` : ''}
        ${again ? `<label class="check"><input type="checkbox" name="replace"${val.replace ? ' checked' : ''}> Publish again: write the manifest entry of this version again (the same file), e.g. with a corrected changelog or date</label>` : ''}
      </div>`;
    }).join('');
    groupsEl.querySelectorAll('[data-use-commits]').forEach((b) => b.addEventListener('click', () => {
      const v = /** @type {HTMLElement} */ (b).dataset.useCommits ?? '';
      const s = suggestions.get(v);
      const area = /** @type {HTMLTextAreaElement | null} */ (b.closest('[data-group]')?.querySelector('[name=changelog]') ?? null);
      if (s && area) area.value = s.commits.map((c) => c.subject).join('\n');
    }));
    publishBtn.disabled = !chosen.length;
    publishBtn.textContent = chosen.length ? `Review ${plural(chosen.length, 'file')}…` : 'Review…';
  };

  out.querySelectorAll('[data-pick]').forEach((box) => box.addEventListener('change', () => {
    const c = candidates[Number(/** @type {HTMLElement} */ (box).dataset.pick)];
    c.selected = /** @type {HTMLInputElement} */ (box).checked;
    drawGroups();
  }));
  drawGroups();

  publishBtn.addEventListener('click', () => act(publishBtn, async () => {
    drawGroups(); // reads the fields into `values`
    // Lowest version first (the order the agent pushed tags in), then hardware ID.
    const chosen = candidates.filter((c) => c.selected && c.name && c.bytes).sort((a, b) =>
      compareVersions(/** @type {SrecName} */ (a.name).version, /** @type {SrecName} */ (b.name).version) || a.path.localeCompare(b.path));
    for (const c of chosen) {
      const v = values.get(/** @type {SrecName} */ (c.name).version);
      if (!v?.released || !v.changelog.trim()) throw new Error(`Fill in the release date and the changelog of version ${c.name?.version}.`);
      if (c.status === 'same' && !v.replace) throw new Error(`Version ${c.name?.version} is published already: tick "Publish again", or leave ${c.original.name} out.`);
      if (!moduleName(data, /** @type {SrecName} */ (c.name).hwId) && !v.names[/** @type {SrecName} */ (c.name).hwId]?.trim()) {
        throw new Error(`Fill in the name of module ${c.name?.hwId}.`);
      }
    }
    // Done: choosing again starts over, so nothing is sent twice by accident.
    if (await reviewAndPublish(ctx, out, data, chosen, values, repo)) publishBtn.hidden = true;
  }));
}

/**
 * What to suggest for a version: the tag's release date and changelog when tag v<version> exists,
 * and the commits since the previous version tag. @param {RepoInfo | null} repo @param {string} version
 * @returns {Promise<{ text: string, released: string | null, hint: string, commits: Commit[], commitsLabel: string, tag: string | null }>}
 */
async function suggest(repo, version) {
  const none = { text: '', released: null, hint: CHANGELOG_HINT, commits: [], commitsLabel: '', tag: null };
  if (!repo?.head) return none;
  const own = repo.tags.find((t) => t.name === `v${version}`);
  const prev = previousTag(repo.tags, version);
  /** @type {Commit[]} */
  let commits = [];
  try {
    commits = await repo.log({ from: own?.commit ?? repo.head.commit, exclude: prev?.commit, max: 50 });
  } catch (err) {
    return { ...none, hint: `${CHANGELOG_HINT} The git history could not be read: ${errorText(err)}` };
  }
  const commitsLabel = prev ? `${plural(commits.length, 'commit')} since ${prev.name}` : `The last ${plural(commits.length, 'commit')} (no earlier version tag)`;
  const text = own?.message ? changelogFromTag(own.message) : '';
  return {
    text,
    released: own?.message ? releaseDateFromTag(own.message) : null,
    hint: text ? `From the annotation of tag ${own?.name}.` : CHANGELOG_HINT,
    commits,
    commitsLabel,
    tag: own?.name ?? null,
  };
}

/** @param {RepoInfo} repo */
function repoLine(repo) {
  if (repo.gitError) return `<strong>${esc(repo.repo)}</strong>: ${esc(repo.gitError)}`;
  const head = /** @type {Head} */ (repo.head);
  const versionTags = repo.tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.name)).length;
  const github = !repo.githubCheck ? ''
    : repo.githubCheck.readable ? ` · GitHub: Deploy can tag and release in ${esc(repo.slug ?? '')}`
    : ` · <strong>GitHub</strong>: ${esc(repo.githubCheck.error ?? 'not reachable')}`;
  return `<strong>${esc(repo.repo)}</strong> · ${head.branch ? `branch <span class="mono">${esc(head.branch)}</span>` : 'detached HEAD'} at <span class="mono">${esc(head.commit.slice(0, 7))}</span> · ${plural(versionTags, 'version tag')}${github}`;
}

/**
 * Whether HEAD is the newest commit of its branch: from GitHub, else from origin/<branch> as of the
 * last fetch. Anything but up to date is a warning: publish from an old HEAD and the files, the
 * suggested changelog and the tag all follow that old commit.
 * @param {Sync} s @param {Head} head
 */
function syncNotice(s, head) {
  const branch = esc(s.branch ?? '');
  const where = s.source === 'github' ? `<span class="mono">${branch}</span> on GitHub` : `<span class="mono">origin/${branch}</span>`;
  const asOf = s.source === 'fetch' ? ` (as of the last fetch: Deploy could not ask GitHub${s.reason ? `, ${esc(s.reason)}` : ''})` : '';
  const commits = (/** @type {number | null} */ n) => (n === null ? 'commits' : plural(n, 'commit'));
  const newest = s.head ? ` The newest is <span class="mono">${esc(s.head.sha.slice(0, 7))}</span> “${esc(s.head.subject)}”${s.head.date ? `, ${esc(fmtDateTime(s.head.date))}` : ''}.` : '';
  const again = 'and choose the folder again: Deploy publishes the files as this clone holds them at HEAD, suggests the changelog from its history and tags that commit.';
  const warn = (/** @type {string} */ html) => `<div class="notice warn">${html}</div>`;
  switch (s.state) {
    case 'up-to-date':
      return s.source === 'github'
        ? `<div class="notice ok">HEAD <span class="mono">${esc(head.commit.slice(0, 7))}</span> is the newest commit of ${where}.</div>`
        : `<div class="notice">HEAD is the newest commit of ${where}${asOf}. Run <span class="mono">git pull</span> first to be sure.</div>`;
    case 'github-newer':
      return warn(`<strong>${where} has newer commits than HEAD</strong>${asOf}: ${commits(s.githubNewer)} after HEAD.${newest} Pull them first (<span class="mono">git pull</span>) ${again}`);
    case 'local-newer':
      return warn(`<strong>HEAD is not on ${where} yet</strong>${asOf}${s.localNewer ? `: ${plural(s.localNewer, 'commit')} of this clone ${s.localNewer === 1 ? 'is' : 'are'} not there` : ''}. Push before you publish, so the tag points to a commit everyone has.`);
    case 'diverged':
      return warn(`<strong>This clone and ${where} have both moved on</strong>${asOf}: ${where} has ${commits(s.githubNewer)} that HEAD does not have${s.localNewer ? `, and HEAD has ${plural(s.localNewer, 'commit')} that ${s.localNewer === 1 ? 'is' : 'are'} not there` : ', and HEAD has commits that are not there'}.${newest} Pull (merge or rebase) and push first, ${again}`);
    case 'no-branch':
      return warn(`<strong>Branch <span class="mono">${branch}</span> is not on GitHub</strong>: push it before you publish, so the tag points to a commit everyone has.`);
    default:
      return warn(s.source === 'github' ? `<strong>${esc(s.reason ?? 'HEAD could not be compared with GitHub')}</strong>: push and pull first, then choose the folder again.`
        : !s.branch ? `<strong>Detached HEAD</strong>, and Deploy could not ask GitHub${s.reason ? ` (${esc(s.reason)})` : ''}: check yourself that this commit is pushed and that nothing newer is on GitHub.`
        : `<strong>There is no <span class="mono">origin/${branch}</span> in this clone</strong>, and Deploy could not ask GitHub${s.reason ? ` (${esc(s.reason)})` : ''}: check yourself that HEAD is pushed and up to date.`);
  }
}

/** The module's name on firmware.gocontroll.tech, or that of its type. @param {FwOverview} d @param {string} hwId */
function moduleName(d, hwId) {
  return d.modules.find((m) => m.id === hwId)?.name
    || d.modules.find((m) => m.id.startsWith(hwId.slice(0, 6)) && m.name)?.name
    || d.moduleTypeNames[hwId.slice(0, 6)]
    || '';
}

// ── Review, publish, tag and release ─────────────────────────────────────────

/**
 * The form of one file. @param {Candidate} c @param {GroupValues} v @param {RepoInfo | null} repo @param {boolean} dryRun
 */
function publishForm(c, v, repo, dryRun) {
  const name = /** @type {SrecName} */ (c.name);
  const form = new FormData();
  form.append('file', new File([/** @type {Uint8Array<ArrayBuffer>} */ (c.bytes)], c.original.name, { type: 'application/octet-stream' }));
  form.append('released', v.released);
  form.append('changelog', v.changelog);
  if (v.names[name.hwId]?.trim()) form.append('module_name', v.names[name.hwId].trim());
  if (v.replace) form.append('replace', 'true');
  if (dryRun) form.append('dry_run', 'true');
  if (repo?.head) {
    const tag = repo.tags.find((t) => t.name === `v${name.version}`);
    form.append('source', JSON.stringify({ repo: repo.repo, branch: repo.head.branch, commit: repo.head.commit, tag: tag?.name ?? null, path: c.path, pushed: repo.pushed }));
  }
  return form;
}

/**
 * Why Deploy cannot tag and release this version on GitHub itself, or null when it can.
 * @param {FwOverview} data @param {RepoInfo | null} repo @param {PublishAnswer[]} plans  the dry runs of this version
 */
function cannotRelease(data, repo, plans) {
  if (!data.github?.configured) return 'GitHub is not set up yet (the token DEPLOY_GITHUB_TOKEN); the commands follow after publishing.';
  if (!repo?.head || !repo.slug) return 'Deploy knows the GitHub repository and commit only when you choose the repository folder.';
  if (repo.githubCheck && !repo.githubCheck.readable) return `${repo.githubCheck.error ?? 'GitHub cannot be reached.'} The commands follow after publishing.`;
  if (repo.pushed !== true) {
    return repo.sync?.source === 'github' ? `HEAD is not on ${repo.sync.branch} on GitHub: push it first, then publish again or use the commands.`
      : `HEAD is not on origin${repo.head.branch ? `/${repo.head.branch}` : ''} (as far as this clone knows): push it first, then publish again or use the commands.`;
  }
  const older = plans.filter((p) => JSON.parse(p.moduleManifest).releases?.[0]?.sw_version !== p.version);
  if (older.length && /** @type {any} */ (repo).safetyNet?.workflow) {
    return `${older[0].version} is not the highest version of ${older.map((p) => p.hwId).join(', ')}: pushing its tag starts this repository's publish workflow, which would put it first, so controllers would flash the older firmware.`;
  }
  return null;
}

/**
 * Dry run of every file, the review, then the publish (one request per file, lowest version
 * first: they may share manifests), then per version the tag and the GitHub release.
 * @param {Ctx} ctx @param {HTMLElement} out @param {FwOverview} data @param {Candidate[]} chosen @param {Map<string, GroupValues>} values @param {RepoInfo | null} repo
 * @returns {Promise<boolean>} true when every file was published
 */
async function reviewAndPublish(ctx, out, data, chosen, values, repo) {
  const results = /** @type {HTMLElement} */ (out.querySelector('[data-results]'));
  results.innerHTML = '';
  const valuesOf = (/** @type {Candidate} */ c) => /** @type {GroupValues} */ (values.get(/** @type {SrecName} */ (c.name).version));

  /** @type {PublishAnswer[]} */
  const plans = [];
  for (const c of chosen) {
    try {
      plans.push(await postForm('/firmware', publishForm(c, valuesOf(c), repo, true)));
    } catch (err) {
      throw new Error(`${c.original.name}: ${errorText(err)}`);
    }
  }
  /** @type {Map<string, PublishAnswer[]>} */
  const byVersion = new Map();
  for (const p of plans) byVersion.set(p.version, [...(byVersion.get(p.version) ?? []), p]);
  /** @type {Set<string>} versions to tag and release on GitHub */
  const release = new Set();
  const confirmed = await formDialog({
    title: 'Publish to firmware.gocontroll.tech?',
    submitLabel: `Publish ${plural(plans.length, 'file')}`,
    body: reviewBody(byVersion, data, repo),
    submit: async (form) => {
      for (const version of byVersion.keys()) {
        if (/** @type {HTMLInputElement | null} */ (form.querySelector(`[name="gh-${CSS.escape(version)}"]`))?.checked) release.add(version);
      }
    },
  });
  if (!confirmed) return false;

  results.innerHTML = `<div class="section-label">Published</div><ul class="plain-list fw-results">${chosen.map((c, i) =>
    `<li data-result="${i}"><span class="mono">${esc(c.original.name)}</span> <span class="muted" data-state>waiting</span></li>`).join('')}</ul><div data-tags></div>`;
  /** @type {{ answer: PublishAnswer, candidate: Candidate }[]} */
  const done = [];
  let failed = 0;
  for (const [i, c] of chosen.entries()) {
    const li = /** @type {HTMLElement} */ (results.querySelector(`[data-result="${i}"] [data-state]`));
    li.textContent = 'publishing…';
    try {
      /** @type {PublishAnswer} */
      const r = await postForm('/firmware', publishForm(c, valuesOf(c), repo, false));
      done.push({ answer: r, candidate: c });
      li.innerHTML = `${badge(r.objectWritten ? 'Published' : 'Manifest entry written again', 'ok')} <a href="${esc(r.url)}" rel="noopener">${esc(r.file)}</a> · latest of ${esc(r.hwId)}: ${esc(r.latest)}`;
    } catch (err) {
      failed++;
      li.innerHTML = `${badge('Failed', 'err')} ${esc(errorText(err))}`;
    }
  }

  // Per version: the tag and the release on GitHub, or the commands to do it by hand.
  const tags = /** @type {HTMLElement} */ (results.querySelector('[data-tags]'));
  /** @type {Map<string, { answer: PublishAnswer, candidate: Candidate }[]>} */
  const doneByVersion = new Map();
  for (const d of done) doneByVersion.set(d.answer.version, [...(doneByVersion.get(d.answer.version) ?? []), d]);
  tags.innerHTML = [...doneByVersion.keys()].map((v) => `<div class="fw-group" data-tag-version="${esc(v)}"></div>`).join('');
  for (const [version, list] of doneByVersion) {
    const box = /** @type {HTMLElement} */ (tags.querySelector(`[data-tag-version="${CSS.escape(version)}"]`));
    if (release.has(version) && repo?.slug && repo.head) await githubRelease(box, version, list, repo);
    else drawManualTag(box, version, list.map((d) => d.answer), repo);
  }

  if (failed) {
    toast(`${plural(failed, 'file')} not published.`, 'err');
    return false;
  }
  toast(`${plural(chosen.length, 'file')} published.`);
  // Draw the modules again; the results and the tags stay above them.
  const nav = ctx.nav;
  const fresh = /** @type {FwOverview} */ (await api('GET', '/firmware'));
  if (stale(ctx, nav)) return true;
  const panel = ctx.view.querySelector('#fw-modules');
  if (panel instanceof HTMLElement) { panel.innerHTML = modulesPanel(fresh); hydrateIcons(panel); }
  return true;
}

/**
 * Tag v<version> and its release on GitHub through the Worker (src/github.ts); a tag that says
 * something else is replaced only after the colleague confirms. Falls back to the commands.
 * @param {HTMLElement} box @param {string} version @param {{ answer: PublishAnswer, candidate: Candidate }[]} list @param {RepoInfo} repo
 * @param {boolean} [replaceTag]
 */
async function githubRelease(box, version, list, repo, replaceTag = false) {
  const tag = `v${version}`;
  box.innerHTML = `<h3>Tag and release ${esc(tag)}</h3><div class="loading"><span class="spinner dark"></span> On GitHub…</div>`;
  try {
    const r = await api('POST', '/firmware/releases', {
      repo: repo.slug, commit: /** @type {Head} */ (repo.head).commit, version,
      files: list.map((d) => ({ file: d.candidate.original.name, path: d.candidate.path })), replaceTag,
    });
    const state = { created: 'set', kept: 'was there already and says the same', replaced: 'replaced' }[/** @type {'created' | 'kept' | 'replaced'} */ (r.tagState)];
    box.innerHTML = `<h3>Tag and release ${esc(tag)}</h3>
      <div class="notice ok">Tag <a href="${esc(r.tagUrl)}" rel="noopener">${esc(tag)}</a> ${esc(state)} in ${esc(r.repo)};
        release <a href="${esc(r.releaseUrl)}" rel="noopener">${esc(tag)}</a> ${r.releaseState === 'created' ? 'made' : 'was there already'}${r.assets.length ? `, with ${esc(r.assets.join(', '))} attached` : ''}.
        ${r.safetyNet && r.tagState !== 'kept' ? ' The tag starts the repository\'s publish workflow, which writes the same entry again.' : ''}</div>`;
  } catch (err) {
    const body = err instanceof ApiError ? err.body : null;
    box.innerHTML = `<h3>Tag and release ${esc(tag)}</h3><div class="notice err">${esc(errorText(err))}</div>
      ${body?.conflict === 'tag' ? `<pre class="keytext">${esc(body.existingMessage ?? '(a tag without annotation)')}</pre>
        <div class="btn-row"><button type="button" class="btn" data-replace-tag>Replace ${esc(tag)}…</button></div>` : ''}
      <div data-manual></div>`;
    box.querySelector('[data-replace-tag]')?.addEventListener('click', async () => {
      const ok = await confirmDialog(`Replace ${tag} in ${repo.slug}?`,
        `The tag is deleted and set again on ${esc(/** @type {Head} */ (repo.head).commit.slice(0, 7))}, saying what was published. That starts the repository's publish workflow again, which then writes the same entry.`, 'Replace tag', true);
      if (ok) await githubRelease(box, version, list, repo, true);
    });
    drawManualTag(/** @type {HTMLElement} */ (box.querySelector('[data-manual]')), version, list.map((d) => d.answer), repo, true);
  }
}

/** What the dry runs say will be written, and per version whether Deploy tags and releases it. @param {Map<string, PublishAnswer[]>} byVersion @param {FwOverview} data @param {RepoInfo | null} repo */
function reviewBody(byVersion, data, repo) {
  const behind = repo?.sync?.state === 'github-newer' || repo?.sync?.state === 'diverged';
  return `${behind ? `<div class="notice warn">${esc(repo?.sync?.source === 'github' ? `${repo.sync.branch} on GitHub` : `origin/${repo?.sync?.branch}`)} has newer commits than the HEAD these files come from (${esc(repo?.head?.commit.slice(0, 7) ?? '')}): pull first, unless you mean to publish this older commit.</div>` : ''}
    ${repo?.pushed === false ? '<div class="notice warn">HEAD is not on GitHub yet: push it before the tag is set.</div>' : ''}
    ${[...byVersion.entries()].map(([version, list]) => {
      const why = cannotRelease(data, repo, list);
      return `<div class="fw-group">
      <h3>Version ${esc(version)} <span class="muted">· ${esc(list[0].date)}</span></h3>
      <p class="pre">${esc(list[0].changelog)}</p>
      <ul class="plain-list">${list.map((p) => `<li><span class="mono">${esc(p.file)}</span> · ${esc(p.moduleName)} (${esc(p.hwId)})
        · ${p.objectWritten ? 'new file' : 'the identical file is there already'}
        · ${p.newModule ? 'new module manifest' : p.replacedRelease ? 'its entry is written again' : 'entry added'}
        · latest_firmware ${esc(p.latestBefore ?? 'none')} → ${esc(p.latest)}
        <details><summary>The module manifest as it will be</summary><pre class="keytext">${esc(p.moduleManifest)}</pre></details></li>`).join('')}</ul>
      <label class="check"><input type="checkbox" name="gh-${esc(version)}"${why ? ' disabled' : ' checked'}>
        Then set tag v${esc(version)} on ${esc(repo?.head?.commit.slice(0, 7) ?? 'the commit')} and make the GitHub release${repo?.slug ? ` in ${esc(repo.slug)}` : ''}, with the .srec attached</label>
      ${why ? `<p class="hint">${esc(why)}</p>` : ''}
    </div>`;
    }).join('')}
    <p class="hint">Then modules/manifest.json. A published firmware never changes afterwards.</p>`;
}

/**
 * The tag by hand: the annotation the safety net reads and the commands.
 * @param {HTMLElement} box @param {string} version @param {PublishAnswer[]} list @param {RepoInfo | null} repo @param {boolean} [fallback]  after a failed GitHub call
 */
function drawManualTag(box, version, list, repo, fallback = false) {
  const tag = `v${version}`;
  const files = list.map((r) => r.file.split('/').pop() ?? r.file);
  const released = `20${list[0].date.slice(6, 8)}-${list[0].date.slice(3, 5)}-${list[0].date.slice(0, 2)}`;
  const annotation = tagAnnotation(released, files, list[0].changelog);
  const existing = repo?.tags.find((t) => t.name === tag) ?? null;
  const commit = repo?.head?.commit ?? '';
  const file = `tag-${tag}.txt`;
  const idText = uniqueId('fw-tag');
  const idCmd = uniqueId('fw-cmd');
  const matches = existing?.message ? annotationMatches(existing.message, released, files, list[0].changelog) : false;
  const commands = [
    ...(existing ? [`git tag -d ${tag}`, `git push origin --delete ${tag}`] : []),
    `git tag -a ${tag} --cleanup=whitespace -F "$HOME/Downloads/${file}"${commit ? ` ${commit}` : ''}`,
    `git push origin ${tag}`,
  ].join('\n');
  const githubLink = repo?.github ? `<a href="${esc(`${repo.github}/releases/new?tag=${encodeURIComponent(tag)}`)}" rel="noopener">Make the GitHub release of ${esc(tag)}</a>` : '';
  const title = fallback ? '' : `<h3>Set tag ${esc(tag)}</h3>`;
  if (matches) {
    box.innerHTML = `${title}<div class="notice ok">Tag ${esc(tag)} exists with exactly this date, these files and this changelog: nothing to do.${githubLink ? ` ${githubLink}.` : ''}</div>`;
    return;
  }
  box.innerHTML = `${title}
    <p class="text">${fallback ? 'Or by hand, in the repository:' : existing
      ? `Tag ${esc(tag)} exists with another date, files or changelog. Replace it, so the safety net agrees with what was published:`
      : `In ${esc(repo?.repo ?? 'the repository')}, so the history says what was published. Pushing it starts the repository's publish workflow (the safety net), which then writes exactly the same entry:`}</p>
    <div class="key-box"><div class="key-head"><span class="section-label">Annotation</span>${copyButton(idText, 'annotation')}
      <button type="button" class="btn sm" data-save-annotation="${idText}" data-filename="${esc(file)}" data-icon="arrow-down-tray">Download ${esc(file)}</button></div>
      <pre class="keytext" id="${idText}">${esc(annotation)}</pre></div>
    <div class="key-box"><div class="key-head"><span class="section-label">Commands (PowerShell or Git Bash, in the repository)</span>${copyButton(idCmd, 'commands')}</div>
      <pre class="keytext" id="${idCmd}">${esc(commands)}</pre></div>
    <p class="hint">The command reads the annotation from your Downloads folder; change the path if the browser saved it elsewhere.</p>
    ${commit ? `<p class="hint">The tag points to ${esc(commit.slice(0, 7))}, the commit the files were read from.</p>` : `<p class="hint">Without the repository Deploy does not know the commit: tag the one that holds ${esc(files.join(', '))}.</p>`}
    ${githubLink ? `<p>${githubLink}, with the changelog as its notes and the .srec attached.</p>` : ''}`;
  hydrateIcons(box);
  box.querySelectorAll('[data-save-annotation]').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(/** @type {HTMLElement} */ (b).dataset.saveAnnotation ?? '');
    if (el) saveBlob(new Blob([el.textContent ?? ''], { type: 'text/plain' }), /** @type {HTMLElement} */ (b).dataset.filename ?? 'tag.txt');
  }));
}
