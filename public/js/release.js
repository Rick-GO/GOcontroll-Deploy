// @ts-check
// New release, on the page of an S1 application, in three steps:
//   1 File     pick or drop the .bin / S-record / GOCO container; read and compressed in the
//              browser (picker.js); the version from its name or container header, typed wins.
//   2 Sign     the application's public key with Copy; signing on and locked when there is one,
//              and the private key that belongs to it: pasted or from a file (.pem, the base64
//              value, a .cred file), checked right here against the public key (signing.js). It
//              stays in this browser. A container signed already needs none. Without a public key:
//              generate a pair or attach a public key right here, or tick "publish unsigned".
//   3 Publish  what changed (mandatory) next to what the manifest holds now; a version that is
//              published already takes a deliberate yes (Replace…), one below latest is said out
//              loud. Progress, then the binary URL. Or "Download signed file instead"
//              (POST /api/sign) for a local upload with the Deployment Tool: nothing published.
// Signing: the Worker gives the bytes to sign (POST /api/sign/scope, the header scope of
// src/goco.ts), this page signs them followed by the payload, and sends only the signature with
// the upload; the Worker builds the container and checks the signature against the public key
// before it writes the binary first and the manifest second. The rules are the Deployment Tool's
// (README "Publishing a release", "Replacing a published version takes a deliberate yes", "The
// version comes from the filename").

import { ApiError, api, errorText, postForm } from './api.js';
import { fmtBytes, fmtDay } from './format.js';
import { act, copyButton, esc, field, hydrateIcons, saveBlob, toast } from './lib.js';
import { attachKey, checkIcon, fileSafe, generateFor } from './key.js';
import { DEFAULT_DISTRIBUTION_URLS } from './newapp.js';
import { appendFile, mountFilePicker, prefillVersion } from './picker.js';
import { KeyError, KeyMismatchError, fromBase64, sha256Hex, signScope, signerFor, toBase64 } from './signing.js';
import { compareVersions, parseVersion } from './source.js';
import { badge, confirmDialog, flagField, runSteps } from './ui.js';

/** The longest GOCO header (0x05): the first bytes of a container hold all of it. */
const MAX_HEADER_SIZE = 211;

/**
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 * @typedef {import('./api.js').PublishResult} PublishResult
 */

/** @param {number} n @param {string} title */
const stepHead = (n, title) => `<div class="flow-head"><span class="flow-num" aria-hidden="true">${n}</span>
  <h3>${esc(title)}</h3><span class="flow-state" data-state></span></div>`;

/**
 * The signature for a picked file, made here: the Worker gives the scope (POST /api/sign/scope),
 * this browser signs scope + payload with `signer`. Only the signature leaves the page.
 * @param {string} appId @param {string} version @param {import('./picker.js').Picked} p @param {CryptoKey} signer
 * @returns {Promise<string>}  base64 of the 64-byte signature
 */
async function signHere(appId, version, p, signer) {
  const container = p.source.kind === 'container';
  const payload = container ? null : /** @type {Uint8Array} */ (p.payload);
  /** @type {{ scope: string, payloadOffset: number }} */
  const res = await api('POST', '/sign/scope', container
    ? { appId, version, containerHeader: toBase64(p.source.bytes.subarray(0, Math.min(MAX_HEADER_SIZE, p.source.bytes.length))) }
    : { appId, version, payload: { size: payload?.length ?? 0, rawSize: p.source.rawSize, sha256: await sha256Hex(/** @type {Uint8Array} */ (payload)) } });
  const signed = container ? p.source.bytes.subarray(res.payloadOffset) : /** @type {Uint8Array} */ (payload);
  return toBase64(await signScope(signer, fromBase64(res.scope), signed));
}

/**
 * Fill the New release card.
 * @param {HTMLElement} el  the card (a .panel)
 * @param {{ detail: FolderDetail, published?: PublishResult | null, releaseKeys: string[],
 *   onKey: (key: KeyInfo) => unknown, onPublished: (res: PublishResult) => unknown }} opts
 *   published: the release this page just published, shown on top; onKey: a key was attached here;
 *   releaseKeys: public keys in the headers of its signed releases that are not the application's
 * @returns {{ setKey: (key: KeyInfo | null) => void }}  for a key attached elsewhere on the page
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
  /** @type {{ unsigned: boolean, busy: boolean, auto: { auto: string }, signer: CryptoKey | null, checking: number }} */
  const st = { unsigned: false, busy: false, auto: { auto: '' }, signer: null, checking: 0 };

  const picker = mountFilePicker(q('[data-picker]'), (p) => {
    prefillVersion(versionIn, p, st.auto);
    showContainerState();
    draw();
  });

  const versionOk = () => { try { parseVersion(versionIn.value.trim()); return true; } catch { return false; } };
  const fileDone = () => Boolean(picker.get()) && versionOk();
  /** A container that is signed already goes as it is: the Worker checks that it is this key. */
  const signedAlready = () => Boolean(picker.get()?.source.header?.signed);
  const signDone = () => fileDone() && (key ? signedAlready() || Boolean(st.signer) : st.unsigned);
  /** The release standing at the version typed, if the manifest has it. */
  const standing = () => releases.find((r) => r.version === versionIn.value.trim()) ?? null;

  /**
   * Step 2, drawn again when the key changes (not when the file does: a private key typed stays).
   * With a key: the public key, and the private key field, checked as it is given.
   */
  const drawSign = () => {
    const sign = q('[data-sign]');
    st.signer = null;
    st.checking++;
    if (key) {
      const pub = key.publicKey;
      sign.innerHTML = `<label class="check locked"><input type="checkbox" checked disabled> Signed with the key of ${esc(appId)}</label>
        <div class="key-box">
          <div class="key-head"><span class="section-label">Public key</span>${copyButton('release-pubkey', 'public key')}</div>
          <code class="keytext" id="release-pubkey">${esc(pub)}</code>
        </div>
        <p class="hint" data-signed-already hidden>The container is signed already: the Worker checks that it was this key. No private key is needed.</p>
        <div data-pk-part>
          ${field('Private key', (id) => `<textarea id="${id}" data-pk class="mono" rows="4" spellcheck="false" autocomplete="off" autocapitalize="off"
            placeholder="-----BEGIN PRIVATE KEY----- …, the base64 value, or a whole .cred file"></textarea>`, '',
            'The private key of this public key: the <span class="mono">.pem</span>, the base64 value (<span class="mono">FW_PRIVATE_KEY_B64</span>) or the application\'s .cred file.')}
          ${field('Or take it from a file', (id) => `<input id="${id}" type="file" data-pkfile accept=".pem,.key,.txt,.cred,.json">`)}
          <div class="key-check" data-pk-state aria-live="polite"></div>
          <p class="hint">It stays in this browser: the page checks that it belongs to the public key above, signs here, and sends only the signature.
            Deploy keeps no private key.</p>
        </div>`;
      const text = /** @type {HTMLTextAreaElement} */ (sign.querySelector('[data-pk]'));
      const file = /** @type {HTMLInputElement} */ (sign.querySelector('[data-pkfile]'));
      const state = /** @type {HTMLElement} */ (sign.querySelector('[data-pk-state]'));
      const check = async () => {
        const mine = ++st.checking;
        st.signer = null;
        draw();
        const value = text.value.trim();
        if (!value) { state.className = 'key-check'; state.innerHTML = ''; return; }
        state.className = 'key-check';
        state.innerHTML = '<span class="spinner dark"></span> Checking the key…';
        try {
          const signer = await signerFor(value, pub, appId);
          if (mine !== st.checking) return;
          st.signer = signer;
          state.className = 'key-check ok';
          state.innerHTML = `${checkIcon(true)} This private key belongs to the public key of ${esc(appId)}.`;
        } catch (err) {
          if (mine !== st.checking) return;
          state.className = 'key-check err';
          state.innerHTML = `${checkIcon(false)} ${esc(err instanceof KeyError || err instanceof KeyMismatchError ? err.message : errorText(err))}`;
        }
        draw();
      };
      /** @type {number | undefined} */
      let timer;
      text.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(check, 250); });
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        if (f.size > 64 * 1024) { toast('That file is too large to be a key file.', 'err'); return; }
        text.value = (await f.text()).trim();
        await check();
      });
    } else {
      sign.innerHTML = `<div class="notice warn">This application has no public key yet. Generate a key pair now (you keep the private key; Deploy keeps the public key),
          attach the public key this application is signed with already, or publish unsigned.</div>
        <div class="btn-row">
          <button type="button" class="btn sm primary" data-gen data-icon="key">Generate key pair…</button>
          <button type="button" class="btn sm" data-attach data-icon="arrow-up-tray">Attach a public key…</button>
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
      sign.querySelector('[data-gen]')?.addEventListener('click', () => take(generateFor(appId, null)));
      sign.querySelector('[data-attach]')?.addEventListener('click', () => take(attachKey(appId, { current: null, releaseKeys: opts.releaseKeys, confirm: null })));
    }
    hydrateIcons(sign);
    showContainerState();
  };

  /** A container signed already needs no private key: hide the field then. */
  const showContainerState = () => {
    const already = q('[data-sign]').querySelector('[data-signed-already]');
    const part = q('[data-sign]').querySelector('[data-pk-part]');
    if (already instanceof HTMLElement) already.hidden = !signedAlready();
    if (part instanceof HTMLElement) part.hidden = signedAlready();
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
      : 'Downloading a signed file needs the application\'s public key and its private key (step 2).';
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

  /** The signature to send, made here, or null for a container signed already. @param {import('./picker.js').Picked} p @param {string} v */
  const signature = async (p, v) => {
    if (signedAlready()) return null;
    if (!st.signer) throw new ApiError(`Give the private key of ${appId} (step 2): the page signs with it here.`, 400);
    return signHere(appId, v, p, st.signer);
  };

  goBtn.addEventListener('click', () => act(goBtn, async () => {
    const { p, v } = ready();
    if (!key && !st.unsigned) throw new ApiError('Sign it, or tick "Publish unsigned" (step 2).', 400);
    if (key && !signedAlready() && !st.signer) throw new ApiError(`Give the private key of ${appId} (step 2): the page signs with it here.`, 400);
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
    form.append('replace', s ? '1' : '0');
    if (distSel) form.append('distributionUrl', distSel.value);
    if (key) {
      const sig = await signature(p, v);
      if (sig) form.append('signature', sig);
    }
    appendFile(form, p);
    q('[data-result]').hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', key ? 'Checking the signature, then writing the binary and the manifest' : 'Writing the binary, then the manifest']);
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
    if (!key) throw new ApiError('Downloading a signed file needs the application\'s public key and its private key (step 2).', 400);
    const form = new FormData();
    form.append('appId', appId);
    form.append('version', v);
    const sig = await signature(p, v);
    if (sig) form.append('signature', sig);
    appendFile(form, p);
    const result = q('[data-result]');
    result.hidden = true;
    const run = runSteps(q('[data-progress]'), ['Uploading', 'Checking the signature']);
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
