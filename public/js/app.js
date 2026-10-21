// @ts-check
// Deploy — page shell and router.
//
// Two tabs in the hero band:
//   Status   #/                        the applications: totals, customers → folders (?q=, ?show=), New application
//            #/folders/<APP_ID>        one application: New release, releases, key, customer, controller, delete
//   Keys     #/keys                    every application's signing key: generate or import the missing ones
// The App ID in a hash is URL-encoded. The former #/publish and #/sign pages lead to the
// folder page of their ?app=, or else to Status.

import { api, errorText } from './api.js';
import { renderFolder } from './folder.js';
import { renderKeys } from './keys.js';
import { $, copyText, esc, hydrateIcons, showUser, toast } from './lib.js';
import { renderStatus } from './status.js';

/** @typedef {import('./ui.js').Ctx} Ctx */

/** Mark the tab the page belongs to. @param {string} path */
function showTab(path) {
  const tab = path === '/keys' ? 'keys' : 'status';
  document.querySelectorAll('.app-tabs [data-tab]').forEach((a) => {
    if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** @param {Ctx} ctx */
async function route(ctx) {
  const hash = location.hash.slice(1);
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (path === '/publish' || path === '/sign') {
    const app = params.get('app');
    location.replace(app ? `#/folders/${encodeURIComponent(app)}` : '#/');
    return;
  }
  const nav = ++ctx.nav; // a page still loading for an earlier navigation is dropped (ui.js stale())
  // A dialog left open (Back pressed while it was up) belongs to the page being left; the
  // private-key backup is the exception: it stays until it is acknowledged.
  document.querySelectorAll('dialog[open]').forEach((d) => { if (d.id !== 'backup-dialog') /** @type {HTMLDialogElement} */ (d).close(); });
  window.scrollTo(0, 0);
  showTab(path);
  ctx.view.innerHTML = '<div class="loading"><span class="spinner dark"></span> Loading…</div>';
  let m;
  try {
    if ((m = path.match(/^\/folders\/(.+)$/))) await renderFolder(ctx, decodeURIComponent(m[1]));
    else if (path === '/keys') await renderKeys(ctx);
    else await renderStatus(ctx, params);
  } catch (err) {
    if (nav !== ctx.nav) return;
    const back = path.startsWith('/folders/') ? '<p class="back-link"><a href="#/">Back to Deployments</a></p>' : '';
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
  // A field marked by a failed attempt (ui.js flagField) is unmarked as soon as it is edited.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.dataset.flagged) { t.removeAttribute('aria-invalid'); delete t.dataset.flagged; }
  });
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
