// @ts-check
// Firmware (#/firmware): module firmware on firmware.gocontroll.tech, which go-modules flashes into
// the plug-in modules of an L4, M1 or HMI1. The modules with their releases, and Publish firmware.
//
// Publish starts from the module's source folder (the Module-* repository, preferred) or from
// loose .srec files. From a folder the page finds every <...>-BOOT/<name>.srec, as the CI of the
// module repos does, and reads the repository's git history in the browser (git.js; nothing is
// uploaded but the .srec): the annotation of the version's tag if it exists, otherwise the
// commits since the previous version's tag, as the suggested changelog. Module and version come
// from the file name (20-10-1-6-2-0-3.srec = 20100106, 2.0.3), the release date from the file's
// date. The Worker writes the file and both manifests (src/firmware.ts).
//
// CRLF is turned into LF before anything else: a Windows checkout (core.autocrlf) has CRLF, git
// and the CI have LF, and the published bytes must be those of the file in git.

import { api, errorText, postForm } from './api.js';
import { fmtDateTime, plural, shortHash } from './format.js';
import { dirFromFiles, dirFromHandle, GitError, openRepo } from './git.js';
import { act, copyButton, esc, hydrateIcons, toast, uniqueId } from './lib.js';
import { changelogFromTag, compareVersions, localDay, parseSrecName, previousTag, toLf } from './release-helpers.js';
import { parseSrec } from './source.js';
import { badge, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {{ version: string, file: string, date: string, sha256: string, changelog: string,
 *   publishedBy: { email: string, at: string, source: Source | null } | null }} FwRelease
 * @typedef {{ id: string, name: string, hardwareVersion: string, latest: string | null, releases: FwRelease[], error?: string }} FwModule
 * @typedef {{ updated: string | null, modules: FwModule[], manifestError?: string, firmwareUrl: string, moduleTypeNames: Record<string, string> }} FwOverview
 * @typedef {{ repo: string, branch: string | null, commit: string | null, tag: string | null }} Source
 * @typedef {{ file: string, hwId: string, typeId: string, version: string, hardwareVersion: string }} SrecName
 * @typedef {{ path: string, name: SrecName | null, original: File, bytes: Uint8Array | null, sha256: string | null,
 *   modified: number, error: string | null, status: 'new' | 'same' | 'differs' | 'bad', selected: boolean }} Candidate
 * @typedef {{ commit: string, branch: string | null }} Head
 * @typedef {{ name: string, commit: string, annotated: boolean, message: string | null, date: string | null }} Tag
 * @typedef {{ sha: string, subject: string, authorDate: string }} Commit
 * @typedef {{ repo: string, head: Head | null, tags: Tag[], gitError: string | null,
 *   log: (opts: { from: string, exclude?: string, max?: number }) => Promise<Commit[]> }} RepoInfo
 */

const hex = (/** @type {ArrayBuffer} */ b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

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
      <p class="text">Choose the module's source folder (its repository, e.g. Module-Input): Deploy finds the .srec files in its -BOOT folders and suggests the changelog from git. Loose .srec files work too, without that history. Nothing in the folder is changed or uploaded except the .srec you publish.</p>
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

/**
 * The .srec files in the folder's <...>-BOOT folders (as the CI: *-BOOT/*.srec) and its git history.
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
  /** @type {RepoInfo} */
  const repo = { repo: name, head: null, tags: [], gitError: null, log: async () => [] };
  try {
    const r = await openRepo(dir);
    if (!r) {
      repo.gitError = 'This folder is not a git repository, so there is no history to suggest a changelog from.';
    } else {
      repo.head = r.head;
      repo.tags = await r.tags();
      repo.log = (opts) => r.log(opts);
    }
  } catch (err) {
    repo.gitError = err instanceof GitError ? err.message : `The git history could not be read: ${errorText(err)}`;
  }
  if (!found.length) throw new Error(`${name} has no .srec files in a -BOOT folder. Choose the module's repository, or the .srec files themselves.`);
  return { repo, files: found };
}

/**
 * Read, check and compare every file with what firmware.gocontroll.tech has.
 * @param {FwOverview} data @param {{ path: string, file: File }[]} found
 * @returns {Promise<Candidate[]>}
 */
async function readCandidates(data, found) {
  const byId = new Map(data.modules.map((m) => [m.id, m]));
  return Promise.all(found.map(async ({ path, file }) => {
    const name = parseSrecName(file.name);
    /** @type {Candidate} */
    const c = { path, name, original: file, bytes: null, sha256: null, modified: file.lastModified, error: null, status: 'bad', selected: false };
    if (!name) { c.error = 'The name does not follow the convention (e.g. 20-10-1-6-2-0-3.srec).'; return c; }
    try {
      const text = toLf(await file.text());
      parseSrec(text);
      c.bytes = new TextEncoder().encode(text);
      c.sha256 = hex(await crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (c.bytes)));
    } catch (err) {
      c.error = errorText(err);
      return c;
    }
    const published = byId.get(name.hwId)?.releases.find((r) => r.version === name.version);
    c.status = !published ? 'new' : published.sha256 === c.sha256 ? 'same' : 'differs';
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
  const candidates = (await readCandidates(data, found)).sort((a, b) =>
    (a.name && b.name ? compareVersions(b.name.version, a.name.version) || a.name.hwId.localeCompare(b.name.hwId) : a.name ? -1 : 1));
  const versions = [...new Set(candidates.filter((c) => c.name).map((c) => /** @type {SrecName} */ (c.name).version))];
  const suggestions = new Map(await Promise.all(versions.map(async (v) => /** @type {const} */ ([v, await suggest(repo, v)]))));
  const statusBadge = (/** @type {Candidate} */ c) => ({
    new: badge('New', 'info'),
    same: badge('Published', 'ok', 'This version is on firmware.gocontroll.tech with these exact bytes'),
    differs: badge('Published, other bytes', 'warn', 'This version is on firmware.gocontroll.tech, but the file differs'),
    bad: badge('Cannot be used', 'err'),
  })[c.status];

  out.innerHTML = `
    ${repo ? `<div class="notice${repo.gitError ? ' warn' : ''}">${repoLine(repo)}</div>` : '<div class="notice">Files chosen without their repository: write the changelog yourself.</div>'}
    <div class="section-label">Files found</div>
    <div class="table-wrap"><table class="data cards fw-files">
      <thead><tr><th><span class="sr-only">Publish</span></th><th>File</th><th>Module</th><th>Version</th><th>File date</th><th>Status</th></tr></thead>
      <tbody>${candidates.map((c, i) => `<tr${c.status === 'bad' ? ' class="inactive"' : ''}>
        <td data-label="Publish"><input type="checkbox" data-pick="${i}"${c.selected ? ' checked' : ''}${c.status === 'bad' ? ' disabled' : ''} aria-label="Publish ${esc(c.original.name)}"></td>
        <td data-label="File" class="mono">${esc(c.path)}${c.error ? `<div class="cell-sub error">${esc(c.error)}</div>` : ''}</td>
        <td data-label="Module">${c.name ? `${esc(moduleName(data, c.name.hwId) || '—')}<div class="cell-sub mono">${esc(c.name.hwId)} · HW ${esc(c.name.hardwareVersion)}</div>` : '—'}</td>
        <td data-label="Version" class="mono">${esc(c.name?.version ?? '—')}</td>
        <td data-label="File date">${esc(fmtDateTime(new Date(c.modified).toISOString()))}</td>
        <td data-label="Status">${statusBadge(c)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div data-groups></div>
    <div class="btn-row"><button type="button" class="btn primary" data-publish data-icon="cloud-arrow-up">Publish</button></div>
    <div data-results></div>`;
  hydrateIcons(out);

  const groupsEl = /** @type {HTMLElement} */ (out.querySelector('[data-groups]'));
  const publishBtn = /** @type {HTMLButtonElement} */ (out.querySelector('[data-publish]'));
  /** @type {Map<string, { released: string, changelog: string, replace: boolean, names: Record<string, string> }>} */
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
    const byVersion = new Map();
    for (const c of chosen) byVersion.set(/** @type {SrecName} */ (c.name).version, [...(byVersion.get(/** @type {SrecName} */ (c.name).version) ?? []), c]);
    groupsEl.innerHTML = [...byVersion.entries()].map(([version, list]) => {
      const s = suggestions.get(version);
      if (!values.has(version)) {
        values.set(version, { released: localDay(Math.max(...list.map((/** @type {Candidate} */ c) => c.modified))), changelog: s?.text ?? '', replace: false, names: {} });
      }
      const val = /** @type {{ released: string, changelog: string, replace: boolean, names: Record<string, string> }} */ (values.get(version));
      const unnamed = list.filter((/** @type {Candidate} */ c) => !moduleName(data, /** @type {SrecName} */ (c.name).hwId));
      const again = list.some((/** @type {Candidate} */ c) => c.status !== 'new');
      const idDate = uniqueId('fw-date');
      const idLog = uniqueId('fw-log');
      return `<div class="fw-group" data-group="${esc(version)}">
        <h3>Version ${esc(version)} <span class="muted">· ${plural(list.length, 'file')}: ${list.map((/** @type {Candidate} */ c) => esc(/** @type {SrecName} */ (c.name).hwId)).join(', ')}</span></h3>
        <div class="form-grid two">
          <div class="field"><label for="${idDate}">Release date</label><input type="date" id="${idDate}" name="released" value="${esc(val.released)}" required>
            <div class="hint">The date of the .srec file; in the manifest as DD/MM/YY.</div></div>
          ${unnamed.map((/** @type {Candidate} */ c) => {
            const n = /** @type {SrecName} */ (c.name);
            const id = uniqueId('fw-name');
            return `<div class="field"><label for="${id}">Name of module ${esc(n.hwId)}</label>
              <input id="${id}" data-name-for="${esc(n.hwId)}" value="${esc(val.names[n.hwId] ?? '')}" maxlength="80" placeholder="e.g. 6 Channel Input module" required>
              <div class="hint">New on firmware.gocontroll.tech: go-modules shows this name.</div></div>`;
          }).join('')}
          <div class="field span-2"><label for="${idLog}">Changelog</label>
            <textarea id="${idLog}" name="changelog" rows="4" maxlength="2000" required>${esc(val.changelog)}</textarea>
            <div class="hint">${esc(s?.hint ?? 'Short: what changed for the user of the module. go-modules shows it.')}</div></div>
        </div>
        ${s?.commits.length ? `<details class="fw-commits"><summary>${esc(s.commitsLabel)}</summary>
          <ul class="plain-list mono">${s.commits.map((c) => `<li><span class="muted">${esc(c.sha.slice(0, 7))}</span> ${esc(c.subject)}</li>`).join('')}</ul>
          <button type="button" class="btn sm" data-use-commits="${esc(version)}">Use these as the changelog</button></details>` : ''}
        ${again ? `<label class="check"><input type="checkbox" name="replace"${val.replace ? ' checked' : ''}> Publish again: replace the version that is on firmware.gocontroll.tech (the old file is archived)</label>` : ''}
      </div>`;
    }).join('');
    groupsEl.querySelectorAll('[data-use-commits]').forEach((b) => b.addEventListener('click', () => {
      const v = /** @type {HTMLElement} */ (b).dataset.useCommits ?? '';
      const s = suggestions.get(v);
      const area = /** @type {HTMLTextAreaElement | null} */ (b.closest('[data-group]')?.querySelector('[name=changelog]') ?? null);
      if (s && area) area.value = s.commits.map((c) => `- ${c.subject}`).join('\n');
    }));
    publishBtn.disabled = !chosen.length;
    publishBtn.textContent = chosen.length ? `Publish ${plural(chosen.length, 'file')}` : 'Publish';
  };

  out.querySelectorAll('[data-pick]').forEach((box) => box.addEventListener('change', () => {
    const c = candidates[Number(/** @type {HTMLElement} */ (box).dataset.pick)];
    c.selected = /** @type {HTMLInputElement} */ (box).checked;
    drawGroups();
  }));
  drawGroups();

  publishBtn.addEventListener('click', () => act(publishBtn, async () => {
    drawGroups(); // reads the fields into `values`
    const chosen = candidates.filter((c) => c.selected && c.name && c.bytes);
    for (const c of chosen) {
      const v = values.get(/** @type {SrecName} */ (c.name).version);
      if (!v?.released || !v.changelog.trim()) throw new Error(`Fill in the release date and the changelog of version ${c.name?.version}.`);
      if (!moduleName(data, /** @type {SrecName} */ (c.name).hwId) && !v.names[/** @type {SrecName} */ (c.name).hwId]?.trim()) {
        throw new Error(`Fill in the name of module ${c.name?.hwId}.`);
      }
    }
    // Done: choosing again starts over, so nothing is sent twice by accident.
    if (await publishAll(ctx, out, chosen, values, repo)) publishBtn.hidden = true;
  }));
}

/**
 * The changelog to suggest for a version: the annotation of its tag, or the commits since the
 * previous version's tag. @param {RepoInfo | null} repo @param {string} version
 * @returns {Promise<{ text: string, hint: string, commits: Commit[], commitsLabel: string, tag: string | null }>}
 */
async function suggest(repo, version) {
  const none = { text: '', hint: 'Short: what changed for the user of the module. go-modules shows it.', commits: [], commitsLabel: '', tag: null };
  if (!repo?.head) return none;
  const own = repo.tags.find((t) => t.name === `v${version}`);
  const prev = previousTag(repo.tags, version);
  /** @type {Commit[]} */
  let commits = [];
  try {
    commits = await repo.log({ from: own?.commit ?? repo.head.commit, exclude: prev?.commit, max: 50 });
  } catch (err) {
    return { ...none, hint: `The git history could not be read: ${errorText(err)}` };
  }
  const commitsLabel = prev ? `${plural(commits.length, 'commit')} since ${prev.name}` : `The last ${plural(commits.length, 'commit')} (no earlier version tag)`;
  if (own?.message) {
    const text = changelogFromTag(own.message);
    if (text) return { text, hint: `From the annotation of tag ${own.name}.`, commits, commitsLabel, tag: own.name };
  }
  return {
    text: commits.length ? commits.map((c) => `- ${c.subject}`).join('\n') : '',
    hint: commits.length ? `${commitsLabel}: shorten it to what matters for the user of the module.` : none.hint,
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
  return `<strong>${esc(repo.repo)}</strong> · ${head.branch ? `branch <span class="mono">${esc(head.branch)}</span>` : 'detached HEAD'} at <span class="mono">${esc(head.commit.slice(0, 7))}</span> · ${plural(versionTags, 'version tag')}`;
}

/** The module's name on firmware.gocontroll.tech, or that of its type. @param {FwOverview} d @param {string} hwId */
function moduleName(d, hwId) {
  return d.modules.find((m) => m.id === hwId)?.name
    || d.modules.find((m) => m.id.startsWith(hwId.slice(0, 6)) && m.name)?.name
    || d.moduleTypeNames[hwId.slice(0, 6)]
    || '';
}

// ── Publishing ───────────────────────────────────────────────────────────────

/**
 * One request per file, one after the other (they may share manifests).
 * @param {Ctx} ctx @param {HTMLElement} out @param {Candidate[]} chosen
 * @param {Map<string, { released: string, changelog: string, replace: boolean, names: Record<string, string> }>} values
 * @param {RepoInfo | null} repo
 * @returns {Promise<boolean>} true when every file was published
 */
async function publishAll(ctx, out, chosen, values, repo) {
  const results = /** @type {HTMLElement} */ (out.querySelector('[data-results]'));
  results.innerHTML = `<ul class="plain-list fw-results">${chosen.map((c, i) => `<li data-result="${i}"><span class="mono">${esc(c.original.name)}</span> <span class="muted" data-state>waiting</span></li>`).join('')}</ul>`;
  let failed = 0;
  for (const [i, c] of chosen.entries()) {
    const li = /** @type {HTMLElement} */ (results.querySelector(`[data-result="${i}"] [data-state]`));
    const name = /** @type {SrecName} */ (c.name);
    const v = /** @type {{ released: string, changelog: string, replace: boolean, names: Record<string, string> }} */ (values.get(name.version));
    const form = new FormData();
    form.append('file', new File([/** @type {Uint8Array<ArrayBuffer>} */ (c.bytes)], c.original.name, { type: 'application/octet-stream' }));
    form.append('released', v.released);
    form.append('changelog', v.changelog.trim());
    if (v.names[name.hwId]?.trim()) form.append('module_name', v.names[name.hwId].trim());
    if (v.replace) form.append('replace', 'true');
    if (repo?.head) {
      const tag = repo.tags.find((t) => t.name === `v${name.version}`);
      form.append('source', JSON.stringify({ repo: repo.repo, branch: repo.head.branch, commit: repo.head.commit, tag: tag?.name ?? null }));
    }
    li.textContent = 'publishing…';
    try {
      const r = await postForm('/firmware', form);
      li.innerHTML = `${badge(r.objectWritten ? 'Published' : 'Manifest updated', 'ok')} <a href="${esc(r.url)}" rel="noopener">${esc(r.file)}</a> · latest of ${esc(r.hwId)} is now ${esc(r.latest)}`;
    } catch (err) {
      failed++;
      li.innerHTML = `${badge('Failed', 'err')} ${esc(errorText(err))}`;
    }
  }
  if (failed) {
    toast(`${plural(failed, 'file')} not published.`, 'err');
    return false;
  }
  toast(`${plural(chosen.length, 'file')} published.`);
  // Draw the modules again; the results stay above them.
  const nav = ctx.nav;
  const data = /** @type {FwOverview} */ (await api('GET', '/firmware'));
  if (stale(ctx, nav)) return true;
  const panel = ctx.view.querySelector('#fw-modules');
  if (panel instanceof HTMLElement) { panel.innerHTML = modulesPanel(data); hydrateIcons(panel); }
  return true;
}
