// @ts-check
// Deploy — page shell and router.
//
// Three tabs in the hero band:
//   Status   #/                        the deployments: totals, customers → folders (?q=, ?show=)
//            #/folders/<APP_ID>        one folder: releases, signing key, customer, controllers, downloads
//   Publish  #/publish?app=<APP_ID>    publish a release into a folder (new or existing)
//   Sign     #/sign?app=<APP_ID>       sign a binary with a folder's key and download it
// The App ID in a hash is URL-encoded.

import { api, errorText } from './api.js';
import { renderFolder } from './folder.js';
import { $, copyText, esc, hydrateIcons, showUser, toast } from './lib.js';
import { renderPublish } from './publish.js';
import { renderSign } from './sign.js';
import { renderStatus } from './status.js';

/** @typedef {import('./ui.js').Ctx} Ctx */

/** Mark the tab the page belongs to. @param {string} path */
function showTab(path) {
  const tab = path.startsWith('/publish') ? 'publish' : path.startsWith('/sign') ? 'sign' : 'status';
  document.querySelectorAll('.app-tabs [data-tab]').forEach((a) => {
    if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  return tab;
}

/** @param {Ctx} ctx */
async function route(ctx) {
  const hash = location.hash.slice(1);
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  const nav = ++ctx.nav; // a page still loading for an earlier navigation is dropped (ui.js stale())
  // A dialog left open (Back pressed while it was up) belongs to the page being left; the
  // private-key backup is the exception: it stays until it is acknowledged.
  document.querySelectorAll('dialog[open]').forEach((d) => { if (d.id !== 'backup-dialog') /** @type {HTMLDialogElement} */ (d).close(); });
  window.scrollTo(0, 0);
  const tab = showTab(path);
  ctx.view.innerHTML = '<div class="loading"><span class="spinner dark"></span> Loading…</div>';
  let m;
  try {
    if ((m = path.match(/^\/folders\/(.+)$/))) await renderFolder(ctx, decodeURIComponent(m[1]));
    else if (path === '/publish') await renderPublish(ctx, params);
    else if (path === '/sign') await renderSign(ctx, params);
    else await renderStatus(ctx, params);
  } catch (err) {
    if (nav !== ctx.nav) return;
    const back = tab === 'status' && path !== '/' && path !== '' ? '<p class="back-link"><a href="#/">Back to Deployments</a></p>' : '';
    ctx.view.innerHTML = `<div class="panel"><div class="notice err">${esc(errorText(err))}</div>${back}</div>`;
  }
  if (nav === ctx.nav) hydrateIcons(ctx.view);
}

async function main() {
  hydrateIcons();
  // Anything that fails without its own handling still tells the colleague.
  window.addEventListener('unhandledrejection', (e) => toast(errorText(e.reason), 'err'));
  // A file dropped next to a drop zone would otherwise open in the tab, leaving the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // A field marked by a failed attempt is unmarked as soon as it is edited.
  document.addEventListener('input', (e) => { if (e.target instanceof HTMLElement) e.target.removeAttribute('aria-invalid'); });
  // Every Copy button (lib.js copyButton) copies the text of the element it names.
  document.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-copy-from]');
    if (!(btn instanceof HTMLElement)) return;
    const from = document.getElementById(btn.getAttribute('data-copy-from') ?? '');
    if (from) copyText((from.textContent ?? '').trim(), btn);
  });
  const view = $('view');
  const me = await api('GET', '/me');
  showUser(me);
  /** @type {Ctx} */
  const ctx = { me, view, nav: 0 };
  window.addEventListener('hashchange', () => route(ctx));
  await route(ctx);
}

main().catch((err) => {
  $('view').innerHTML = `<div class="panel"><div class="notice err">${esc(errorText(err))}</div></div>`;
});
