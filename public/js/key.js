// @ts-check
// The signing key of a folder (one per App ID), on its page: the public key to copy into a
// controller's configuration, and generate / import / replace. The private key stays in the
// Worker, sealed; it leaves it once, right after Generate, in a window that has to be
// acknowledged (showBackup). Replacing asks for the App ID typed out: controllers carrying
// the old public key refuse every image signed with the new one.

import { ApiError, api, folderPath } from './api.js';
import { fmtDateTime } from './format.js';
import { $, copyButton, esc, field, hydrateIcons, saveBlob, toast } from './lib.js';
import { badge, formDialog, formValues } from './ui.js';

/**
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 * @typedef {import('./api.js').KeyBackup} KeyBackup
 */

/** A filename part for an App ID (which may hold characters Windows refuses in names). @param {string} s */
export const fileSafe = (s) => s.replace(/[\\/:*?"<>|\s]/g, '_');

/**
 * The key panel. @param {string} appId @param {KeyInfo | null} key
 */
export function keyPanel(appId, key) {
  const head = `<div class="panel-head"><h2>Signing key</h2><span class="spacer"></span>${key ? badge('Active', 'ok') : badge('None', 'warn')}</div>`;
  if (!key) {
    return `<section class="panel" id="key-panel">${head}
      <div class="notice warn">This folder has no signing key: its releases go out unsigned, and a controller with signing switched on refuses them.</div>
      <p class="text">Generate a new key pair here, or import the key this application is signed with already (the <span class="mono">private_key</span> of its .cred file, or the pipeline's <span class="mono">FW_PRIVATE_KEY_B64</span>). From then on, every release of this folder is signed.</p>
      <div class="btn-row">
        <button type="button" class="btn sm primary" data-key="generate" data-icon="key">Generate key…</button>
        <button type="button" class="btn sm" data-key="import" data-icon="arrow-up-tray">Import key…</button>
      </div>
    </section>`;
  }
  return `<section class="panel" id="key-panel">${head}
    <p class="text">Every release of this folder is signed with this key. A controller provisioned with its public key (Deployment Tool → Configuration) accepts only images signed with it.</p>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Public key</span>${copyButton('pubkey', 'public key')}</div>
      <code class="keytext" id="pubkey">${esc(key.publicKey)}</code>
    </div>
    <dl class="facts">
      <div><dt>Source</dt><dd>${key.source === 'generated' ? 'Generated in Deploy' : 'Imported'}</dd></div>
      <div><dt>Since</dt><dd>${esc(fmtDateTime(key.createdAt))}</dd></div>
      <div><dt>By</dt><dd>${esc(key.createdBy)}</dd></div>
    </dl>
    <div class="btn-row">
      <a class="btn sm" href="#/sign?app=${encodeURIComponent(appId)}" data-icon="shield-check">Sign a binary</a>
      <button type="button" class="btn sm danger" data-key="replace" data-icon="arrow-path">Replace key…</button>
    </div>
  </section>`;
}

/**
 * Wire the buttons of the key panel. `reload` draws the page again afterwards.
 * @param {HTMLElement} root @param {string} appId @param {() => Promise<unknown>} reload
 */
export function wireKeyPanel(root, appId, reload) {
  root.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', async () => {
    const what = btn.getAttribute('data-key');
    const done = what === 'generate' ? await generateKey(appId) : what === 'import' ? await importKey(appId) : await replaceKey(appId);
    if (done) await reload();
  }));
}

/** POST the key action. @param {string} appId @param {Record<string, unknown>} body @returns {Promise<KeyInfo & { backup?: KeyBackup }>} */
const postKey = (appId, body) => api('POST', `${folderPath(appId)}/key`, body);

/** @param {string} appId */
async function generateKey(appId) {
  /** @type {{ made: (KeyInfo & { backup?: KeyBackup }) | null }} */
  const out = { made: null };
  const ok = await formDialog({
    title: `Generate a signing key for ${appId}?`,
    submitLabel: 'Generate key',
    narrow: true,
    body: `<p>A new ECDSA P-256 key pair is made in the Worker and kept there, encrypted. Its private key is shown <strong>once</strong>, right after: have the password manager ready.</p>
      <p>Controllers check an image against the public key they were provisioned with, so provision this App ID's controllers with the new public key.</p>`,
    submit: async () => { out.made = await postKey(appId, { action: 'generate' }); },
  });
  if (!ok || !out.made) return false;
  if (out.made.backup) await showBackup(appId, out.made.backup);
  toast('Signing key made.');
  return true;
}

/** The fields to paste or pick a private key. */
const importFields = () => `
  ${field('Private key', (id) => `<textarea id="${id}" name="privateKey" class="mono" rows="6" spellcheck="false" autocomplete="off"
    placeholder="-----BEGIN PRIVATE KEY----- …, the base64 scalar, or a whole .cred file"></textarea>`, '',
    'PEM (PKCS#8 or SEC1), the base64 32-byte scalar, or the JSON of a .cred file with <span class="mono">private_key</span>.')}
  ${field('Or take it from a file', (id) => `<input id="${id}" type="file" data-keyfile accept=".pem,.key,.txt,.cred,.json">`)}`;

/** Read a picked key file into the textarea. @param {HTMLFormElement} form */
function wireKeyFile(form) {
  const file = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-keyfile]'));
  const text = /** @type {HTMLTextAreaElement | null} */ (form.querySelector('[name=privateKey]'));
  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f || !text) return;
    if (f.size > 64 * 1024) { toast('That file is too large to be a key file.', 'err'); file.value = ''; return; }
    text.value = (await f.text()).trim();
  });
}

/** @param {HTMLFormElement} form */
function privateKeyOf(form) {
  const key = String(formValues(form).privateKey ?? '').trim();
  if (!key) throw new ApiError('Paste the private key, or choose the file that holds it.', 400, 'privateKey');
  return key;
}

/** @param {string} appId */
async function importKey(appId) {
  const ok = await formDialog({
    title: `Import a signing key for ${appId}`,
    submitLabel: 'Import key',
    body: `<p>The key goes to the Worker, which keeps it encrypted and only signs with it; it is never shown again. Keep your own copy where it is now.</p>${importFields()}`,
    onOpen: wireKeyFile,
    submit: async (form) => postKey(appId, { action: 'import', privateKey: privateKeyOf(form) }),
  });
  if (ok) toast('Signing key imported.');
  return ok;
}

/** @param {string} appId */
async function replaceKey(appId) {
  /** @type {{ made: (KeyInfo & { backup?: KeyBackup }) | null }} */
  const out = { made: null };
  const ok = await formDialog({
    title: `Replace the signing key of ${appId}?`,
    submitLabel: 'Replace key',
    danger: true,
    body: `<div class="notice err">Controllers that carry the current public key refuse every image signed with the new key, until they are provisioned with the new public key. Replace it only when the old key is lost or leaked, or when no controller carries it yet.</div>
      <p>The current key is archived, not deleted. Releases already published stay signed with it.</p>
      <fieldset><legend>The new key</legend><div class="checks">
        <label class="check"><input type="radio" name="how" value="generate" checked> Generate a new key pair</label>
        <label class="check"><input type="radio" name="how" value="import"> Import a private key</label>
      </div></fieldset>
      <div class="dialog-body" data-import hidden>${importFields()}</div>
      ${field('Type the App ID to confirm', (id) => `<input id="${id}" name="confirm" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${esc(appId)}">`)}`,
    onOpen: (form) => {
      wireKeyFile(form);
      const part = /** @type {HTMLElement} */ (form.querySelector('[data-import]'));
      form.querySelectorAll('[name=how]').forEach((r) => r.addEventListener('change', () => { part.hidden = formValues(form).how !== 'import'; }));
    },
    submit: async (form) => {
      const v = formValues(form);
      if (String(v.confirm ?? '').trim() !== appId) throw new ApiError(`Type the App ID exactly as it is (${appId}) to confirm.`, 400, 'confirm');
      const body = v.how === 'import'
        ? { action: 'import', privateKey: privateKeyOf(form), replace: true, confirm: appId }
        : { action: 'generate', replace: true, confirm: appId };
      out.made = await postKey(appId, body);
    },
  });
  if (!ok || !out.made) return false;
  if (out.made.backup) await showBackup(appId, out.made.backup);
  toast('Signing key replaced.');
  return true;
}

/**
 * The one time a private key leaves the Worker: shown until the colleague confirms it is
 * stored. Escape and the backdrop do not close it; afterwards it is wiped from the page.
 * @param {string} appId @param {KeyBackup} backup
 * @returns {Promise<void>}
 */
export function showBackup(appId, backup) {
  /** @type {HTMLDialogElement} */
  const dialog = $('backup-dialog');
  const body = $('backup-body');
  /** @type {HTMLInputElement} */
  const ack = $('backup-ack');
  /** @type {HTMLButtonElement} */
  const done = $('backup-done');
  $('backup-title').textContent = `Store the private key of ${appId} now`;
  body.innerHTML = `
    <div class="notice warn">This is the only time Deploy shows this private key. Deploy keeps it encrypted and signs with it; store your copy now in the password manager, or as <span class="mono">private_key</span> in the application's .cred file for the Deployment Tool.</div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Private key, base64 scalar</span>${copyButton('backup-b64', 'private key as base64')}</div>
      <code class="keytext" id="backup-b64">${esc(backup.privateKeyB64)}</code>
    </div>
    <div class="key-box">
      <div class="key-head"><span class="section-label">Private key, PEM</span>${copyButton('backup-pem', 'private key as PEM')}</div>
      <pre class="keytext pem" id="backup-pem">${esc(backup.privateKeyPem.trim())}</pre>
    </div>
    <div class="btn-row"><button type="button" class="btn sm" id="backup-download" data-icon="arrow-down-tray">Download .pem</button></div>`;
  hydrateIcons(body);
  ack.checked = false;
  done.disabled = true;
  return new Promise((resolve) => {
    let finished = false;
    ack.onchange = () => { done.disabled = !ack.checked; };
    /** @type {HTMLButtonElement} */ (body.querySelector('#backup-download')).onclick = () => saveBlob(
      new Blob([`${backup.privateKeyPem.trim()}\n`], { type: 'application/x-pem-file' }), `${fileSafe(appId)}-signing-key.pem`,
    );
    done.onclick = () => { if (!ack.checked) return; finished = true; dialog.close(); };
    dialog.oncancel = (e) => { if (!finished) e.preventDefault(); };
    dialog.onclose = () => {
      if (!finished) { dialog.showModal(); return; } // closed some other way: it stays until acknowledged
      body.innerHTML = '';
      dialog.onclose = null;
      dialog.oncancel = null;
      resolve();
    };
    dialog.showModal();
  });
}
