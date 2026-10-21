// @ts-check
// Status (#/): the deployments at a glance. KPI tiles; the customers with their application
// folders (App IDs); the folders no customer was found for; at the bottom New application.
// The search and the filter work on the page itself, without a reload, and stay in the
// address (#/?q=&show=) so Back returns to the same list.

import { api } from './api.js';
import { fmtBytes, fmtCount, fmtDateTime, plural } from './format.js';
import { esc, hydrateIcons } from './lib.js';
import { newApplication } from './newapp.js';
import { badge, controllerBadge, controllerOf, flavour, setHero, stale, wireRowLinks } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').Overview} Overview
 * @typedef {import('./api.js').FolderSummary} FolderSummary
 */

const FILTERS = /** @type {const} */ ([
  ['all', 'All applications'],
  ['S1', 'S1'],
  ['nokey', 'S1 without signing key'],
  ['M1', 'M1'],
  ['L4', 'L4'],
  ['HMI1', 'HMI1'],
  ['unknown', 'Controller unknown'],
]);

/** @param {Ctx} ctx @param {URLSearchParams} params */
export async function renderStatus(ctx, params) {
  const nav = ctx.nav;
  const flash = ctx.flash;
  ctx.flash = null;
  setHero({
    title: 'Deployments',
    lede: "Firmware in GOcontroll's distribution bucket, per customer and App ID: releases, signing keys, the controllers on each App ID and how often they download.",
  });
  /** @type {Overview} */
  const data = await api('GET', '/overview');
  if (stale(ctx, nav)) return;
  const show = FILTERS.some(([k]) => k === params.get('show')) ? /** @type {string} */ (params.get('show')) : 'all';
  ctx.view.innerHTML = `${flash ? `<section class="panel flash">${flash}</section>` : ''}
    ${kpis(data)}
    <section class="panel">
      <div class="table-tools">
        <label class="search"><span class="sr-only">Search</span>
          <input type="search" id="st-q" value="${esc(params.get('q') ?? '')}" placeholder="Search App ID, customer or version" autocomplete="off"></label>
        <label class="filter"><span class="sr-only">Show</span>
          <select id="st-show">${FILTERS.map(([k, label]) => `<option value="${k}"${k === show ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      </div>
      <div id="st-list"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>New application</h2></div>
      <p class="text">Start the folder of an application: its App ID, customer and controller (S1, or M1, L4 and HMI1 for Linux). Its signing key or package, and its first release, follow on its page.</p>
      <div class="btn-row"><button type="button" class="btn primary" data-new-app data-icon="plus">New application…</button></div>
    </section>`;
  hydrateIcons(ctx.view);
  const q = /** @type {HTMLInputElement} */ (ctx.view.querySelector('#st-q'));
  const sel = /** @type {HTMLSelectElement} */ (ctx.view.querySelector('#st-show'));
  const list = /** @type {HTMLElement} */ (ctx.view.querySelector('#st-list'));
  const draw = () => {
    list.innerHTML = folderLists(data, q.value.trim().toLowerCase(), sel.value);
    hydrateIcons(list);
    list.querySelectorAll('table').forEach((t) => wireRowLinks(/** @type {HTMLElement} */ (t)));
    // Keep the search in the address without a new navigation (no hashchange).
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (sel.value !== 'all') p.set('show', sel.value);
    const qs = p.toString();
    history.replaceState(null, '', `#/${qs ? `?${qs}` : ''}`);
  };
  q.addEventListener('input', draw);
  sel.addEventListener('change', draw);
  ctx.view.querySelector('[data-new-app]')?.addEventListener('click', () => newApplication({
    existing: data.folders.map((f) => f.appId), distributionUrls: data.distributionUrls,
  }));
  draw();
}

/** The tiles at the top. @param {Overview} d */
function kpis(d) {
  const t = d.totals;
  const online = d.folders.reduce((n, f) => n + (f.controllers?.online ?? 0), 0);
  const dl = d.downloads;
  /** @type {string[]} */
  const tiles = [
    tile('Applications', fmtCount(t.folders), `${fmtCount(t.s1Folders)} S1 · ${fmtCount(t.linuxFolders)} Linux`),
    tile('Releases', fmtCount(t.releases), 'in the manifests'),
    tile('Storage', fmtBytes(t.bytes), 'in gocontroll-deploy'),
    tile('Controllers', fmtCount(t.controllers), `${fmtCount(online)} online now`),
  ];
  if (!dl.configured) {
    tiles.push(tile('Downloads', 'Not configured', 'Download counts need a Cloudflare API token'));
  } else if (dl.error && dl.last7 === null) {
    tiles.push(tile('Downloads', 'Unavailable', esc(dl.error), true));
  } else {
    tiles.push(tile('Downloads · 7 days', `≈ ${fmtCount(dl.last7)}`, 'approx. (sampled by Cloudflare)'));
    tiles.push(tile('Downloads · 30 days', `≈ ${fmtCount(dl.last30)}`, dl.error ? esc(dl.error) : 'approx. (sampled by Cloudflare)', Boolean(dl.error)));
  }
  return `<section class="kpis" aria-label="Totals">${tiles.join('')}</section>`;
}

/** @param {string} label @param {string} value @param {string} sub markup @param {boolean} [bad] */
const tile = (label, value, sub, bad = false) => `<div class="kpi"><span class="kpi-label">${esc(label)}</span>
  <span class="kpi-value num">${esc(value)}</span><span class="kpi-sub${bad ? ' bad' : ''}">${sub}</span></div>`;

/**
 * Whether a folder passes the filter and the search (App ID, latest version or customer).
 * @param {FolderSummary} f @param {string} q lower case @param {string} show @param {string} [customerName]
 */
function matches(f, q, show, customerName = '') {
  const { controller } = controllerOf(f);
  if (show === 'nokey' && (controller !== 'S1' || f.hasKey)) return false;
  if (show === 'unknown' && controller !== null) return false;
  if (show !== 'all' && show !== 'nokey' && show !== 'unknown' && controller !== show) return false;
  if (!q) return true;
  return f.appId.toLowerCase().includes(q) || (f.latest ?? '').toLowerCase().includes(q) || customerName.toLowerCase().includes(q);
}

/** Customers with their folders, then the folders without one. @param {Overview} d @param {string} q @param {string} show */
function folderLists(d, q, show) {
  const byId = new Map(d.folders.map((f) => [f.appId, f]));
  const placed = new Set();
  const groups = d.customers.map((c) => {
    const folders = c.folders.map((id) => byId.get(id)).filter((f) => f !== undefined);
    folders.forEach((f) => placed.add(f.appId));
    const shown = folders.filter((f) => matches(f, q, show, c.name));
    return shown.length ? `<div class="group">
      <h2 class="group-head">${esc(c.name)} <span class="count">${plural(shown.length, 'application')}</span></h2>
      ${folderTable(shown)}</div>` : '';
  }).filter(Boolean);
  const loose = d.folders.filter((f) => !f.customer && !placed.has(f.appId)).filter((f) => matches(f, q, show));
  // A folder whose customer is set but is missing from customers[] still shows up.
  const stray = d.folders.filter((f) => f.customer && !placed.has(f.appId)).filter((f) => matches(f, q, show, f.customer?.name));
  const nothing = !groups.length && !loose.length && !stray.length;
  return `
    <div class="section-label">Customers</div>
    ${groups.length ? groups.join('') : `<p class="muted">${d.customers.length ? 'No customer application matches.' : 'No application could be tied to a customer yet.'}</p>`}
    ${stray.length ? `<div class="group"><h2 class="group-head">Other customers</h2>${folderTable(stray, true)}</div>` : ''}
    <div class="section-label">Folders without a customer</div>
    ${loose.length ? folderTable(loose) : `<p class="muted">${nothing ? 'Nothing matches.' : 'None.'}</p>`}
    <p class="hint muted">The customer of a folder is the one assigned by hand on its page, or else the customer most of its controllers belong to, or else the customer of the project provisioned with that App ID.</p>`;
}

/** @param {FolderSummary[]} folders @param {boolean} [withCustomer] */
function folderTable(folders, withCustomer = false) {
  return `<div class="table-wrap"><table class="data rows cards folders">
    <thead><tr><th>App ID</th><th>Controller</th><th>Latest</th><th class="num">Releases</th><th>Signing key</th><th>Last upload</th></tr></thead>
    <tbody>${folders.map((f) => {
      const { controller, source } = controllerOf(f);
      return `<tr>
      <td data-label="App ID"><a class="cell-main mono" href="#/folders/${encodeURIComponent(f.appId)}">${esc(f.appId)}</a>${
        withCustomer && f.customer ? `<div class="cell-sub">${esc(f.customer.name)}</div>` : ''}</td>
      <td data-label="Controller">${controllerBadge(controller, source)}</td>
      <td data-label="Latest" class="mono">${esc(f.latest ?? '—')}</td>
      <td data-label="Releases" class="num">${fmtCount(f.releases)}</td>
      <td data-label="Signing key">${flavour(f) !== 's1' ? '<span class="muted" title="Only S1 binaries are signed; go-deploy checks the SHA-256 of a Linux package">n/a</span>'
        : f.hasKey ? badge('Yes', 'ok') : badge('No', 'warn')}</td>
      <td data-label="Last upload">${esc(fmtDateTime(f.lastUpload))}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}
