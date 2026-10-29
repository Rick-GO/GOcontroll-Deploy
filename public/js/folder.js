// @ts-check
// One application (#/applications/<APP_ID>; a folder in the bucket): its customer and controller
// type (both can be set by hand), then by what goes into it:
//   S1             New release (release.js: signed GOCO binaries), the releases with what their
//                  headers say;
//   M1, L4, HMI1   the Package card (pkgcard.js), New release (linux-release.js: go-deploy
//                  packages), the versions;
// and for every application its public key (key.js: to copy or download for provisioning; for a
// Linux application kept for provisioning only), the controllers per version, the downloads per
// day, files the manifest does not name, and the danger zone (danger.js). Another controller type
// is read-only. An App ID that does not exist gets a way to create it.

import { ApiError, api, folderPath } from './api.js';
import { fmtBytes, fmtCount, fmtDateTime, fmtDay, fmtDayShort, hostOf, plural, shortHash, versionText } from './format.js';
import { esc, field, hydrateIcons, toast } from './lib.js';
import { keyPanel, wireKeyPanel } from './key.js';
import { dangerPanel, deleteFolder } from './danger.js';
import { newApplication } from './newapp.js';
import { mountLinuxRelease } from './linux-release.js';
import { compareLinuxVersions } from './package.js';
import { mountPackageCard } from './pkgcard.js';
import { mountRelease } from './release.js';
import { compareVersions } from './source.js';
import {
  CONTROLLERS, badge, barList, controllerBadge, controllerOf, controllerSourceText, customerSource, drawBars, flavour, formDialog, formValues,
  setHero, stale,
} from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').FolderSettings} FolderSettings
 * @typedef {import('./api.js').KeyInfo} KeyInfo
 * @typedef {import('./api.js').PublishResult} PublishResult
 * @typedef {import('./api.js').LinuxPublishResult} LinuxPublishResult
 * @typedef {import('./api.js').Release} Release
 * @typedef {import('./api.js').FolderCustomer} FolderCustomer
 */

/**
 * @param {Ctx} ctx @param {string} appId
 * @param {{ published?: PublishResult, linuxPublished?: LinuxPublishResult }} [after]
 *   the release just published, shown on top of New release
 */
export async function renderFolder(ctx, appId, after = {}) {
  const nav = ctx.nav;
  /** @type {FolderDetail} */
  let d;
  try {
    d = await api('GET', folderPath(appId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && !stale(ctx, nav)) return renderMissing(ctx, appId);
    throw err;
  }
  if (stale(ctx, nav)) return;
  const kind = flavour(d);
  const releases = [...(d.releases ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  const releaseKeys = otherReleaseKeys(d);
  const keyOpts = { linux: kind !== 's1', releaseKeys };
  drawHero(d);
  const middle = kind === 's1'
    ? `<section class="panel" id="release-panel"></section>${releasesPanel(d, releases)}${keyPanel(d.key, keyOpts)}`
    : kind === 'linux'
      ? `<section class="panel" id="package-panel"></section><section class="panel" id="release-panel"></section>${linuxPanel(d)}${keyPanel(d.key, keyOpts)}`
      : `${readOnlyNote(d)}${d.kind === 'linux' ? linuxPanel(d) : releases.length ? releasesPanel(d, releases) : ''}${keyPanel(d.key, keyOpts)}`;
  ctx.view.innerHTML = `
    <section class="panel" id="folder-summary"></section>
    ${middle}
    <div class="two-up">
      ${controllersPanel(d)}
      ${downloadsPanel(d)}
    </div>
    ${otherPanel(d)}
    ${dangerPanel(d)}`;
  hydrateIcons(ctx.view);
  drawBars(ctx.view);

  const summary = /** @type {HTMLElement} */ (ctx.view.querySelector('#folder-summary'));
  const drawSummary = () => {
    summary.innerHTML = summaryHtml(d, releases);
    summary.querySelector('[data-act="customer"]')?.addEventListener('click', () => changeCustomer(d, applySettings));
    summary.querySelector('[data-act="controller"]')?.addEventListener('click', () => changeController(d, applySettings));
  };
  /** New settings from the Worker: redraw in place, or the whole page when what goes into the folder changes. @param {FolderSettings} s */
  const applySettings = async (s) => {
    const before = flavour(d);
    d = { ...d, customer: s.customer, controller: s.controller, controllerSource: s.controllerSource };
    if (flavour(d) !== before) { await renderFolder(ctx, appId); return; }
    drawHero(d);
    drawSummary();
  };
  drawSummary();

  /** @type {{ setKey: (key: KeyInfo | null) => void } | null} */
  let release = null;
  /** A key attached in the key card or in step 2: both show it. @param {KeyInfo} key */
  const keyChanged = (key) => {
    d = { ...d, key };
    const panel = ctx.view.querySelector('#key-panel');
    if (panel) {
      const others = otherReleaseKeys(d);
      panel.outerHTML = keyPanel(key, { linux: kind !== 's1', releaseKeys: others });
      const fresh = /** @type {HTMLElement} */ (ctx.view.querySelector('#key-panel'));
      hydrateIcons(fresh);
      wireKeyPanel(fresh, d.appId, key, others, (k) => { keyChanged(k); release?.setKey(k); });
    }
  };
  const releaseEl = /** @type {HTMLElement | null} */ (ctx.view.querySelector('#release-panel'));
  if (releaseEl && kind === 'linux') {
    const mountLinux = () => mountLinuxRelease(releaseEl, {
      detail: d,
      published: after.linuxPublished ?? null,
      onPublished: async (res) => {
        await renderFolder(ctx, appId, { linuxPublished: res });
        ctx.view.querySelector('#release-panel')?.scrollIntoView({ block: 'start' });
      },
    });
    let linux = mountLinux();
    mountPackageCard(/** @type {HTMLElement} */ (ctx.view.querySelector('#package-panel')), {
      detail: d,
      onSaved: (def) => { d = { ...d, package: def }; linux = mountLinux(); },
      onDirty: (dirty) => linux.setPackageDirty(dirty),
    });
  } else if (releaseEl) {
    release = mountRelease(releaseEl, {
      detail: d,
      published: after.published ?? null,
      releaseKeys,
      onKey: keyChanged,
      onPublished: async (res) => {
        await renderFolder(ctx, appId, { published: res });
        ctx.view.querySelector('#release-panel')?.scrollIntoView({ block: 'start' });
      },
    });
  }
  const keyEl = /** @type {HTMLElement | null} */ (ctx.view.querySelector('#key-panel'));
  if (keyEl) wireKeyPanel(keyEl, d.appId, d.key, releaseKeys, (k) => { keyChanged(k); release?.setKey(k); });
  ctx.view.querySelector('[data-delete]')?.addEventListener('click', () => deleteFolder(ctx, d));
}

/**
 * The public keys in the headers of this application's signed releases that are not its own key
 * (all of them, without one): controllers in the field may carry them. @param {FolderDetail} d
 */
function otherReleaseKeys(d) {
  const own = d.key?.publicKey ?? null;
  const keys = new Set((d.releases ?? []).map((r) => (r.header?.signed ? r.header.publicKey : null)).filter((k) => k && k !== own));
  return /** @type {string[]} */ ([...keys]);
}

/** @param {FolderDetail} d */
function drawHero(d) {
  const { controller, source } = controllerOf(d);
  setHero({
    back: { href: '#/applications', label: 'Applications' },
    title: d.appId,
    mono: true,
    tags: `${controllerBadge(controller, source)}${d.latest ? `<span>Latest <strong class="mono">${esc(d.latest)}</strong></span>` : ''}${
      d.customer ? `<span>${esc(d.customer.name)}</span>` : ''}`,
  });
}

/** The facts at the top, with the customer and controller to change. @param {FolderDetail} d @param {Release[]} releases */
function summaryHtml(d, releases) {
  const { controller, source } = controllerOf(d);
  const bytes = releases.reduce((n, r) => n + (r.size ?? 0), 0);
  const uploads = releases.map((r) => r.uploaded).filter(Boolean).sort();
  const c = d.controllers;
  return `
    ${d.mixedHosts ? `<div class="notice warn">The binary URLs in this manifest name more than one host. A controller carries one distribution URL and
      installs only binaries under that host, so not every controller can install every release. Move the App ID to one host
      (GOcontroll-Deployment-Tool, <span class="mono">worker/README.md</span>).</div>` : ''}
    ${d.manifestError ? `<div class="notice err">The manifest cannot be read: ${esc(d.manifestError)}</div>` : ''}
    <dl class="facts">
      <div class="span-2"><dt>Customer</dt><dd>${customerText(d.customer)} <button type="button" class="link-btn" data-act="customer">Change…</button></dd></div>
      <div><dt>Controller</dt><dd>${controller ? `<strong>${esc(controller)}</strong>` : '<span class="muted">Not known</span>'}${
        source ? ` <span class="muted">(${esc(controllerSourceText(source))})</span>` : ''} <button type="button" class="link-btn" data-act="controller">Change…</button></dd></div>
      <div><dt>Latest</dt><dd class="mono">${esc(d.latest ?? '—')}</dd></div>
      <div><dt>Releases</dt><dd>${d.kind === 'linux'
        ? `${fmtCount(d.linuxVersions?.length ?? 0)} (go-deploy)`
        : `${fmtCount(releases.length)}${bytes ? ` · ${esc(fmtBytes(bytes))}` : ''}`}</dd></div>
      <div><dt>Last upload</dt><dd>${esc(fmtDateTime(uploads[uploads.length - 1]))}</dd></div>
      <div><dt>${flavour(d) === 'linux' ? 'Downloads by controllers' : 'Distribution host'}</dt><dd>${d.distributionUrl
        ? `<span class="mono">${esc(hostOf(d.distributionUrl))}</span>`
        : flavour(d) === 'linux' ? 'Through the Moduline dashboard (signed route)' : '—'}</dd></div>
      <div><dt>Controllers</dt><dd>${c?.total ? `${fmtCount(c.total)} · ${fmtCount(c.online)} online · ${fmtCount(c.upToDate)} up to date` : 'None report this App ID'}</dd></div>
    </dl>`;
}

/** Instead of New release, for a controller type Deploy does not publish for. @param {FolderDetail} d */
function readOnlyNote(d) {
  const { controller } = controllerOf(d);
  return `<section class="panel"><p class="text">Releases for ${esc(controller ?? 'these')} controllers are not published here: Deploy publishes
    for S1 (signed binaries) and for M1, L4 and HMI1 (go-deploy packages). Set the controller above if it is one of those.</p></section>`;
}

/** An App ID that does not exist (no folder, key or settings). @param {Ctx} ctx @param {string} appId */
function renderMissing(ctx, appId) {
  setHero({ back: { href: '#/applications', label: 'Applications' }, title: appId, mono: true, lede: 'There is no application with this App ID yet.' });
  ctx.view.innerHTML = `<section class="panel">
      <p class="text">Nothing in the bucket, no public key and no settings carry the App ID <span class="mono">${esc(appId)}</span>.</p>
      <div class="btn-row"><button type="button" class="btn sm primary" data-create data-icon="plus">Create it as a new application…</button></div>
    </section>`;
  hydrateIcons(ctx.view);
  ctx.view.querySelector('[data-create]')?.addEventListener('click', () => newApplication({ existing: [], appId }));
}

/** @param {FolderCustomer | null} c */
const customerText = (c) => (c
  ? `${esc(c.name)} <span class="muted">(${esc(customerSource(c.source))})</span>`
  : '<span class="muted">None found: not assigned by hand, and no controller or project ties this App ID to a customer.</span>');

/** PUT the folder settings. @param {string} appId @param {Record<string, unknown>} body @returns {Promise<FolderSettings>} */
const putSettings = (appId, body) => api('PUT', `${folderPath(appId)}/settings`, body);

/**
 * Assign a customer by hand, or go back to the derived one.
 * @param {FolderDetail} d @param {(s: FolderSettings) => Promise<unknown>} done
 */
async function changeCustomer(d, done) {
  /** @type {{ id: number, name: string }[]} */
  const customers = await api('GET', '/customers');
  const manual = d.customer?.source === 'manual' ? d.customer.id : null;
  /** @type {{ s: FolderSettings | null }} */
  const out = { s: null };
  const ok = await formDialog({
    title: `Customer of ${d.appId}`,
    submitLabel: 'Save',
    narrow: true,
    body: `${field('Customer', (id) => `<select id="${id}" name="customerId">
        <option value="">Not assigned by hand: derive it</option>
        ${customers.map((c) => `<option value="${c.id}"${c.id === manual ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)}
      <p class="hint">Without one assigned by hand, the customer is the one most controllers on this App ID belong to, or else the customer of the
        project provisioned with it. Customers are managed in the CRM.</p>`,
    submit: async (form) => {
      const v = String(formValues(form).customerId ?? '');
      out.s = await putSettings(d.appId, { customerId: v ? Number(v) : null });
    },
  });
  if (ok && out.s) { toast('Customer saved.'); await done(out.s); }
}

/**
 * Set the controller type by hand, or go back to the derived one.
 * @param {FolderDetail} d @param {(s: FolderSettings) => Promise<unknown>} done
 */
async function changeController(d, done) {
  const { controller, source } = controllerOf(d);
  const manual = source === 'manual' ? controller : null;
  /** @type {{ s: FolderSettings | null }} */
  const out = { s: null };
  const ok = await formDialog({
    title: `Controller of ${d.appId}`,
    submitLabel: 'Save',
    narrow: true,
    body: `${field('Controller', (id) => `<select id="${id}" name="controller">
        <option value="">Not set by hand: derive it</option>
        ${CONTROLLERS.map((c) => `<option value="${c}"${c === manual ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}
      <p class="hint">Without one set by hand, an S1 manifest means S1; otherwise it is the type most controllers on this App ID are.
        New releases are published here for S1 only.</p>`,
    submit: async (form) => {
      const v = String(formValues(form).controller ?? '');
      out.s = await putSettings(d.appId, { controller: v || null });
    },
  });
  if (ok && out.s) { toast('Controller saved.'); await done(out.s); }
}

// ── Releases ─────────────────────────────────────────────────────────────────

/** @param {FolderDetail} d @param {Release[]} releases  newest first */
function releasesPanel(d, releases) {
  return `<section class="panel">
    <div class="panel-head"><h2>Releases</h2><span class="sub">${plural(releases.length, 'release')} in <span class="mono">${esc(d.appId)}/manifest.json</span></span></div>
    ${releases.length ? `<div class="table-wrap"><table class="data cards releases">
      <thead><tr><th>Version</th><th>Released</th><th>What changed</th><th class="num">Size</th><th>SHA-256</th><th>Checks</th><th class="num">Downloads</th></tr></thead>
      <tbody>${releases.map((r) => `<tr>
        <td data-label="Version"><span class="cell-main mono">${esc(r.version)}</span>${r.version === d.latest ? ` ${badge('Latest', 'brand')}` : ''}
          ${r.url ? `<div class="cell-sub"><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.url)}">Binary</a></div>` : ''}</td>
        <td data-label="Released">${esc(fmtDay(r.releaseDate))}${r.uploaded ? `<div class="cell-sub">uploaded ${esc(fmtDateTime(r.uploaded))}</div>` : ''}</td>
        <td data-label="What changed" class="desc">${esc(r.description || '—')}</td>
        <td data-label="Size" class="num">${r.size === null ? badge('Missing', 'err', 'The manifest names a binary that is not in the bucket') : esc(fmtBytes(r.size))}</td>
        <td data-label="SHA-256" class="mono"${r.header?.sha256 ? ` title="${esc(r.header.sha256)}"` : ''}>${esc(shortHash(r.header?.sha256))}</td>
        <td data-label="Checks"><span class="badges">${checks(d, r)}</span></td>
        <td data-label="Downloads" class="num">${r.downloads === null || r.downloads === undefined ? '—' : `≈ ${esc(fmtCount(r.downloads))}`}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint muted">Size and SHA-256 come from each binary's header (its first bytes, read from the bucket). Downloads are Cloudflare's sampled estimates.</p>`
    : '<p class="muted">No releases yet.</p>'}
  </section>`;
}

/** What the header of a release says, as badges. @param {FolderDetail} d @param {Release} r */
function checks(d, r) {
  if (r.headerError) return badge('Header unreadable', 'err', r.headerError);
  const h = r.header;
  if (!h) return r.size === null ? '' : badge('Not read', 'muted');
  const out = [h.signed ? badge('Signed', 'ok') : badge('Unsigned', 'warn', 'A controller with signing switched on refuses this image')];
  if (h.signed && r.keyMatches === true) out.push(badge('Key matches', 'ok', "Signed with this folder's active key"));
  if (h.signed && r.keyMatches === false) {
    out.push(badge('Other key', 'err', d.key
      ? "Signed with a key that is not this folder's active key: controllers carrying the active public key refuse it"
      : 'Signed, but this folder has no key in Deploy'));
  }
  if (r.digestMatches === true) out.push(badge('Digest ok', 'ok', 'The ?v= in the manifest URL matches the payload SHA-256'));
  if (r.digestMatches === false) out.push(badge('Digest differs', 'err', 'The ?v= in the manifest URL does not match the payload SHA-256: an install from the bucket refuses it'));
  if (h.appId && h.appId !== d.appId) out.push(badge(`App ID ${h.appId}`, 'err', 'The App ID in the header differs from the folder'));
  const hv = versionText(h.version);
  if (hv && hv !== r.version) out.push(badge(`Header ${hv}`, 'err', 'The version in the header differs from the manifest'));
  return out.join(' ');
}

/** @param {FolderDetail} d */
function linuxPanel(d) {
  const versions = [...(d.linuxVersions ?? [])].sort((a, b) => compareLinuxVersions(b.version, a.version));
  return `<section class="panel">
    <div class="panel-head"><h2>Versions</h2><span class="sub">go-deploy packages in <span class="mono">${esc(d.appId)}/manifest.json</span>, from Deploy or a CI pipeline</span></div>
    ${versions.length ? `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>Version</th><th>Released</th><th>What changed</th><th class="num">Size</th><th>SHA-256</th></tr></thead>
      <tbody>${versions.map((v) => `<tr>
        <td data-label="Version"><span class="cell-main mono">${esc(v.version)}</span>${v.version === d.latest ? ` ${badge('Latest', 'brand')}` : ''}
          <div class="cell-sub"><a href="/api${esc(folderPath(d.appId))}/versions/${encodeURIComponent(v.version)}/tarball" download="${esc(`${d.appId}-${v.version}-update.tar.gz`)}">Tarball</a></div></td>
        <td data-label="Released">${esc(fmtDay(v.released))}</td>
        <td data-label="What changed" class="desc">${esc(v.description || '—')}</td>
        <td data-label="Size" class="num">${esc(fmtBytes(v.sizeBytes))}</td>
        <td data-label="SHA-256" class="mono"${v.sha256 ? ` title="${esc(v.sha256)}"` : ''}>${esc(shortHash(v.sha256))}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No versions yet.</p>'}
  </section>`;
}

// ── Controllers and downloads ────────────────────────────────────────────────

/** @param {FolderDetail} d */
function controllersPanel(d) {
  const c = d.controllers;
  const versions = [...(c?.versions ?? [])].sort((a, b) => compareVersions(b.version ?? '', a.version ?? ''));
  return `<section class="panel">
    <div class="panel-head"><h2>Controllers per version</h2></div>
    ${c?.total ? `<p class="summary-line"><span><strong>${fmtCount(c.total)}</strong> on this App ID</span>
        <span><strong>${fmtCount(c.online)}</strong> online</span><span><strong>${fmtCount(c.upToDate)}</strong> up to date</span></p>
      ${barList(versions.map((v) => ({ label: `${v.version ?? 'unknown'}${v.version && v.version === d.latest ? ' (latest)' : ''}`, value: v.count, mono: true })))}`
    : '<p class="muted">No controller in the Moduline database reports this App ID.</p>'}
  </section>`;
}

/** @param {FolderDetail} d */
function downloadsPanel(d) {
  const dl = d.downloads;
  const head = '<div class="panel-head"><h2>Downloads per day</h2><span class="sub">approx.</span></div>';
  if (!dl?.configured) {
    return `<section class="panel">${head}<p class="muted">Download counts are not set up: Deploy needs a Cloudflare API token with Analytics read access (see the README).</p></section>`;
  }
  const days = [...(dl.days ?? [])].sort((a, b) => b.day.localeCompare(a.day));
  const sum = (/** @type {'downloads'|'headerReads'|'manifestReads'} */ k) => days.reduce((n, x) => n + (x[k] ?? 0), 0);
  return `<section class="panel">${head}
    ${dl.error ? `<div class="notice err">${esc(dl.error)}</div>` : ''}
    ${days.length ? `<p class="summary-line"><span>Last ${plural(days.length, 'day')}: <strong>≈ ${fmtCount(sum('downloads'))}</strong> downloads</span>
        <span><strong>≈ ${fmtCount(sum('headerReads'))}</strong> header reads</span><span><strong>≈ ${fmtCount(sum('manifestReads'))}</strong> manifest reads</span></p>
      ${barList(days.map((x) => ({
        label: fmtDayShort(x.day),
        value: x.unavailable ? null : (x.downloads ?? null),
        sub: x.unavailable ? 'no longer kept by Cloudflare' : '',
        title: x.unavailable ? '' : `${fmtCount(x.headerReads)} header reads · ${fmtCount(x.manifestReads)} manifest reads`,
      })))}
      <p class="hint muted">A download is a whole binary fetched (HTTP 200), a header read the first bytes only (206), a manifest read a controller or app checking for updates. Counts are Cloudflare's sampled estimates; finished days are kept by Deploy, today is live.</p>`
    : '<p class="muted">No days counted yet.</p>'}
  </section>`;
}

/** Objects in the folder that the manifest does not name. @param {FolderDetail} d */
function otherPanel(d) {
  const other = d.otherObjects ?? [];
  if (!other.length) return '';
  return `<section class="panel">
    <div class="panel-head"><h2>Other files in the folder</h2><span class="sub">not named by the manifest</span></div>
    <div class="table-wrap"><table class="data cards">
      <thead><tr><th>Object</th><th class="num">Size</th><th>Uploaded</th></tr></thead>
      <tbody>${other.map((o) => `<tr><td data-label="Object" class="mono">${esc(o.key)}</td><td data-label="Size" class="num">${esc(fmtBytes(o.size))}</td>
        <td data-label="Uploaded">${esc(fmtDateTime(o.uploaded))}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}
