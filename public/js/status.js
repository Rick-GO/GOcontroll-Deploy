// @ts-check
// Status (#/): the deployments at a glance. KPI tiles; the customers with their deployment
// folders (App IDs); the folders no customer was found for. The search and the filter work
// on the page itself, without a reload, and stay in the address (#/?q=&show=) so Back
// returns to the same list.

import { api } from './api.js';
import { fmtBytes, fmtCount, fmtDateTime, plural } from './format.js';
import { esc, hydrateIcons } from './lib.js';
import { badge, kindBadge, setHero, stale, wireRowLinks } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').Overview} Overview
 * @typedef {import('./api.js').FolderSummary} FolderSummary
 */

const FILTERS = /** @type {const} */ ([
  ['all', 'All folders'],
  ['s1', 'S1 folders'],
  ['nokey', 'S1 without signing key'],
  ['linux', 'Linux folders'],
  ['unknown', 'Unrecognised folders'],
]);

/** @param {Ctx} ctx @param {URLSearchParams} params */
export async function renderStatus(ctx, params) {
  const nav = ctx.nav;
  setHero({
    title: 'Deployments',
    lede: "Firmware in GOcontroll's distribution bucket, per customer and App ID: releases, signing keys, the controllers on each App ID and how often they download.",
  });
  /** @type {Overview} */
  const data = await api('GET', '/overview');
  if (stale(ctx, nav)) return;
  const show = FILTERS.some(([k]) => k === params.get('show')) ? /** @type {string} */ (params.get('show')) : 'all';
  ctx.view.innerHTML = `${kpis(data)}
    <section class="panel">
      <div class="table-tools">
        <label class="search"><span class="sr-only">Search</span>
          <input type="search" id="st-q" value="${esc(params.get('q') ?? '')}" placeholder="Search App ID, customer or version" autocomplete="off"></label>
        <label class="filter"><span class="sr-only">Show</span>
          <select id="st-show">${FILTERS.map(([k, label]) => `<option value="${k}"${k === show ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <a class="btn sm primary" href="#/publish" data-icon="cloud-arrow-up">Publish a release</a>
      </div>
      <div id="st-list"></div>
    </section>`;
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
  draw();
}

/** The tiles at the top. @param {Overview} d */
function kpis(d) {
  const t = d.totals;
  const online = d.folders.reduce((n, f) => n + (f.controllers?.online ?? 0), 0);
  const dl = d.downloads;
  /** @type {string[]} */
  const tiles = [
    tile('Folders', fmtCount(t.folders), `${fmtCount(t.s1Folders)} S1 · ${fmtCount(t.linuxFolders)} Linux`),
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
  if (show === 'nokey' && (f.kind !== 's1' || f.hasKey)) return false;
  if (show !== 'all' && show !== 'nokey' && f.kind !== show) return false;
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
      <h2 class="group-head">${esc(c.name)} <span class="count">${plural(shown.length, 'folder')}</span></h2>
      ${folderTable(shown)}</div>` : '';
  }).filter(Boolean);
  const loose = d.folders.filter((f) => !f.customer && !placed.has(f.appId)).filter((f) => matches(f, q, show));
  // A folder whose customer is set but is missing from customers[] still shows up.
  const stray = d.folders.filter((f) => f.customer && !placed.has(f.appId)).filter((f) => matches(f, q, show, f.customer?.name));
  const nothing = !groups.length && !loose.length && !stray.length;
  return `
    <div class="section-label">Customers</div>
    ${groups.length ? groups.join('') : `<p class="muted">${d.customers.length ? 'No customer folder matches.' : 'No folder could be tied to a customer yet.'}</p>`}
    ${stray.length ? `<div class="group"><h2 class="group-head">Other customers</h2>${folderTable(stray, true)}</div>` : ''}
    <div class="section-label">Folders without a customer</div>
    ${loose.length ? folderTable(loose) : `<p class="muted">${nothing ? 'Nothing matches.' : 'None.'}</p>`}
    <p class="hint muted">The customer of a folder is the one assigned by hand on its page, or else the customer most of its controllers belong to, or else the customer of the project provisioned with that App ID.</p>`;
}

/** @param {FolderSummary[]} folders @param {boolean} [withCustomer] */
function folderTable(folders, withCustomer = false) {
  return `<div class="table-wrap"><table class="data rows cards folders">
    <thead><tr><th>App ID</th><th>Kind</th><th>Latest</th><th class="num">Releases</th><th>Controllers</th><th>Signing key</th><th>Last upload</th></tr></thead>
    <tbody>${folders.map((f) => `<tr>
      <td data-label="App ID"><a class="cell-main mono" href="#/folders/${encodeURIComponent(f.appId)}">${esc(f.appId)}</a>${
        withCustomer && f.customer ? `<div class="cell-sub">${esc(f.customer.name)}</div>` : ''}</td>
      <td data-label="Kind">${kindBadge(f.kind)}</td>
      <td data-label="Latest" class="mono">${esc(f.latest ?? '—')}</td>
      <td data-label="Releases" class="num">${fmtCount(f.releases)}</td>
      <td data-label="Controllers">${controllersCell(f)}</td>
      <td data-label="Signing key">${f.kind === 'linux' ? '<span class="muted">n/a</span>' : f.hasKey ? badge('Yes', 'ok') : badge('No', 'warn')}</td>
      <td data-label="Last upload">${esc(fmtDateTime(f.lastUpload))}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

/** @param {FolderSummary} f */
function controllersCell(f) {
  const c = f.controllers;
  if (!c || !c.total) return '<span class="muted">—</span>';
  return `${fmtCount(c.total)}<div class="cell-sub">${fmtCount(c.online)} online · ${fmtCount(c.upToDate)} up to date</div>`;
}
