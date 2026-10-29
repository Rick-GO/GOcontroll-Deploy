// @ts-check
// Key generator (#/key-generator, ?app=<APP_ID> to pick the application): an ECDSA P-256 key pair
// for signing S1 firmware, made in this browser (signing.js). The window that shows it (key.js
// showKeyPair) is the only place the private key ever appears: download or copy it into 1Password.
// Its public key can be attached to an application that has none yet, from that window or, once it
// is closed, from this page; replacing an application's key is done on its page (it asks for the
// App ID typed out). Deploy keeps no private key.

import { api, errorText } from './api.js';
import { copyButton, esc, field, hydrateIcons, saveBlob, toast } from './lib.js';
import { keyFileBase, showKeyPair, shortKey } from './key.js';
import { applicationHref } from './routes.js';
import { generateKeyPair } from './signing.js';
import { controllerOf, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').Overview} Overview
 * @typedef {import('./api.js').FolderSummary} FolderSummary
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 */

/** The options of the application picker: those without a public key, S1 first. @param {FolderSummary[]} folders @param {string} chosen */
function appOptions(folders, chosen) {
  const free = folders.filter((f) => !f.publicKey);
  const label = (/** @type {FolderSummary} */ f) => {
    const { controller } = controllerOf(f);
    return `${f.appId}${controller ? ` (${controller}${f.customer ? `, ${f.customer.name}` : ''})` : f.customer ? ` (${f.customer.name})` : ''}`;
  };
  const s1 = free.filter((f) => controllerOf(f).controller === 'S1' || f.kind === 's1');
  const rest = free.filter((f) => !s1.includes(f));
  const opt = (/** @type {FolderSummary} */ f) => `<option value="${esc(f.appId)}"${f.appId === chosen ? ' selected' : ''}>${esc(label(f))}</option>`;
  return `<option value="">No application: only make the pair</option>
    ${s1.length ? `<optgroup label="S1 applications without a public key">${s1.map(opt).join('')}</optgroup>` : ''}
    ${rest.length ? `<optgroup label="Other applications without a public key">${rest.map(opt).join('')}</optgroup>` : ''}`;
}

/** @param {Ctx} ctx @param {URLSearchParams} params */
export async function renderKeyGenerator(ctx, params) {
  const nav = ctx.nav;
  setHero({
    title: 'Key generator',
    lede: 'A key pair for signing S1 firmware (ECDSA P-256), made in your browser. You keep the private key; Deploy keeps the public key with the application.',
  });
  /** @type {Overview} */
  const data = await api('GET', '/overview');
  if (stale(ctx, nav)) return;
  const folders = [...data.folders].sort((a, b) => a.appId.localeCompare(b.appId));
  const asked = params.get('app') ?? '';
  const askedFolder = folders.find((f) => f.appId === asked);
  ctx.view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>New key pair</h2></div>
      ${askedFolder?.publicKey ? `<div class="notice warn"><span class="mono">${esc(asked)}</span> has a public key already. Replacing it is done on
        <a href="${esc(applicationHref(asked))}">its page</a> (Replace…), with the App ID typed out: controllers that carry the current key refuse firmware signed with another one.</div>` : ''}
      <div class="form-grid two">
        ${field('Attach the public key to', (id) => `<select id="${id}" data-app>${appOptions(folders, asked)}</select>`, 'span-2',
          'Only applications without a public key. The public key is attached once you have stored the private key.')}
      </div>
      <div class="btn-row"><button type="button" class="btn primary" data-generate data-icon="key">Generate key pair</button></div>
      <div data-last></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>How the keys are kept</h2></div>
      <ul class="text plain-list">
        <li>The private key never leaves your browser: not when it is made, and not when a release is signed. Deploy does not keep it, cannot show it
          again and cannot sign without you. Store it in 1Password (the <span class="mono">.pem</span>, or the base64 value), or as
          <span class="mono">private_key</span> in the application's .cred file for the Deployment Tool.</li>
        <li>The public key is kept with the application: on its page to copy or download as <span class="mono">.pub</span>, for provisioning its
          controllers (Deployment Tool → Configuration).</li>
        <li>To publish a signed S1 release, New release on the application's page asks for the private key (the <span class="mono">.pem</span>, the
          base64 value or the .cred file), checks that it belongs to the public key, signs in your browser and sends only the signature.</li>
        <li>The formats are the Deployment Tool's (<span class="mono">keys.py</span>): the <span class="mono">.pem</span> is PKCS#8, the
          <span class="mono">.pub</span> holds the 130 hex characters of the public key, the base64 value is the CI pipeline's
          <span class="mono">FW_PRIVATE_KEY_B64</span>.</li>
        <li>Linux packages (M1, L4, HMI1) are not signed. A public key can still be attached to such an application, for provisioning.</li>
        <li>Keys made in Deploy before 0.7.0 also hold their private key, sealed in Deploy; it is no longer used to sign.</li>
      </ul>
    </section>`;
  hydrateIcons(ctx.view);

  const select = /** @type {HTMLSelectElement} */ (ctx.view.querySelector('[data-app]'));
  const last = /** @type {HTMLElement} */ (ctx.view.querySelector('[data-last]'));
  const button = /** @type {HTMLButtonElement} */ (ctx.view.querySelector('[data-generate]'));

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const appId = select.value || null;
      const pair = await generateKeyPair();
      /** @type {string | null} */
      let attachedTo = null;
      const { key: made, stored } = await showKeyPair({
        pair,
        appId,
        attach: appId ? async (p) => {
          const key = /** @type {KeyInfo} */ (await api('PUT', `/folders/${encodeURIComponent(appId)}/key`, { publicKey: p.publicHex }));
          attachedTo = appId;
          return key;
        } : undefined,
      });
      if (stale(ctx, nav)) return;
      if (made && attachedTo) {
        toast(`Public key attached to ${attachedTo}.`);
        last.innerHTML = `<div class="notice ok">The public key <span class="mono">${esc(shortKey(made.publicKey))}</span> is attached to
          <a href="${esc(applicationHref(attachedTo))}">${esc(attachedTo)}</a>.</div>`;
        select.querySelector(`option[value="${CSS.escape(attachedTo)}"]`)?.remove();
        select.value = '';
        return;
      }
      if (!stored) {
        last.innerHTML = '<div class="notice warn">That key pair was closed without its private key being stored, so it is gone. Generate a new one when you are ready to store it.</div>';
        return;
      }
      showLast(last, pair.publicHex, folders, select);
    } catch (err) {
      toast(errorText(err), 'err');
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * After the window closed without attaching: the public key of that pair, to copy, download or
 * attach to an application now (the private key is gone from the page).
 * @param {HTMLElement} el @param {string} publicHex @param {FolderSummary[]} folders @param {HTMLSelectElement} picker
 */
function showLast(el, publicHex, folders, picker) {
  el.innerHTML = `<div class="key-box">
      <div class="key-head"><span class="section-label">Public key of the pair you just made</span>${copyButton('keygen-last', 'public key')}</div>
      <code class="keytext" id="keygen-last">${esc(publicHex)}</code>
    </div>
    <p class="hint">The private key is no longer on this page. Attach this public key only if you stored its private key.</p>
    <div class="form-grid two">
      ${field('Attach it to', (id) => `<select id="${id}" data-last-app>${appOptions(folders.filter((f) => [...picker.options].some((o) => o.value === f.appId)), '')}</select>`)}
    </div>
    <div class="btn-row">
      <button type="button" class="btn sm" data-last-attach data-icon="arrow-up-tray">Attach</button>
      <button type="button" class="btn sm" data-last-save data-icon="arrow-down-tray">Download .pub</button>
    </div>`;
  hydrateIcons(el);
  const sel = /** @type {HTMLSelectElement} */ (el.querySelector('[data-last-app]'));
  el.querySelector('[data-last-save]')?.addEventListener('click', () => saveBlob(new Blob([`${publicHex}\n`], { type: 'text/plain' }), `${keyFileBase(sel.value || null)}.pub`));
  el.querySelector('[data-last-attach]')?.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    const appId = sel.value;
    if (!appId) { toast('Choose the application first.', 'err'); return; }
    btn.disabled = true;
    try {
      await api('PUT', `/folders/${encodeURIComponent(appId)}/key`, { publicKey: publicHex });
      toast(`Public key attached to ${appId}.`);
      picker.querySelector(`option[value="${CSS.escape(appId)}"]`)?.remove();
      el.innerHTML = `<div class="notice ok">The public key <span class="mono">${esc(shortKey(publicHex))}</span> is attached to
        <a href="${esc(applicationHref(appId))}">${esc(appId)}</a>.</div>`;
    } catch (err) {
      toast(errorText(err), 'err');
      btn.disabled = false;
    }
  });
}
