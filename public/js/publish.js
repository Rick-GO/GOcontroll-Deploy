// @ts-check
// Publish (#/publish; ?app=<APP_ID> picks the folder): put an S1 release into its App ID
// folder in the bucket and point the manifest at it, like the Cloud deployment page of the
// Deployment Tool (its README, "Publishing a release"). What stands in the manifest is shown
// first; a version that is published already takes a deliberate yes (Replace…); a version
// below latest is said out loud, because latest then moves back and a controller on
// update-to-latest installs that older image.
//
// The browser reads the file (source.js: S-record to image, then compressed) and uploads
// the compressed payload, or a ready-made container as it is. The Worker builds and signs
// the container, and writes the binary first and the manifest second.

import { ApiError, api, errorText, folderPath, postForm } from './api.js';
import { fmtDay, hostOf, plural } from './format.js';
import { act, copyButton, esc, field, hydrateIcons } from './lib.js';
import { appendFile, mountFilePicker, prefillVersion } from './picker.js';
import { appIdProblem, compareVersions, parseVersion } from './source.js';
import { badge, confirmDialog, runSteps, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').Overview} Overview
 * @typedef {import('./api.js').FolderSummary} FolderSummary
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').PublishResult} PublishResult
 * @typedef {import('./picker.js').Picked} Picked
 */

/**
 * The Worker's DISTRIBUTION_URLS when /api/overview does not send them (distributionUrls):
 * the two hosts of the bucket (cloud-r2-distribution.md §2.1); the first is the default
 * for a new folder. The Worker refuses any other.
 */
export const DEFAULT_DISTRIBUTION_URLS = ['https://deploy.gocontroll.tech', 'https://deploy.gocontroll.com'];

const NEW = '__new__';

/** @param {Ctx} ctx @param {URLSearchParams} params */
export async function renderPublish(ctx, params) {
  const nav = ctx.nav;
  setHero({
    title: 'Publish a release',
    lede: 'Put an S1 application into the folder of its App ID and point the manifest at it. Controllers on update-to-latest install it from there.',
  });
  /** @type {Overview} */
  let overview = await api('GET', '/overview');
  if (stale(ctx, nav)) return;
  const dists = overview.distributionUrls?.length ? overview.distributionUrls : DEFAULT_DISTRIBUTION_URLS;
  const wanted = params.get('app') ?? '';

  ctx.view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Folder</h2></div>
      <div class="form-grid two">
        ${field('Folder (App ID)', (id) => `<select id="${id}" data-f="folder"></select>`, 'span-2')}
        <div class="span-2 form-grid two" data-new hidden>
          ${field('App ID of the new folder', (id) => `<input id="${id}" data-f="appId" class="mono" maxlength="32" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="GOCOXYZ">`,
            '', 'Names the folder and goes into every container header: the App ID the controllers carry. 1–32 characters, no spaces and no "/".')}
          ${field('Distribution URL', (id) => `<select id="${id}" data-f="dist">${dists.map((u, i) => `<option value="${esc(u)}"${i === 0 ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select>`,
            '', "The binary URLs in the manifest start with it; the controllers of this App ID carry the same one. Both hosts serve the same bucket.")}
        </div>
      </div>
      <div data-folder-info></div>
    </section>
    <section class="panel" data-manifest-panel hidden>
      <div class="panel-head"><h2>In the manifest now</h2></div>
      <div data-manifest></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Release</h2></div>
      <div class="form-grid two">
        <div class="span-2" data-picker></div>
        ${field('Version', (id) => `<input id="${id}" data-f="version" name="version" class="mono" inputmode="decimal" autocomplete="off" placeholder="major.minor.patch">`,
          '', '<span data-version-hint>Goes into the container header and names the file. A file named …_1.2.3.bin fills it in.</span>')}
        ${field('What changed', (id) => `<textarea id="${id}" data-f="description" name="description" rows="3" maxlength="500" placeholder="What this release changes"></textarea>`,
          'span-2', 'Required: the release note the manifest carries, shown next to the version.')}
      </div>
      <div data-sign></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Publish</h2></div>
      <div data-plan></div>
      <div class="notice err" data-error hidden></div>
      <div class="btn-row"><button type="button" class="btn primary" data-go data-icon="cloud-arrow-up"><span data-go-label>Publish</span></button></div>
      <div class="run" data-progress hidden></div>
      <div data-result hidden></div>
    </section>`;
  hydrateIcons(ctx.view);

  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (ctx.view.querySelector(sel));
  const folderSel = /** @type {HTMLSelectElement} */ (q('[data-f="folder"]'));
  const appIdIn = /** @type {HTMLInputElement} */ (q('[data-f="appId"]'));
  const distSel = /** @type {HTMLSelectElement} */ (q('[data-f="dist"]'));
  const versionIn = /** @type {HTMLInputElement} */ (q('[data-f="version"]'));
  const descIn = /** @type {HTMLTextAreaElement} */ (q('[data-f="description"]'));
  const errorBox = q('[data-error]');
  const goBtn = /** @type {HTMLButtonElement} */ (q('[data-go]'));

  const st = {
    /** @type {FolderDetail | null} */ detail: null,
    /** @type {string | null} */ detailFor: null,
    /** @type {string | null} */ detailError: null,
    /** @type {import('./api.js').KeyInfo | null} the key of a new folder's App ID (one can be made before the first release) */ newKey: null,
    loading: false,
    detailToken: 0,
    /** @type {{ auto: string }} */ version: { auto: '' },
  };

  const byId = () => new Map(overview.folders.map((f) => [f.appId, f]));

  /** The folder options: S1 (and unrecognised) folders; Linux folders are not published to from here. */
  const fillFolders = (/** @type {string} */ selected) => {
    const folders = overview.folders.filter((f) => f.kind !== 'linux').sort((a, b) => a.appId.localeCompare(b.appId));
    folderSel.innerHTML = `<option value="">Choose a folder…</option>
      ${folders.map((f) => `<option value="${esc(f.appId)}">${esc(f.appId)}${f.customer ? ` · ${esc(f.customer.name)}` : ''}${f.kind === 'unknown' ? ' (unrecognised manifest)' : ''}</option>`).join('')}
      <option value="${NEW}">New folder…</option>`;
    folderSel.value = folders.some((f) => f.appId === selected) ? selected : selected ? NEW : '';
  };
  fillFolders(wanted);
  if (folderSel.value === NEW && wanted) appIdIn.value = wanted;

  /** Where the release goes: the App ID, and the folder summary when it exists. */
  const target = () => {
    const id = folderSel.value === NEW ? appIdIn.value.trim() : folderSel.value;
    const existing = id ? byId().get(id) : undefined;
    return { id, existing, isNew: folderSel.value === NEW && !existing, linux: existing?.kind === 'linux' };
  };

  const picker = mountFilePicker(q('[data-picker]'), (p) => {
    prefillVersion(versionIn, p, st.version);
    draw();
  });

  /** Load what the target needs when it changed: the folder's detail (manifest, key), or for a new folder whether its App ID has a key. */
  const loadDetail = async () => {
    const t = target();
    const valid = Boolean(t.id) && !t.linux && !(t.isNew && appIdProblem(t.id));
    const want = valid ? `${t.isNew ? 'new' : 'folder'}:${t.id}` : null;
    if (want === st.detailFor) return;
    st.detailFor = want;
    st.detail = null;
    st.newKey = null;
    st.detailError = null;
    st.loading = Boolean(want);
    const mine = ++st.detailToken;
    draw();
    if (!want) return;
    try {
      if (t.isNew) {
        let key = null;
        try {
          key = await api('GET', `${folderPath(t.id)}/key`);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        if (mine === st.detailToken) st.newKey = key;
      } else {
        const d = await api('GET', folderPath(t.id));
        if (mine === st.detailToken) st.detail = d;
      }
    } catch (err) {
      if (mine === st.detailToken) st.detailError = errorText(err);
    }
    if (mine !== st.detailToken) return;
    st.loading = false;
    if (!stale(ctx, nav)) draw();
  };

  const hasKey = () => {
    const t = target();
    if (st.detail) return Boolean(st.detail.key);
    return t.isNew ? Boolean(st.newKey) : Boolean(t.existing?.hasKey);
  };

  // ── drawing ──
  const draw = () => {
    const t = target();
    const p = picker.get();
    q('[data-new]').hidden = folderSel.value !== NEW;

    // Folder info
    const info = q('[data-folder-info]');
    if (!t.id) {
      info.innerHTML = folderSel.value === NEW ? '' : '<p class="hint">Choose the folder of the application\'s App ID, or start a new one.</p>';
    } else if (t.linux) {
      info.innerHTML = `<div class="notice err"><span class="mono">${esc(t.id)}</span> is a Linux folder (go-deploy tarballs): S1 releases cannot go there.</div>`;
    } else if (t.isNew) {
      const problem = appIdProblem(t.id);
      info.innerHTML = problem ? `<div class="notice err">${esc(problem)}</div>`
        : `<p class="hint">New folder: the first release creates <span class="mono">${esc(t.id)}/manifest.json</span> on <span class="mono">${esc(hostOf(distSel.value))}</span>.</p>
          ${st.detailError ? `<div class="notice err">${esc(st.detailError)}</div>` : ''}`;
    } else if (t.existing) {
      const f = t.existing;
      const host = hostOf(st.detail?.distributionUrl ?? f.distributionUrl);
      info.innerHTML = `${folderSel.value === NEW ? `<p class="hint"><span class="mono">${esc(t.id)}</span> exists already: the release goes into that folder.</p>` : ''}
        <dl class="facts compact">
          <div><dt>Distribution host</dt><dd>${host ? `<span class="mono">${esc(host)}</span>` : '—'} <span class="muted">(from its manifest)</span></dd></div>
          <div><dt>Customer</dt><dd>${f.customer ? esc(f.customer.name) : '<span class="muted">none found</span>'}</dd></div>
          <div><dt>Signing key</dt><dd>${hasKey() ? 'Yes' : 'No'}</dd></div>
          <div><dt>Folder</dt><dd><a href="#/folders/${encodeURIComponent(t.id)}">Open the folder page</a></dd></div>
        </dl>
        ${st.detail?.mixedHosts ? '<div class="notice warn">This manifest names more than one host. The release goes onto the host the Worker takes from the manifest.</div>' : ''}`;
    }

    // In the manifest now
    const mPanel = q('[data-manifest-panel]');
    const m = q('[data-manifest]');
    mPanel.hidden = !t.id || t.linux || (t.isNew && Boolean(appIdProblem(t.id)));
    if (t.isNew) m.innerHTML = '<p class="muted">Nothing yet: this release starts the manifest, as its latest version.</p>';
    else if (st.detailError) m.innerHTML = `<div class="notice err">${esc(st.detailError)}</div>`;
    else if (!st.detail) m.innerHTML = '<div class="loading"><span class="spinner dark"></span> Reading the manifest…</div>';
    else m.innerHTML = manifestSummary(st.detail);

    // Version hint: what the container header says
    const vHint = q('[data-version-hint]');
    const header = p?.source.header;
    const v = versionIn.value.trim();
    /** @type {string[]} */
    const notes = [];
    if (header && v && header.version !== v) notes.push(`The container's header says ${header.version}: the Worker refuses a version that differs from it.`);
    if (header && t.id && header.appId !== t.id) notes.push(`The container's header names App ID ${header.appId}, not ${t.id}: the Worker refuses it.`);
    vHint.innerHTML = notes.length ? `<span class="error">${notes.map(esc).join(' ')}</span>`
      : 'Goes into the container header and names the file. A file named …_1.2.3.bin fills it in.';

    // Signing
    const sign = q('[data-sign]');
    if (!t.id || t.linux) sign.innerHTML = '';
    else if (hasKey()) {
      sign.innerHTML = `<label class="check locked"><input type="checkbox" checked disabled> Sign with the folder's key</label>
        <p class="hint">${t.isNew ? 'This App ID has a signing key already' : 'This folder has a signing key'}, so it takes signed releases only.${
          header?.signed ? ' The container is signed already: the Worker checks it was signed with this key.' : ''}</p>`;
    } else {
      sign.innerHTML = `<label class="check locked"><input type="checkbox" disabled> Sign with the folder's key</label>
        <div class="notice warn">${t.isNew ? 'A new folder has no signing key' : 'This folder has no signing key'}: the release goes out <strong>unsigned</strong>,
          and a controller with signing switched on refuses it.
          ${appIdProblem(t.id) ? '' : `<a href="#/folders/${encodeURIComponent(t.id)}">Create a key on the folder page</a> first to sign it.`}</div>`;
    }

    // Plan, and the button
    const plan = q('[data-plan]');
    const standing = standingRelease();
    const latest = st.detail?.latest ?? null;
    let versionOk = false;
    try { parseVersion(v); versionOk = true; } catch { /* not yet */ }
    if (t.linux) {
      plan.innerHTML = '';
    } else if (!t.id || !versionOk) {
      plan.innerHTML = '<p class="hint">Choose a folder, a file and a version to see what will be written.</p>';
    } else if (standing) {
      plan.innerHTML = `<div class="notice warn">Version <span class="mono">${esc(v)}</span> is published already (${esc(fmtDay(standing.releaseDate))}: ${esc(standing.description || 'no description')}).
        Publishing it again replaces that binary and its entry; controllers that run it keep the old image under the same number. Raise the version unless replacing is what you want.</div>`;
    } else {
      const writes = `Writes <span class="mono">${esc(t.id)}/${esc(t.id)}-${esc(v)}.bin</span> and points <span class="mono">${esc(t.id)}/manifest.json</span> at <span class="mono">${esc(v)}</span>.`;
      plan.innerHTML = latest && compareVersions(v, latest) < 0
        ? `<div class="notice warn">${writes} That moves <strong>latest</strong> back from <span class="mono">${esc(latest)}</span>, so a controller on update-to-latest installs this older version.</div>`
        : `<p class="hint">${writes}</p>`;
    }
    q('[data-go-label]').textContent = standing ? 'Replace…' : 'Publish';
  };

  /** The release standing at the version typed, if the manifest has it. */
  const standingRelease = () => {
    const v = versionIn.value.trim();
    return (v && st.detail?.releases?.find((r) => r.version === v)) || null;
  };

  // ── events ──
  folderSel.addEventListener('change', () => { loadDetail(); draw(); if (folderSel.value === NEW) appIdIn.focus(); });
  let typing = 0;
  appIdIn.addEventListener('input', () => { draw(); clearTimeout(typing); typing = window.setTimeout(loadDetail, 400); });
  distSel.addEventListener('change', draw);
  versionIn.addEventListener('input', draw);
  descIn.addEventListener('input', draw);

  goBtn.addEventListener('click', () => act(goBtn, async () => {
    errorBox.hidden = true;
    ctx.view.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const t = target();
    const p = picker.get();
    const v = versionIn.value.trim();
    const description = descIn.value.trim();
    if (!t.id) throw fieldError(folderSel.value === NEW ? appIdIn : folderSel, folderSel.value === NEW ? 'Enter the App ID of the new folder.' : 'Choose a folder.');
    if (t.isNew) { const problem = appIdProblem(t.id); if (problem) throw fieldError(appIdIn, problem); }
    if (t.linux) throw fieldError(appIdIn, `${t.id} is a Linux folder: S1 releases cannot go there.`);
    if (st.detailError) throw new ApiError(st.detailError, 0);
    if (st.loading || (t.existing && !st.detail)) throw new ApiError('The folder is still being read. Try again in a moment.', 0);
    if (picker.reading()) throw new ApiError('The file is still being read. Try again in a moment.', 0);
    if (!p) throw new ApiError('Choose the firmware file.', 400);
    try { parseVersion(v); } catch (err) { throw fieldError(versionIn, errorText(err)); }
    if (!description) throw fieldError(descIn, 'Describe what this release changes: the manifest carries it as the release note.');

    const standing = standingRelease();
    const latest = st.detail?.latest ?? null;
    const lower = Boolean(latest && compareVersions(v, latest) < 0);
    if (standing || lower) {
      const parts = [];
      if (standing) {
        parts.push(`<p>Version <span class="mono">${esc(v)}</span> is published already (${esc(fmtDay(standing.releaseDate))}: ${esc(standing.description || 'no description')}).
          Replacing it overwrites that binary and its entry in the manifest. Controllers that run it keep the old image, and still report the same version number.</p>`);
      }
      if (lower) {
        parts.push(`<p><strong>latest</strong> moves back from <span class="mono">${esc(latest)}</span> to <span class="mono">${esc(v)}</span>: a controller on update-to-latest installs this older image.</p>`);
      }
      const ok = await confirmDialog(standing ? `Replace version ${v}?` : `Move latest back to ${v}?`, parts.join(''), standing ? 'Replace' : 'Publish anyway', true);
      if (!ok) return;
    }

    const form = new FormData();
    form.append('appId', t.id);
    form.append('version', v);
    form.append('description', description);
    form.append('sign', hasKey() ? '1' : '0');
    form.append('replace', standing ? '1' : '0');
    if (t.isNew) form.append('distributionUrl', distSel.value);
    appendFile(form, p);

    const result = q('[data-result]');
    result.hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', 'Writing the binary, then the manifest']);
    /** @type {PublishResult} */
    let res;
    try {
      res = await postForm('/releases', form, { onProgress: (f) => { run.upload(f); if (f >= 1) run.step(1); } });
    } catch (err) {
      run.fail();
      throw err;
    }
    run.done();
    showResult(result, res, t.id);

    // Fresh data: a new folder now exists, and the manifest has the release.
    overview = await api('GET', '/overview');
    if (stale(ctx, nav)) return;
    fillFolders(t.id);
    appIdIn.value = folderSel.value === NEW ? t.id : '';
    picker.clear();
    descIn.value = '';
    versionIn.value = '';
    st.version.auto = '';
    st.detailFor = null;
    await loadDetail();
    draw();
  }, (err) => {
    errorBox.textContent = errorText(err);
    errorBox.hidden = false;
  }));

  await loadDetail();
  draw();
}

/** An error at a form field: it is marked and focused. @param {HTMLElement} el @param {string} message */
function fieldError(el, message) {
  el.setAttribute('aria-invalid', 'true');
  el.focus();
  return new ApiError(message, 400);
}

/** The manifest as it stands: its latest release, then a few before it. @param {FolderDetail} d */
function manifestSummary(d) {
  const releases = [...(d.releases ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  if (!releases.length) return '<p class="muted">The manifest names no releases yet.</p>';
  const latest = releases.find((r) => r.version === d.latest) ?? releases[0];
  const older = releases.filter((r) => r !== latest);
  const shown = older.slice(0, 5);
  return `<dl class="facts">
      <div><dt>Latest version</dt><dd class="mono">${esc(latest.version)}${latest.header && !latest.header.signed ? ` ${badge('Unsigned', 'warn')}` : ''}</dd></div>
      <div><dt>Released</dt><dd>${esc(fmtDay(latest.releaseDate))}</dd></div>
      <div class="span-all"><dt>What changed</dt><dd>${esc(latest.description || 'no description')}</dd></div>
    </dl>
    ${shown.length ? `<div class="section-label">Before that</div>
    <div class="table-wrap"><table class="data cards">
      <thead><tr><th>Version</th><th>Released</th><th>What changed</th></tr></thead>
      <tbody>${shown.map((r) => `<tr><td data-label="Version" class="mono">${esc(r.version)}</td><td data-label="Released">${esc(fmtDay(r.releaseDate))}</td>
        <td data-label="What changed" class="desc">${esc(r.description || '—')}</td></tr>`).join('')}</tbody>
    </table></div>
    ${older.length > shown.length ? `<p class="hint muted">${plural(older.length - shown.length, 'older release')} not shown; the folder page lists them all.</p>` : ''}` : ''}`;
}

/** The result card after a publish. @param {HTMLElement} el @param {PublishResult} r @param {string} appId */
function showResult(el, r, appId) {
  el.hidden = false;
  el.innerHTML = `<div class="result">
    <div class="result-head"><span class="result-icon" data-icon="check"></span>
      <strong>Version <span class="mono">${esc(r.version)}</span> is ${r.replaced ? 'replaced' : 'published'}</strong>
      ${r.signed ? badge('Signed', 'ok') : badge('Unsigned', 'warn')}</div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Binary URL</span>${copyButton('publish-url', 'binary URL')}</div>
      <code class="keytext" id="publish-url">${esc(r.binaryUrl)}</code>
    </div>
    <dl class="facts compact">
      <div><dt>Release date</dt><dd>${esc(fmtDay(r.releaseDate))}</dd></div>
      <div><dt>Latest</dt><dd><span class="mono">${esc(r.version)}</span>${r.previousLatest && r.previousLatest !== r.version
        ? ` <span class="muted">(was ${esc(r.previousLatest)}${r.latestMovedBack ? ', moved back' : ''})</span>` : ''}</dd></div>
      <div><dt>Binary</dt><dd class="mono">${esc(r.binaryKey)}</dd></div>
      <div><dt>Manifest</dt><dd class="mono">${esc(r.manifestKey)}</dd></div>
    </dl>
    <div class="btn-row"><a class="btn sm" href="#/folders/${encodeURIComponent(appId)}" data-icon="folder">Open the folder</a></div>
  </div>`;
  hydrateIcons(el);
}
