// @ts-check
// Sign (#/sign; ?app=<APP_ID> picks the folder): sign an S1 application with its folder's
// key without publishing it, and download the signed container as <APP_ID>-<version>.bin:
// for a local upload with the Deployment Tool, or a customer who flashes it themselves.
// Nothing is written to the bucket. Only folders with a signing key can sign.

import { ApiError, api, errorText, postForm } from './api.js';
import { fmtBytes } from './format.js';
import { act, esc, field, hydrateIcons, saveBlob } from './lib.js';
import { fileSafe } from './key.js';
import { appendFile, mountFilePicker, prefillVersion } from './picker.js';
import { parseVersion } from './source.js';
import { runSteps, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').Overview} Overview
 */

/** @param {Ctx} ctx @param {URLSearchParams} params */
export async function renderSign(ctx, params) {
  const nav = ctx.nav;
  setHero({
    title: 'Sign a binary',
    lede: "Sign an S1 application with its folder's key without publishing it: for a local upload with the Deployment Tool, or a customer who flashes it themselves. Nothing goes into the bucket.",
  });
  /** @type {Overview} */
  const overview = await api('GET', '/overview');
  if (stale(ctx, nav)) return;
  const folders = overview.folders.filter((f) => f.hasKey && f.kind !== 'linux').sort((a, b) => a.appId.localeCompare(b.appId));
  const wanted = params.get('app') ?? '';
  const wantedNoKey = wanted && !folders.some((f) => f.appId === wanted);

  ctx.view.innerHTML = `<section class="panel">
    <div class="panel-head"><h2>Sign</h2></div>
    ${wantedNoKey ? `<div class="notice warn"><span class="mono">${esc(wanted)}</span> has no signing key. <a href="#/folders/${encodeURIComponent(wanted)}">Create one on its page</a> first.</div>` : ''}
    ${folders.length ? `<div class="form-grid two">
      ${field('Folder (App ID)', (id) => `<select id="${id}" data-f="folder"><option value="">Choose a folder…</option>
        ${folders.map((f) => `<option value="${esc(f.appId)}"${f.appId === wanted ? ' selected' : ''}>${esc(f.appId)}${f.customer ? ` · ${esc(f.customer.name)}` : ''}</option>`).join('')}</select>`,
        'span-2', 'Only folders with a signing key are listed. The container is signed with that key and carries the App ID in its header.')}
      <div class="span-2" data-picker></div>
      ${field('Version', (id) => `<input id="${id}" data-f="version" class="mono" inputmode="decimal" autocomplete="off" placeholder="major.minor.patch">`,
        '', '<span data-version-hint>Goes into the container header and names the file.</span>')}
    </div>
    <div data-plan></div>
    <div class="notice err" data-error hidden></div>
    <div class="btn-row"><button type="button" class="btn primary" data-go data-icon="shield-check">Sign and download</button></div>
    <div class="run" data-progress hidden></div>
    <div data-result hidden></div>`
    : '<p class="muted">No folder has a signing key yet. Make one on a folder\'s page (Status, then the folder, then Signing key).</p>'}
  </section>`;
  hydrateIcons(ctx.view);
  if (!folders.length) return;

  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (ctx.view.querySelector(sel));
  const folderSel = /** @type {HTMLSelectElement} */ (q('[data-f="folder"]'));
  const versionIn = /** @type {HTMLInputElement} */ (q('[data-f="version"]'));
  const errorBox = q('[data-error]');
  const goBtn = /** @type {HTMLButtonElement} */ (q('[data-go]'));
  const auto = { auto: '' };
  /** @type {{ blob: Blob, filename: string } | null} */
  let last = null;

  const draw = () => {
    const p = picker.get();
    const appId = folderSel.value;
    const v = versionIn.value.trim();
    const header = p?.source.header;
    /** @type {string[]} */
    const notes = [];
    if (header && v && header.version !== v) notes.push(`The container's header says ${header.version}.`);
    if (header && appId && header.appId !== appId) notes.push(`The container's header names App ID ${header.appId}, not ${appId}: the Worker refuses it.`);
    if (header?.signed) notes.push('The container is signed already: the Worker refuses it when that was another key.');
    q('[data-version-hint]').innerHTML = notes.length ? `<span class="error">${notes.map(esc).join(' ')}</span>` : 'Goes into the container header and names the file.';
    let ok = false;
    try { parseVersion(v); ok = true; } catch { /* not yet */ }
    q('[data-plan]').innerHTML = appId && ok
      ? `<p class="hint">Downloads <span class="mono">${esc(appId)}-${esc(v)}.bin</span>, signed with the key of <span class="mono">${esc(appId)}</span>.</p>`
      : '<p class="hint">Choose a folder, a file and a version.</p>';
  };

  const picker = mountFilePicker(q('[data-picker]'), (p) => { prefillVersion(versionIn, p, auto); draw(); });
  folderSel.addEventListener('change', draw);
  versionIn.addEventListener('input', draw);

  goBtn.addEventListener('click', () => act(goBtn, async () => {
    errorBox.hidden = true;
    ctx.view.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const appId = folderSel.value;
    const v = versionIn.value.trim();
    const p = picker.get();
    if (!appId) { folderSel.setAttribute('aria-invalid', 'true'); folderSel.focus(); throw new ApiError('Choose a folder.', 400); }
    if (picker.reading()) throw new ApiError('The file is still being read. Try again in a moment.', 0);
    if (!p) throw new ApiError('Choose the firmware file.', 400);
    try { parseVersion(v); } catch (err) { versionIn.setAttribute('aria-invalid', 'true'); versionIn.focus(); throw new ApiError(errorText(err), 400); }

    const form = new FormData();
    form.append('appId', appId);
    form.append('version', v);
    appendFile(form, p);
    const result = q('[data-result]');
    result.hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', 'Signing']);
    /** @type {{ blob: Blob, filename: string | null }} */
    let res;
    try {
      res = await postForm('/sign', form, { binary: true, onProgress: (f) => { run.upload(f); if (f >= 1) run.step(1); } });
    } catch (err) {
      run.fail();
      throw err;
    }
    run.done();
    last = { blob: res.blob, filename: res.filename || `${fileSafe(appId)}-${v}.bin` };
    saveBlob(last.blob, last.filename);
    result.hidden = false;
    result.innerHTML = `<div class="result">
      <div class="result-head"><span class="result-icon" data-icon="check"></span><strong>Signed: <span class="mono">${esc(last.filename)}</span></strong>
        <span class="muted">${esc(fmtBytes(last.blob.size))}</span></div>
      <p class="hint">The download has started. It is not published: nothing went into the bucket.</p>
      <div class="btn-row"><button type="button" class="btn sm" data-again data-icon="arrow-down-tray">Download again</button></div>
    </div>`;
    hydrateIcons(result);
    result.querySelector('[data-again]')?.addEventListener('click', () => { if (last) saveBlob(last.blob, last.filename); });
  }, (err) => {
    errorBox.textContent = errorText(err);
    errorBox.hidden = false;
  }));

  draw();
}
