// @ts-check
// Keys (#/keys): the signing key of every application. Those with a key: App ID, customer,
// controller, the public key (short, with Copy for the whole), who made it and when, and
// whether it was generated here or imported. Those without one (S1 applications): Generate
// or Import, with the same one-time backup window as on the folder page (key.js). How the
// private keys are kept stands at the bottom.

import { api } from './api.js';
import { fmtDateTime } from './format.js';
import { copyButton, esc, hydrateIcons } from './lib.js';
import { generateKey, importKey } from './key.js';
import { badge, controllerBadge, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').KeyList} KeyList
 * @typedef {import('./api.js').FolderCustomer} FolderCustomer
 */

/** "04A1B2C3D4…F60718" @param {string} hex */
const shortKey = (hex) => (hex.length > 24 ? `${hex.slice(0, 12)}…${hex.slice(-8)}` : hex);

/** @param {string} appId */
const folderLink = (appId) => `<a class="cell-main mono" href="#/folders/${encodeURIComponent(appId)}">${esc(appId)}</a>`;

/** @param {FolderCustomer | null} c */
const customerCell = (c) => (c ? esc(c.name) : '<span class="muted">—</span>');

/** @param {Ctx} ctx */
export async function renderKeys(ctx) {
  const nav = ctx.nav;
  setHero({
    title: 'Signing keys',
    lede: 'One ECDSA P-256 key per application. Controllers provisioned with its public key install only images signed with it.',
  });
  /** @type {KeyList} */
  const data = await api('GET', '/keys');
  if (stale(ctx, nav)) return;
  const keys = [...(data.keys ?? [])].sort((a, b) => a.appId.localeCompare(b.appId));
  const without = [...(data.withoutKey ?? [])].sort((a, b) => a.appId.localeCompare(b.appId));
  ctx.view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Applications with a key</h2><span class="sub">${keys.length}</span></div>
      ${keys.length ? `<div class="table-wrap"><table class="data cards keys">
        <thead><tr><th>App ID</th><th>Customer</th><th>Controller</th><th>Public key</th><th>Made</th><th>Source</th></tr></thead>
        <tbody>${keys.map((k, i) => `<tr>
          <td data-label="App ID">${folderLink(k.appId)}${k.inBucket ? '' : `<div class="cell-sub">${badge('Not in the bucket yet', 'muted', 'No file of this application is in the bucket: its first release creates the folder')}</div>`}</td>
          <td data-label="Customer">${customerCell(k.customer)}</td>
          <td data-label="Controller">${controllerBadge(k.controller)}</td>
          <td data-label="Public key"><span class="keycell"><span class="mono" title="${esc(k.publicKey)}">${esc(shortKey(k.publicKey))}</span>
            ${copyButton(`keys-pk-${i}`, `public key of ${k.appId}`)}<span id="keys-pk-${i}" hidden>${esc(k.publicKey)}</span></span></td>
          <td data-label="Made">${esc(fmtDateTime(k.createdAt))}<div class="cell-sub">${esc(k.createdBy)}</div></td>
          <td data-label="Source">${k.source === 'generated' ? 'Generated in Deploy' : 'Imported'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No application has a signing key yet.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Applications without a key</h2><span class="sub">S1 applications, whose releases go out unsigned until they have one</span></div>
      ${without.length ? `<div class="table-wrap"><table class="data cards keys-missing">
        <thead><tr><th>App ID</th><th>Customer</th><th>Controller</th><th>Key</th></tr></thead>
        <tbody>${without.map((w) => `<tr>
          <td data-label="App ID">${folderLink(w.appId)}</td>
          <td data-label="Customer">${customerCell(w.customer)}</td>
          <td data-label="Controller">${controllerBadge(w.controller)}</td>
          <td data-label="Key"><span class="cell-btns">
            <button type="button" class="btn sm primary" data-gen="${esc(w.appId)}" data-icon="key">Generate…</button>
            <button type="button" class="btn sm" data-imp="${esc(w.appId)}" data-icon="arrow-up-tray">Import…</button></span></td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Every S1 application has a signing key.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Where the keys are kept</h2></div>
      <p class="text">Each private key is encrypted with Deploy's master key (in the Cloudflare Secrets Store) and stored in the private bucket
        <span class="mono">gocontroll-deploy-state</span>. Deploy only signs with it and never shows it again; a generated private key is shown
        once, right after it is made, for your offline backup (the password manager, or the application's .cred file). Replacing a key is done
        on the application's page, and archives the old one.</p>
      <p class="text">Linux packages (M1, L4, HMI1) are not signed: go-deploy checks the SHA-256 of the tarball and of every file only, so those applications have no key here.</p>
    </section>`;
  hydrateIcons(ctx.view);
  const after = async (/** @type {Promise<unknown>} */ made) => { if (await made) await renderKeys(ctx); };
  ctx.view.querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', () => after(generateKey(/** @type {string} */ (b.getAttribute('data-gen'))))));
  ctx.view.querySelectorAll('[data-imp]').forEach((b) => b.addEventListener('click', () => after(importKey(/** @type {string} */ (b.getAttribute('data-imp'))))));
}
