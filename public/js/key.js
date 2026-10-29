// @ts-check
// The public key of an application (one per App ID), and key pairs made in this browser.
//   keyPanel / wireKeyPanel  the Public key card on an application's page: the key to copy or download
//                            (.pub) for provisioning a controller, Generate key pair…, Attach a public key…,
//                            Replace…
//   showKeyPair              the window with a new pair: the private key to store (download .pem, copy),
//                            the public key, and Attach to <APP_ID> once the private key is stored
//   generateFor / attachKey  a new pair for one application / a public key it has already (pasted, a .pub
//                            file, or the key its signed releases carry)
// Since 0.7.0 Deploy keeps only the public key: the private key is made here (signing.js), shown
// once, and is the colleague's to keep (1Password, the application's .cred file). Replacing a public
// key asks for the App ID typed out: controllers carrying the old one refuse every image signed with
// the new one; the old one is archived, not deleted.

import { ApiError, api, errorText, folderPath } from './api.js';
import { fmtDateTime } from './format.js';
import { $, copyButton, esc, field, hydrateIcons, icon, saveBlob, toast } from './lib.js';
import { KeyError, generateKeyPair, keyPairFiles, readPublicKey } from './signing.js';
import { badge, formDialog, formValues } from './ui.js';

/**
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 * @typedef {import('./signing.js').KeyPair} KeyPair
 */

/** A filename part for an App ID (which may hold characters Windows refuses in names). @param {string} s */
export const fileSafe = (s) => s.replace(/[\\/:*?"<>|\s]/g, '_');

/** "043A6B68B705…9C1D2E3F" @param {string} hex */
export const shortKey = (hex) => (hex.length > 24 ? `${hex.slice(0, 12)}…${hex.slice(-8)}` : hex);

/** The base name of a key pair's files: <APP_ID>-signing-key, or firmware-signing-key-<time> without one. @param {string | null} appId */
export const keyFileBase = (appId) => (appId
  ? `${fileSafe(appId)}-signing-key`
  : `firmware-signing-key-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`);

/** Where a public key came from, in words. @param {KeyInfo} key */
const sourceText = (key) => ({
  generated: 'Generated in Deploy before 0.7.0',
  imported: 'Imported into Deploy before 0.7.0',
  attached: 'Attached (the private key is not in Deploy)',
})[key.source] ?? key.source;

/** Save the public key as keys.py writes it (<base>.pub: the hex and a newline). @param {string} publicHex @param {string} appId */
const savePublicKey = (publicHex, appId) => saveBlob(new Blob([`${publicHex}\n`], { type: 'text/plain' }), `${keyFileBase(appId)}.pub`);

/**
 * The Public key card of an application's page.
 * @param {KeyInfo | null} key
 * @param {{ linux: boolean, releaseKeys: string[] }} opts
 *   linux: a Linux application (not signed; the key is kept for provisioning);
 *   releaseKeys: public keys in the headers of its signed releases that are not this key
 */
export function keyPanel(key, opts) {
  const head = `<div class="panel-head"><h2>Public key</h2><span class="spacer"></span>${key ? badge('Attached', 'ok') : badge('None', opts.linux ? 'muted' : 'warn')}</div>`;
  const others = opts.releaseKeys.length ? `<div class="notice err">The releases of this application are signed with ${opts.releaseKeys.length === 1 ? 'another key' : 'other keys'}:
      ${opts.releaseKeys.map((k) => `<span class="mono" title="${esc(k)}">${esc(shortKey(k))}</span>`).join(', ')}. Controllers provisioned with ${opts.releaseKeys.length === 1 ? 'that key' : 'those keys'}
      refuse firmware signed with ${key ? 'this one' : 'any other key'}. If that is the key of this application, attach it${key ? ' instead (Replace…)' : ''}.</div>` : '';
  if (!key) {
    return `<section class="panel" id="key-panel">${head}${others}
      ${opts.linux
        ? '<p class="text">Linux packages are not signed (go-deploy checks their SHA-256). A public key can be kept here anyway, for provisioning the controllers of this App ID.</p>'
        : `<div class="notice warn">This application has no public key: its releases go out unsigned, and a controller with signing switched on refuses them.</div>
      <p class="text">Generate a key pair (made in your browser: you keep the private key, Deploy keeps the public key), or attach the public key of the pair
        this application is signed with already (the <span class="mono">.pub</span> file, or the key its signed releases carry). From then on every release is signed,
        with the private key you give when you publish.</p>`}
      <div class="btn-row">
        <button type="button" class="btn sm primary" data-key="generate" data-icon="key">Generate key pair…</button>
        <button type="button" class="btn sm" data-key="attach" data-icon="arrow-up-tray">Attach a public key…</button>
      </div>
    </section>`;
  }
  return `<section class="panel" id="key-panel">${head}${others}
    <p class="text">${opts.linux
      ? 'Kept for provisioning: Linux packages are not signed.'
      : 'Every release of this application is signed with the private key that belongs to this public key; New release asks for that private key and signs in your browser. A controller provisioned with this public key (Deployment Tool → Configuration) accepts only images signed with it.'}</p>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Public key</span>${copyButton('pubkey', 'public key')}</div>
      <code class="keytext" id="pubkey">${esc(key.publicKey)}</code>
    </div>
    ${key.sealedPrivateKey ? `<div class="notice warn">This key was made in Deploy before 0.7.0, and Deploy still holds its private key, sealed. Deploy no longer signs
      with it: publishing a signed release asks for the private key you stored when the key was made.</div>` : ''}
    <dl class="facts">
      <div><dt>Source</dt><dd>${esc(sourceText(key))}</dd></div>
      <div><dt>Since</dt><dd>${esc(fmtDateTime(key.createdAt))}</dd></div>
      <div><dt>By</dt><dd>${esc(key.createdBy)}</dd></div>
    </dl>
    <div class="btn-row">
      <button type="button" class="btn sm" data-key="download" data-icon="arrow-down-tray">Download .pub</button>
      <button type="button" class="btn sm danger" data-key="replace" data-icon="arrow-path">Replace…</button>
    </div>
  </section>`;
}

/**
 * Wire the buttons of the key card; onKey gets the key once one is attached or replaced.
 * @param {HTMLElement} root @param {string} appId @param {KeyInfo | null} key @param {string[]} releaseKeys
 * @param {(key: KeyInfo) => unknown} onKey
 */
export function wireKeyPanel(root, appId, key, releaseKeys, onKey) {
  root.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', async () => {
    const what = btn.getAttribute('data-key');
    if (what === 'download' && key) { savePublicKey(key.publicKey, appId); return; }
    if (what === 'replace') {
      const how = await replaceChoice(appId);
      if (!how) return;
      const made = how.generate ? await generateFor(appId, how.confirm) : await attachKey(appId, { current: key, releaseKeys, confirm: how.confirm });
      if (made) await onKey(made);
      return;
    }
    const made = what === 'generate' ? await generateFor(appId, null) : await attachKey(appId, { current: null, releaseKeys, confirm: null });
    if (made) await onKey(made);
  }));
}

/** PUT the public key. @param {string} appId @param {string} publicKey @param {string | null} confirm  the App ID typed, to replace */
const putKey = (appId, publicKey, confirm) => /** @type {Promise<KeyInfo>} */ (api('PUT', `${folderPath(appId)}/key`, {
  publicKey, ...(confirm ? { replace: true, confirm } : {}),
}));

/**
 * Before replacing: the warning, the App ID typed out, and how the new key comes (a new pair, or a
 * public key there is already). @param {string} appId
 * @returns {Promise<{ generate: boolean, confirm: string } | null>}
 */
async function replaceChoice(appId) {
  /** @type {{ v: { generate: boolean, confirm: string } | null }} */
  const out = { v: null };
  const ok = await formDialog({
    title: `Replace the public key of ${appId}?`,
    submitLabel: 'Next',
    danger: true,
    body: `<div class="notice err">Controllers that carry the current public key refuse every image signed with the new key, until they are provisioned with the new public key. Replace it only when its private key is lost or leaked, when it is the wrong key, or when no controller carries it yet.</div>
      <p>The current key is archived, not deleted. Releases already published stay signed with it.</p>
      <fieldset><legend>The new key</legend><div class="checks">
        <label class="check"><input type="radio" name="how" value="generate" checked> Generate a new key pair</label>
        <label class="check"><input type="radio" name="how" value="attach"> Attach a public key there is already</label>
      </div></fieldset>
      ${field('Type the App ID to confirm', (id) => `<input id="${id}" name="confirm" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${esc(appId)}">`)}`,
    valid: (form) => String(formValues(form).confirm ?? '').trim() === appId,
    submit: async (form) => {
      const v = formValues(form);
      if (String(v.confirm ?? '').trim() !== appId) throw new ApiError(`Type the App ID exactly as it is (${appId}) to confirm.`, 400, 'confirm');
      out.v = { generate: v.how !== 'attach', confirm: appId };
    },
  });
  return ok ? out.v : null;
}

/**
 * A new key pair for one application, attached from the key pair window once its private key is
 * stored. @param {string} appId @param {string | null} confirm  the App ID typed, when it replaces a key
 * @returns {Promise<KeyInfo | null>}  null when closed without attaching
 */
export async function generateFor(appId, confirm) {
  const pair = await generateKeyPair();
  const { key } = await showKeyPair({ pair, appId, attach: (p) => putKey(appId, p.publicHex, confirm) });
  if (key) toast(confirm ? 'Public key replaced.' : 'Public key attached.');
  return key;
}

/**
 * Attach a public key there is already: pasted, from a .pub file (or deploy/metadata.json), or
 * one the signed releases carry.
 * @param {string} appId
 * @param {{ current: KeyInfo | null, releaseKeys: string[], confirm: string | null }} opts
 * @returns {Promise<KeyInfo | null>}  null when cancelled
 */
export async function attachKey(appId, opts) {
  /** @type {{ made: KeyInfo | null }} */
  const out = { made: null };
  const fromReleases = opts.releaseKeys.filter((k) => k !== opts.current?.publicKey);
  const ok = await formDialog({
    title: opts.current ? `The new public key of ${appId}` : `Attach a public key to ${appId}`,
    submitLabel: opts.current ? 'Replace public key' : 'Attach public key',
    danger: Boolean(opts.current),
    body: `<p>Only the public key: the private key stays with you. It is the key of a pair made before (the <span class="mono">.pub</span> file
        <span class="mono">s1_ble.py keygen</span> and the Key generator write, or <span class="mono">public_key</span> in <span class="mono">deploy/metadata.json</span>).</p>
      ${fromReleases.length ? `<fieldset><legend>Which key</legend><div class="choices">
        ${fromReleases.map((k, i) => `<label class="check"><input type="radio" name="pick" value="${esc(k)}"${i === 0 ? ' checked' : ''}>
          <span>The key the releases of ${esc(appId)} are signed with: <span class="mono">${esc(k)}</span></span></label>`).join('')}
        <label class="check"><input type="radio" name="pick" value=""> Another one, pasted or from a file</label>
      </div></fieldset>` : ''}
      <div class="dialog-body" data-own${fromReleases.length ? ' hidden' : ''}>
        ${field('Public key', (id) => `<textarea id="${id}" name="publicKey" class="mono" rows="3" spellcheck="false" autocomplete="off"
          placeholder="04…, 130 hex characters"></textarea>`, '', '130 hex characters, starting with 04.')}
        ${field('Or take it from a file', (id) => `<input id="${id}" type="file" data-pubfile accept=".pub,.txt,.json,.hex">`)}
      </div>`,
    onOpen: (form) => {
      const own = /** @type {HTMLElement} */ (form.querySelector('[data-own]'));
      form.querySelectorAll('[name=pick]').forEach((r) => r.addEventListener('change', () => { own.hidden = Boolean(formValues(form).pick); }));
      const file = /** @type {HTMLInputElement} */ (form.querySelector('[data-pubfile]'));
      const text = /** @type {HTMLTextAreaElement} */ (form.querySelector('[name=publicKey]'));
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        if (f.size > 16 * 1024) { toast('That file is too large to be a public key.', 'err'); file.value = ''; return; }
        text.value = (await f.text()).trim();
      });
    },
    submit: async (form) => {
      const v = formValues(form);
      let publicKey;
      try {
        publicKey = readPublicKey(String(v.pick || v.publicKey || ''));
      } catch (err) {
        if (err instanceof KeyError) throw new ApiError(err.message, 422, 'publicKey');
        throw err;
      }
      out.made = await putKey(appId, publicKey, opts.confirm);
    },
  });
  if (!ok || !out.made) return null;
  toast(opts.current ? 'Public key replaced.' : 'Public key attached.');
  return out.made;
}

/**
 * The window with a key pair made in this browser. The private key is shown here and nowhere else:
 * download the .pem (and the .pub), or copy the base64 value, into 1Password or the application's
 * .cred file. Close, the x and Escape close it; while the pair is neither downloaded nor marked as
 * stored, closing asks first. With `attach`, Attach to <APP_ID> sends the public key (never the
 * private key) once the private key is marked as stored.
 * @param {{ pair: KeyPair, appId: string | null, attach?: (pair: KeyPair) => Promise<KeyInfo> }} opts
 * @returns {Promise<{ key: KeyInfo | null, stored: boolean }>}  key: the attached key, or null;
 *   stored: whether the private key was downloaded or marked as stored before the window closed
 */
export function showKeyPair(opts) {
  /** @type {HTMLDialogElement} */
  const dialog = $('keypair-dialog');
  /** @type {HTMLElement} */
  const body = $('keypair-body');
  /** @type {HTMLElement} */
  const leave = $('keypair-leave');
  const error = $('keypair-error');
  /** @type {HTMLInputElement} */
  const ack = $('keypair-ack');
  /** @type {HTMLButtonElement} */
  const attachBtn = $('keypair-attach');
  const appId = opts.appId;
  const base = keyFileBase(appId);
  const [pemFile, pubFile] = keyPairFiles(opts.pair, base);

  $('keypair-title').textContent = appId ? `A new key pair for ${appId}` : 'A new key pair';
  body.innerHTML = `
    <div class="notice warn">Made in this browser. Deploy does not keep the private key and cannot show it again: store it now, in 1Password
      (the .pem as a document, or the base64 value as a password), or as <span class="mono">private_key</span> in the application's .cred file for the
      Deployment Tool. You need it every time a release is signed.</div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Public key</span>${copyButton('keypair-pub', 'public key')}</div>
      <code class="keytext" id="keypair-pub">${esc(opts.pair.publicHex)}</code>
    </div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Private key, base64 (FW_PRIVATE_KEY_B64)</span>${copyButton('keypair-b64', 'private key as base64')}</div>
      <code class="keytext" id="keypair-b64">${esc(opts.pair.privateB64)}</code>
    </div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Private key, PEM</span>${copyButton('keypair-pem', 'private key as PEM')}</div>
      <pre class="keytext pem" id="keypair-pem">${esc(opts.pair.privatePem.trim())}</pre>
    </div>
    <div class="btn-row">
      <button type="button" class="btn sm primary" data-save="pem" data-icon="arrow-down-tray">Download private key (${esc(pemFile.name)})</button>
      <button type="button" class="btn sm" data-save="pub" data-icon="arrow-down-tray">Download public key (${esc(pubFile.name)})</button>
    </div>
    <p class="hint">The files of <span class="mono">s1_ble.py keygen --out ${esc(pemFile.name)}</span>: the private key as PKCS#8 PEM, and the public key (130 hex characters).
      The Deployment Tool and Deploy read either form of the private key, and a .cred file with it.</p>`;
  hydrateIcons(body);
  leave.hidden = true;
  error.hidden = true;
  ack.checked = false;
  attachBtn.hidden = !opts.attach;
  attachBtn.disabled = true;
  attachBtn.textContent = appId ? `Attach to ${appId}` : 'Attach';

  let downloaded = false;
  /** @type {KeyInfo | null} */
  let attached = null;
  const stored = () => downloaded || ack.checked;

  return new Promise((resolve) => {
    const finish = () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      for (const id of ['keypair-x', 'keypair-close', 'keypair-stay', 'keypair-discard', 'keypair-attach']) $(id).onclick = null;
      ack.onchange = null;
      body.innerHTML = ''; // the private key leaves the page with the window
      leave.hidden = true;
      error.hidden = true;
      resolve({ key: attached, stored: stored() });
    };
    /** Close, or first ask when the private key is not stored yet. @param {boolean} [force] */
    const tryClose = (force = false) => {
      if (force || attached || stored() || !leave.hidden) { leave.hidden = true; dialog.close(); return; }
      leave.hidden = false;
      /** @type {HTMLElement} */ ($('keypair-stay')).focus();
    };
    /**
     * Escape: ask first (a second Escape, with the question showing, closes). The browser may close
     * a dialog on Escape anyway (no user activation since it opened); then it is closed as with x.
     * @param {Event} e
     */
    const onCancel = (e) => { e.preventDefault(); tryClose(); };
    const onClose = () => finish();
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    $('keypair-x').onclick = () => tryClose();
    $('keypair-close').onclick = () => tryClose();
    $('keypair-stay').onclick = () => { leave.hidden = true; };
    $('keypair-discard').onclick = () => tryClose(true);
    ack.onchange = () => { attachBtn.disabled = !ack.checked; if (stored()) leave.hidden = true; };
    body.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
      const file = b.getAttribute('data-save') === 'pem' ? pemFile : pubFile;
      saveBlob(new Blob([file.text], { type: file.type }), file.name);
      if (file === pemFile) { downloaded = true; leave.hidden = true; }
    }));
    attachBtn.onclick = async () => {
      if (!opts.attach || !ack.checked) return;
      error.hidden = true;
      attachBtn.disabled = true;
      attachBtn.setAttribute('aria-busy', 'true');
      try {
        attached = await opts.attach(opts.pair);
        dialog.close();
      } catch (err) {
        error.textContent = errorText(err);
        error.hidden = false;
      } finally {
        attachBtn.removeAttribute('aria-busy');
        attachBtn.disabled = !ack.checked;
      }
    };
    dialog.showModal();
  });
}

/** The icon of a key check (✓ or !) for markup. @param {boolean} ok */
export const checkIcon = (ok) => icon(ok ? 'check' : 'x', 18);
