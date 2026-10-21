// @ts-check
// New release, on the folder page of an S1 application, in three steps:
//   1 File     pick or drop the .bin / S-record / GOCO container; read and compressed in the
//              browser (picker.js); the version from its name or container header, typed wins.
//   2 Sign     the folder's public key with Copy; signing on and locked when there is a key.
//              Without one: generate (or import) it right here, or tick "publish unsigned".
//   3 Publish  what changed (mandatory) next to what the manifest holds now; a version that is
//              published already takes a deliberate yes (Replace…), one below latest is said out
//              loud. Progress, then the binary URL. Or "Download signed file instead"
//              (POST /api/sign) for a local upload with the Deployment Tool: nothing published.
// The rules are the Deployment Tool's (README "Publishing a release", "Replacing a published
// version takes a deliberate yes", "The version comes from the filename"). The Worker builds
// and signs the container, writes the binary first and the manifest second, and checks again.

import { ApiError, errorText, postForm } from './api.js';
import { fmtBytes, fmtDay } from './format.js';
import { act, copyButton, esc, field, hydrateIcons, saveBlob } from './lib.js';
import { fileSafe, generateKey, importKey } from './key.js';
import { DEFAULT_DISTRIBUTION_URLS } from './newapp.js';
import { appendFile, mountFilePicker, prefillVersion } from './picker.js';
import { compareVersions, parseVersion } from './source.js';
import { badge, confirmDialog, flagField, runSteps } from './ui.js';

/**
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 * @typedef {import('./api.js').PublishResult} PublishResult
 */

/** @param {number} n @param {string} title */
const stepHead = (n, title) => `<div class="flow-head"><span class="flow-num" aria-hidden="true">${n}</span>
  <h3>${esc(title)}</h3><span class="flow-state" data-state></span></div>`;

/**
 * Fill the New release card.
 * @param {HTMLElement} el  the card (a .panel)
 * @param {{ detail: FolderDetail, published?: PublishResult | null,
 *   onKey: (key: KeyInfo) => unknown, onPublished: (res: PublishResult) => unknown }} opts
 *   published: the release this page just published, shown on top; onKey: a key was made here
 * @returns {{ setKey: (key: KeyInfo | null) => void }}  for a key made elsewhere on the page
 */
export function mountRelease(el, opts) {
  const d = opts.detail;
  const appId = d.appId;
  /** @type {KeyInfo | null} */
  let key = d.key;
  const releases = [...(d.releases ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  const latestRel = releases.find((r) => r.version === d.latest) ?? releases[0] ?? null;
  // The host comes from the manifest, or from New application; only a folder with neither asks.
  const needsHost = !d.distributionUrl && !releases.length;
  const dists = d.distributionUrls?.length ? d.distributionUrls : DEFAULT_DISTRIBUTION_URLS;

  el.innerHTML = `
    <div class="panel-head"><h2>New release</h2><span class="sub">an S1 application into <span class="mono">${esc(appId)}/</span></span></div>
    ${opts.published ? publishedCard(opts.published) : ''}
    <ol class="flow">
      <li class="flow-step" data-step="1">${stepHead(1, 'File')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 1: the firmware file</legend>
          <div data-picker></div>
          <div class="form-grid two">
            ${field('Version', (id) => `<input id="${id}" data-f="version" name="version" class="mono" inputmode="decimal" autocomplete="off" placeholder="major.minor.patch">`,
              '', '<span data-version-hint></span>')}
          </div>
        </fieldset></li>
      <li class="flow-step" data-step="2">${stepHead(2, 'Sign')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 2: signing</legend><div data-sign></div></fieldset></li>
      <li class="flow-step" data-step="3">${stepHead(3, 'Publish')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 3: publish</legend>
          ${latestRel
            ? `<p class="now">Latest now: <strong class="mono">${esc(latestRel.version)}</strong>, ${esc(fmtDay(latestRel.releaseDate))}: ${esc(latestRel.description || 'no description')}</p>`
            : '<p class="now">Nothing published yet: this release becomes the first, and latest.</p>'}
          <div class="form-grid two">
            ${needsHost ? field('Distribution host', (id) => `<select id="${id}" data-f="dist">${dists.map((u, i) => `<option value="${esc(u)}"${i === 0 ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select>`,
              'span-2', 'The binary URLs in the manifest start with it, and the controllers of this App ID carry the same one.') : ''}
            ${field('What changed', (id) => `<textarea id="${id}" data-f="description" name="description" rows="3" maxlength="500" placeholder="What this release changes"></textarea>`,
              'span-2', 'Required: the release note the manifest carries, shown next to the version.')}
          </div>
          <div data-plan></div>
          <div class="notice err" data-error hidden></div>
          <div class="btn-row">
            <button type="button" class="btn primary" data-go data-icon="cloud-arrow-up"><span data-go-label>Publish</span></button>
            <button type="button" class="btn sm" data-signonly data-icon="arrow-down-tray">Download signed file instead</button>
          </div>
          <p class="hint" data-signonly-hint></p>
          <div class="run" data-progress hidden></div>
          <div data-result hidden></div>
        </fieldset></li>
    </ol>`;
  hydrateIcons(el);

  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (el.querySelector(sel));
  const steps = [...el.querySelectorAll('.flow-step')];
  const bodies = /** @type {HTMLFieldSetElement[]} */ ([...el.querySelectorAll('[data-body]')]);
  const versionIn = /** @type {HTMLInputElement} */ (q('[data-f="version"]'));
  const descIn = /** @type {HTMLTextAreaElement} */ (q('[data-f="description"]'));
  const distSel = /** @type {HTMLSelectElement | null} */ (el.querySelector('[data-f="dist"]'));
  const errorBox = q('[data-error]');
  const goBtn = /** @type {HTMLButtonElement} */ (q('[data-go]'));
  const signBtn = /** @type {HTMLButtonElement} */ (q('[data-signonly]'));
  const st = { unsigned: false, busy: false, auto: { auto: '' } };

  const picker = mountFilePicker(q('[data-picker]'), (p) => {
    prefillVersion(versionIn, p, st.auto);
    drawSign();
    draw();
  });

  const versionOk = () => { try { parseVersion(versionIn.value.trim()); return true; } catch { return false; } };
  const fileDone = () => Boolean(picker.get()) && versionOk();
  const signDone = () => fileDone() && (Boolean(key) || st.unsigned);
  /** The release standing at the version typed, if the manifest has it. */
  const standing = () => releases.find((r) => r.version === versionIn.value.trim()) ?? null;

  /** Step 2, drawn again when the key or the file changes (not on every keystroke). */
  const drawSign = () => {
    const header = picker.get()?.source.header;
    const sign = q('[data-sign]');
    if (key) {
      sign.innerHTML = `<label class="check locked"><input type="checkbox" checked disabled> Signed with this folder's key</label>
        <div class="key-box">
          <div class="key-head"><span class="section-label">Public key</span>${copyButton('release-pubkey', 'public key')}</div>
          <code class="keytext" id="release-pubkey">${esc(key.publicKey)}</code>
        </div>
        <p class="hint">A controller provisioned with this public key accepts only images signed with it, so this folder takes signed releases only.${
          header?.signed ? ' The container is signed already: the Worker checks that it was this key.' : ''}</p>`;
    } else {
      sign.innerHTML = `<div class="notice warn">This folder has no signing key yet. Generate one now (its private key is shown once, for your backup), import the one this application is signed with, or publish unsigned.</div>
        <div class="btn-row">
          <button type="button" class="btn sm primary" data-gen data-icon="key">Generate key…</button>
          <button type="button" class="btn sm" data-imp data-icon="arrow-up-tray">Import key…</button>
        </div>
        <label class="check unsigned"><input type="checkbox" data-unsigned${st.unsigned ? ' checked' : ''}>
          Publish unsigned: a controller with signing switched on refuses this image</label>`;
      sign.querySelector('[data-unsigned]')?.addEventListener('change', (e) => { st.unsigned = /** @type {HTMLInputElement} */ (e.target).checked; draw(); });
      const take = async (/** @type {Promise<KeyInfo | null>} */ made) => {
        const k = await made;
        if (!k) return;
        key = k;
        st.unsigned = false;
        await opts.onKey(k);
        drawSign();
        draw();
      };
      sign.querySelector('[data-gen]')?.addEventListener('click', () => take(generateKey(appId)));
      sign.querySelector('[data-imp]')?.addEventListener('click', () => take(importKey(appId)));
    }
    hydrateIcons(sign);
  };

  /** Steps unlocked in turn, the version hint, the plan and the buttons. */
  const draw = () => {
    const done = [fileDone(), signDone()];
    bodies[0].disabled = st.busy;
    bodies[1].disabled = st.busy || !done[0];
    bodies[2].disabled = st.busy || !done[1];
    steps.forEach((li, i) => {
      const isDone = i < 2 ? done[i] : false;
      const locked = i > 0 && !done[i - 1];
      li.classList.toggle('done', isDone);
      li.classList.toggle('locked', locked);
      const state = /** @type {HTMLElement} */ (li.querySelector('[data-state]'));
      state.textContent = isDone ? 'Done' : locked ? `After step ${i}` : '';
    });

    const p = picker.get();
    const header = p?.source.header;
    const v = versionIn.value.trim();
    /** @type {string[]} */
    const notes = [];
    if (header && v && header.version !== v) notes.push(`The container's header says ${header.version}: the Worker refuses a version that differs from it.`);
    if (header && header.appId !== appId) notes.push(`The container's header names App ID ${header.appId}, not ${appId}: the Worker refuses it.`);
    q('[data-version-hint]').innerHTML = notes.length ? `<span class="error">${notes.map(esc).join(' ')}</span>`
      : 'Goes into the container header and names the file. A file named …_1.2.3.bin fills it in.';

    const plan = q('[data-plan]');
    const s = standing();
    if (!done[0]) {
      plan.innerHTML = '';
    } else if (s) {
      plan.innerHTML = `<div class="notice warn">Version <span class="mono">${esc(v)}</span> is published already (${esc(fmtDay(s.releaseDate))}: ${esc(s.description || 'no description')}).
        Publishing it again replaces that binary and its entry; controllers that run it keep the old image under the same number. Raise the version unless replacing is what you want.</div>`;
    } else {
      const writes = `Writes <span class="mono">${esc(appId)}/${esc(appId)}-${esc(v)}.bin</span>${key ? ', signed,' : ' <strong>unsigned</strong>'} and points <span class="mono">${esc(appId)}/manifest.json</span> at <span class="mono">${esc(v)}</span>.`;
      plan.innerHTML = d.latest && compareVersions(v, d.latest) < 0
        ? `<div class="notice warn">${writes} That moves <strong>latest</strong> back from <span class="mono">${esc(d.latest)}</span>, so a controller on update-to-latest installs this older version.</div>`
        : `<p class="hint">${writes}</p>`;
    }
    q('[data-go-label]').textContent = s ? 'Replace…' : 'Publish';
    signBtn.disabled = !key;
    q('[data-signonly-hint]').textContent = key
      ? `Or sign it without publishing: downloads ${appId}-${v || '<version>'}.bin, for a local upload with the Deployment Tool.`
      : 'Downloading a signed file needs the folder\'s signing key (step 2).';
  };

  versionIn.addEventListener('input', draw);
  descIn.addEventListener('input', draw);

  /** Check steps 1 and 2 before either action; returns the file and version. */
  const ready = () => {
    errorBox.hidden = true;
    const p = picker.get();
    if (picker.reading()) throw new ApiError('The file is still being read. Try again in a moment.', 0);
    if (!p) throw new ApiError('Choose the firmware file (step 1).', 400);
    const v = versionIn.value.trim();
    try { parseVersion(v); } catch (err) { flagField(versionIn); throw new ApiError(errorText(err), 400); }
    return { p, v };
  };
  const showErr = (/** @type {unknown} */ err) => { errorBox.textContent = errorText(err); errorBox.hidden = false; };
  /** Hold every step still while a run is on its way. @param {boolean} busy */
  const hold = (busy) => { st.busy = busy; draw(); };

  goBtn.addEventListener('click', () => act(goBtn, async () => {
    const { p, v } = ready();
    if (!key && !st.unsigned) throw new ApiError('Sign it, or tick "Publish unsigned" (step 2).', 400);
    const description = descIn.value.trim();
    if (!description) { flagField(descIn); throw new ApiError('Describe what this release changes: the manifest carries it as the release note.', 400); }
    const s = standing();
    const lower = Boolean(d.latest && compareVersions(v, d.latest) < 0);
    if (s || lower) {
      const parts = [];
      if (s) {
        parts.push(`<p>Version <span class="mono">${esc(v)}</span> is published already (${esc(fmtDay(s.releaseDate))}: ${esc(s.description || 'no description')}).
          Replacing it overwrites that binary and its entry in the manifest; the old binary is archived. Controllers that run it keep the old image, and still report the same version number.</p>`);
      }
      if (lower) parts.push(`<p><strong>latest</strong> moves back from <span class="mono">${esc(d.latest)}</span> to <span class="mono">${esc(v)}</span>: a controller on update-to-latest installs this older image.</p>`);
      if (!(await confirmDialog(s ? `Replace version ${v}?` : `Move latest back to ${v}?`, parts.join(''), s ? 'Replace' : 'Publish anyway', true))) return;
    }
    const form = new FormData();
    form.append('appId', appId);
    form.append('version', v);
    form.append('description', description);
    form.append('sign', key ? '1' : '0');
    form.append('replace', s ? '1' : '0');
    if (distSel) form.append('distributionUrl', distSel.value);
    appendFile(form, p);
    q('[data-result]').hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', key ? 'Signing, then writing the binary and the manifest' : 'Writing the binary, then the manifest']);
    hold(true);
    /** @type {PublishResult} */
    let res;
    try {
      res = await postForm('/releases', form, { onProgress: (f) => { run.upload(f); if (f >= 1) run.step(1); } });
    } catch (err) {
      run.fail();
      hold(false);
      throw err;
    }
    run.done();
    await opts.onPublished(res);
  }, showErr));

  signBtn.addEventListener('click', () => act(signBtn, async () => {
    const { p, v } = ready();
    if (!key) throw new ApiError('Downloading a signed file needs the folder\'s signing key (step 2).', 400);
    const form = new FormData();
    form.append('appId', appId);
    form.append('version', v);
    appendFile(form, p);
    const result = q('[data-result]');
    result.hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', 'Signing']);
    hold(true);
    /** @type {{ blob: Blob, filename: string | null }} */
    let res;
    try {
      res = await postForm('/sign', form, { binary: true, onProgress: (f) => { run.upload(f); if (f >= 1) run.step(1); } });
    } catch (err) {
      run.fail();
      throw err;
    } finally {
      hold(false);
    }
    run.done();
    const file = { blob: res.blob, name: res.filename || `${fileSafe(appId)}-${v}.bin` };
    saveBlob(file.blob, file.name);
    result.hidden = false;
    result.innerHTML = `<div class="result">
      <div class="result-head"><span class="result-icon" data-icon="check"></span><strong>Signed: <span class="mono">${esc(file.name)}</span></strong>
        <span class="muted">${esc(fmtBytes(file.blob.size))}</span></div>
      <p class="hint">The download has started. Nothing is published: the bucket and the manifest are as they were.</p>
      <div class="btn-row"><button type="button" class="btn sm" data-again data-icon="arrow-down-tray">Download again</button></div>
    </div>`;
    hydrateIcons(result);
    result.querySelector('[data-again]')?.addEventListener('click', () => saveBlob(file.blob, file.name));
  }, showErr));

  drawSign();
  draw();
  return {
    setKey: (k) => { key = k; if (k) st.unsigned = false; drawSign(); draw(); },
  };
}

/** The release this page just published. @param {PublishResult} r */
function publishedCard(r) {
  return `<div class="result published">
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
    </dl>
  </div>`;
}
