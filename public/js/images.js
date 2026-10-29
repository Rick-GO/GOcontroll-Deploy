// @ts-check
// Images (#/images): Linux images for the Moduline L4, M1 and HMI1, for customers on
// images.gocontroll.tech (bucket gocontroll-images, src/images.ts).
//
// A release (the image of one controller, optionally one type of it, in one version) starts as a draft. Its files are uploaded straight
// into the bucket in parts of the Worker's partSize, three at a time, each part retried a few times;
// at the end the Worker joins them and reads the SHA-256 from the stored file. Customers see a
// release only once it is published (manifest.json); Withdraw takes it away again. Drafts can lose
// files or be deleted; a published release only changes its text.
//
// The labels of roles and platforms are those of src/images-format.ts (the source), copied in
// release-helpers.js.

import { api, errorText, putBlob } from './api.js';
import { fmtBytes, fmtDateTime, fmtDay, plural, shortHash } from './format.js';
import { act, copyButton, esc, field, hydrateIcons, toast, uniqueId } from './lib.js';
import { IMAGE_PLATFORM_LABELS as PLATFORM_LABELS, IMAGE_ROLE_LABELS as ROLE_LABELS, guessPlatform, guessRole } from './release-helpers.js';
import { badge, confirmDialog, formDialog, formValues, setHero, stale } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {{ name: string, path: string, size: number, sha256: string, role: string, platform: string, uploaded_at: string, uploaded_by: string }} ImageFile
 * @typedef {{ key: string, folder: string, controller: string, type: string, version: string, released: string, notes: string,
 *   files: ImageFile[], status: 'draft' | 'published', created_at: string, created_by: string, updated_at: string, updated_by: string,
 *   published_at?: string | null, published_by?: string | null, inCatalogue: boolean }} Release
 * @typedef {{ id: string, key: string, release: string, name: string, size: number, parts: number, started_at: string, started_by: string }} Upload
 * @typedef {{ at: string, email: string, path: string, product: string, version: string, country: string }} Download
 * @typedef {{ month: string, downloads: number, addresses: number, releases: Record<string, number>, files: Record<string, number>,
 *   countries: Record<string, number>, final: boolean }} MonthStats
 * @typedef {{ release: string, total: number, thisMonth: number, lastMonth: number }} ReleaseTotal
 * @typedef {{ month: string, months: MonthStats[], releases: ReleaseTotal[], total: number, error?: string }} Stats
 * @typedef {{ releases: Release[], uploads: Upload[], downloads: Download[], stats: Stats, catalogueError?: string, publicUrl: string,
 *   limits: { partSize: number, maxFileSize: number } }} Overview
 */

const CONTROLLERS = ['L4', 'M1', 'HMI1'];
const PARALLEL_PARTS = 3;
const PART_ATTEMPTS = 4;

/** A release's URL: its key <product>/<id> (its folder images/<key>, fixed; type and version are labels). @param {{ key: string }} r */
const base = (r) => `/images/releases/${r.key.split('/').map(encodeURIComponent).join('/')}`;
/** A release's key: on its card and in the download counts. @param {{ key: string }} r */
const releaseId = (r) => r.key;
/** The name customers see, as releaseName in src/images-format.ts: "Moduline HMI1 · 1.07 - AV123". @param {{ controller: string, type: string }} r */
const titleOf = (r) => (r.type ? `Moduline ${r.controller} · ${r.type}` : `Moduline ${r.controller}`);

/** The release date field's default: today, local. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── The page ─────────────────────────────────────────────────────────────────

/** Uploads running on this page: leaving it would stop them (the guard is set on the first render). */
let running = 0;
let guarded = false;

/** @param {Ctx} ctx */
export async function renderImages(ctx) {
  if (!guarded) {
    window.addEventListener('beforeunload', (e) => { if (running) e.preventDefault(); });
    guarded = true;
  }
  const nav = ctx.nav;
  setHero({
    title: 'Images',
    lede: 'Linux images for the Moduline L4, M1 and HMI1, for customers on images.gocontroll.tech. A release is a draft until you publish it.',
  });
  /** @type {Overview} */
  const data = await api('GET', '/images');
  if (stale(ctx, nav)) return;
  const reload = () => { if (!stale(ctx, nav)) renderImages(ctx).catch((err) => toast(errorText(err), 'err')); };
  ctx.view.innerHTML = `
    ${data.catalogueError ? `<section class="panel"><div class="notice err">${esc(data.catalogueError)}</div></section>` : ''}
    ${kpis(data)}
    <section class="panel">
      <div class="panel-head"><h2>Releases</h2><span class="spacer"></span>
        <button type="button" class="btn primary" data-new data-icon="plus">New release…</button></div>
      <p class="text">Customers ask for a link with their e-mail address on <a href="${esc(data.publicUrl)}" rel="noopener">${esc(data.publicUrl.replace(/^https:\/\//, ''))}</a>; it opens the downloads for 7 days, and they download what is published here. Upload every file of a release, then publish it. <em>Copy link</em> next to a published file gives the address that signs a customer in and starts that file.</p>
      ${data.uploads.length ? unfinished(data.uploads) : ''}
      ${data.releases.length ? data.releases.map((r) => releaseCard(r, data)).join('') : '<p class="muted">No image yet.</p>'}
    </section>
    ${downloadCounts(data)}
    <section class="panel">
      <div class="panel-head"><h2>Latest downloads</h2><span class="sub">who downloaded what, this month and last month (at most 200)</span></div>
      ${downloads(data.downloads)}
    </section>`;
  hydrateIcons(ctx.view);

  ctx.view.querySelector('[data-new]')?.addEventListener('click', async () => {
    if (await releaseDialog(data, null)) reload();
  });
  ctx.view.querySelectorAll('[data-abort]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const id = /** @type {HTMLElement} */ (b).dataset.abort ?? '';
    if (!(await confirmDialog('Abort the upload?', 'The parts sent so far are discarded.', 'Abort upload', true))) return;
    await api('DELETE', `/images/uploads/${id}`);
    toast('Upload aborted.');
    reload();
  })));
  ctx.view.querySelectorAll('[data-release]').forEach((card) => wireCard(/** @type {HTMLElement} */ (card), data, reload));
}

/** @param {Overview} d */
function kpis(d) {
  const published = d.releases.filter((r) => r.status === 'published').length;
  /** @param {string} label @param {string} value @param {string} sub */
  const tile = (label, value, sub) => `<div class="kpi"><span class="kpi-label">${esc(label)}</span><span class="kpi-value num">${esc(value)}</span><span class="kpi-sub">${esc(sub)}</span></div>`;
  const bytes = d.releases.filter((r) => r.status === 'published').reduce((n, r) => n + r.files.reduce((m, f) => m + f.size, 0), 0);
  return `<section class="kpis" aria-label="Totals">
    ${tile('Published', String(published), `${fmtBytes(bytes)} for customers`)}
    ${tile('Drafts', String(d.releases.length - published), 'not visible to customers')}
    ${tile('Downloads', String(d.stats.months.find((m) => m.month === d.stats.month)?.downloads ?? 0), `this month · ${d.stats.total} in all`)}
  </section>`;
}

/** @param {Upload[]} uploads */
function unfinished(uploads) {
  return `<div class="notice warn"><strong>Unfinished uploads.</strong> An upload that stopped (page closed, connection lost) cannot be resumed here: abort it and upload the file again. Cloudflare drops it after 7 days anyway.
    <ul class="plain-list">${uploads.map((u) => `<li><span class="mono">${esc(u.key)}</span> · ${esc(fmtBytes(u.size))} · ${esc(u.started_by)}, ${esc(fmtDateTime(u.started_at))}
      <button type="button" class="btn sm danger" data-abort="${esc(u.id)}">Abort</button></li>`).join('')}</ul></div>`;
}

/** @param {Release} r @param {Overview} d */
function releaseCard(r, d) {
  const draft = r.status === 'draft';
  const uploading = d.uploads.some((u) => u.release === r.key);
  return `<article class="img-release" data-release="${esc(releaseId(r))}">
    <header class="img-head">
      <div><h3>${esc(titleOf(r))} <span class="mono muted">${esc(r.version)}</span></h3>
        <div class="cell-sub mono">${esc(r.folder)}/</div></div>
      <div class="badges">${draft ? badge('Draft', 'warn', 'Not visible to customers') : badge('Published', 'ok', `Since ${fmtDateTime(r.published_at ?? '')} by ${r.published_by ?? ''}`)}</div>
    </header>
    <p class="muted">Release date ${esc(fmtDay(r.released))} · made by ${esc(r.created_by)} · last change ${esc(fmtDateTime(r.updated_at))} by ${esc(r.updated_by)}${downloadLine(r, d)}</p>
    ${r.notes ? `<p class="pre">${esc(r.notes)}</p>` : ''}
    ${r.status === 'published' && !r.inCatalogue ? '<div class="notice err">Published here, but missing from manifest.json: withdraw and publish it again.</div>' : ''}
    ${r.files.length ? `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>File</th><th>What</th><th class="num">Size</th><th>SHA-256</th><th>Uploaded</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${r.files.map((f) => {
        const id = uniqueId('sha');
        return `<tr>
          <td data-label="File" class="mono">${esc(f.name)}</td>
          <td data-label="What">${esc(ROLE_LABELS[f.role] ?? f.role)}${f.platform !== 'any' ? ` · ${esc(PLATFORM_LABELS[f.platform] ?? f.platform)}` : ''}</td>
          <td data-label="Size" class="num">${esc(fmtBytes(f.size))}</td>
          <td data-label="SHA-256" class="mono"><span id="${id}" hidden>${esc(f.sha256)}</span>${esc(shortHash(f.sha256))} ${copyButton(id, 'SHA-256')}</td>
          <td data-label="Uploaded">${esc(f.uploaded_by)}<div class="cell-sub">${esc(fmtDateTime(f.uploaded_at))}</div></td>
          <td data-label="">${draft ? `<button type="button" class="btn sm" data-remove="${esc(f.name)}" data-icon="trash">Remove</button>` : customerLink(d, f)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">No files yet.</p>'}
    ${draft ? `<div class="img-add" data-add>
      <label class="btn" data-icon="arrow-up-tray"><span>Add files…</span><input type="file" class="sr-only" multiple data-files></label>
      <div data-queue></div></div>` : ''}
    <div class="btn-row">
      <button type="button" class="btn" data-edit>Edit…</button>
      ${draft ? `<button type="button" class="btn primary" data-publish${!r.files.length || uploading ? ' disabled' : ''} data-icon="cloud-arrow-up">Publish</button>
        <button type="button" class="btn danger" data-delete data-icon="trash">Delete draft…</button>`
        : '<button type="button" class="btn" data-withdraw>Withdraw…</button>'}
    </div>
  </article>`;
}

/** @param {Release} r @param {Overview} d */
function downloadLine(r, d) {
  if (r.status !== 'published' && !d.stats.releases.some((t) => t.release === releaseId(r))) return '';
  const t = d.stats.releases.find((x) => x.release === releaseId(r));
  return ` · <strong>${esc(plural(t?.total ?? 0, 'download'))}</strong>${t?.thisMonth ? ` (${esc(String(t.thisMonth))} this month)` : ''}`;
}

/** The link that signs a customer in and starts this file, with Copy. @param {Overview} d @param {ImageFile} f */
function customerLink(d, f) {
  const id = uniqueId('link');
  return `<span id="${id}" hidden>${esc(`${d.publicUrl}/download/${f.path}`)}</span>${copyButton(id, `the customer link of ${f.name}`, 'Copy link')}`;
}

/** Counts per release (all time, this and last month) and per month. @param {Overview} d */
function downloadCounts(d) {
  const s = d.stats;
  const titles = new Map(d.releases.map((r) => [releaseId(r), `${titleOf(r)} ${r.version}`]));
  const perRelease = s.releases.length
    ? `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>Release</th><th class="num">In all</th><th class="num">This month</th><th class="num">Last month</th></tr></thead>
      <tbody>${s.releases.map((t) => `<tr>
        <td data-label="Release">${esc(titles.get(t.release) ?? t.release)}<div class="cell-sub mono">${esc(t.release)}</div></td>
        <td data-label="In all" class="num">${esc(String(t.total))}</td>
        <td data-label="This month" class="num">${esc(String(t.thisMonth))}</td>
        <td data-label="Last month" class="num">${esc(String(t.lastMonth))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No downloads yet.</p>';
  /** @param {Record<string, number>} c */
  const countries = (c) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k || '?'} ${n}`).join(', ') || '—';
  const perMonth = s.months.filter((m) => m.downloads).length
    ? `<div class="table-wrap"><table class="data cards">
      <thead><tr><th>Month</th><th class="num">Downloads</th><th class="num">Addresses</th><th>Countries</th></tr></thead>
      <tbody>${s.months.filter((m) => m.downloads || !m.final).map((m) => `<tr>
        <td data-label="Month">${esc(fmtMonth(m.month))}${m.final ? '' : ' <span class="cell-sub">so far</span>'}</td>
        <td data-label="Downloads" class="num">${esc(String(m.downloads))}</td>
        <td data-label="Addresses" class="num">${esc(String(m.addresses))}</td>
        <td data-label="Countries">${esc(countries(m.countries))}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '';
  return `<section class="panel">
    <div class="panel-head"><h2>Downloads</h2><span class="sub">a download is counted when a file starts; resuming it does not count again</span></div>
    ${s.error ? `<div class="notice err">${esc(s.error)}</div>` : ''}
    ${perRelease}
    ${perMonth ? `<div class="section-label">Per month</div>${perMonth}` : ''}
  </section>`;
}

/** "October 2026" of "2026-10". @param {string} month */
const fmtMonth = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** @param {Download[]} list */
function downloads(list) {
  if (!list.length) return '<p class="muted">No downloads yet.</p>';
  return `<div class="table-wrap"><table class="data cards">
    <thead><tr><th>When</th><th>Who</th><th>File</th><th>Country</th></tr></thead>
    <tbody>${list.map((x) => `<tr>
      <td data-label="When">${esc(fmtDateTime(x.at))}</td>
      <td data-label="Who">${esc(x.email)}</td>
      <td data-label="File" class="mono">${esc(x.path)}</td>
      <td data-label="Country">${esc(x.country || '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ── A release ────────────────────────────────────────────────────────────────

/** @param {HTMLElement} card @param {Overview} data @param {() => void} reload */
function wireCard(card, data, reload) {
  const r = /** @type {Release} */ (data.releases.find((x) => x.key === card.dataset.release));
  const q = (/** @type {string} */ sel) => card.querySelector(sel);

  q('[data-edit]')?.addEventListener('click', async () => { if (await releaseDialog(data, r)) reload(); });
  const publish = q('[data-publish]');
  publish?.addEventListener('click', () => act(publish, async () => {
    const ok = await confirmDialog(`Publish ${titleOf(r)} ${r.version}?`,
      `<p>Customers can download its ${plural(r.files.length, 'file')} on ${esc(data.publicUrl.replace(/^https:\/\//, ''))} right away.</p>`, 'Publish');
    if (!ok) return;
    await api('POST', `${base(r)}/publish`);
    toast('Published.');
    reload();
  }));
  const withdraw = q('[data-withdraw]');
  withdraw?.addEventListener('click', () => act(withdraw, async () => {
    const ok = await confirmDialog(`Withdraw ${titleOf(r)} ${r.version}?`,
      '<p>Customers can no longer see or download it. The files stay; it becomes a draft again, which you can change and publish again.</p>', 'Withdraw', true);
    if (!ok) return;
    await api('POST', `${base(r)}/withdraw`);
    toast('Withdrawn.');
    reload();
  }));
  const del = q('[data-delete]');
  del?.addEventListener('click', () => act(del, async () => {
    const ok = await confirmDialog(`Delete the draft ${titleOf(r)} ${r.version}?`,
      `<p>Its ${plural(r.files.length, 'file')} are deleted from the bucket. This cannot be undone.</p>`, 'Delete draft', true);
    if (!ok) return;
    await api('DELETE', base(r));
    toast('Draft deleted.');
    reload();
  }));
  card.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const name = /** @type {HTMLElement} */ (b).dataset.remove ?? '';
    if (!(await confirmDialog(`Remove ${name}?`, 'The file is deleted from the bucket.', 'Remove', true))) return;
    await api('DELETE', `${base(r)}/files/${encodeURIComponent(name)}`);
    reload();
  })));

  const input = /** @type {HTMLInputElement | null} */ (q('[data-files]'));
  const queue = /** @type {HTMLElement | null} */ (q('[data-queue]'));
  if (input && queue) input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) drawQueue(queue, r, data, files, reload);
  });
}

/**
 * The files chosen for a release: what each one is, then Upload.
 * @param {HTMLElement} queue @param {Release} r @param {Overview} data @param {File[]} files @param {() => void} reload
 */
function drawQueue(queue, r, data, files, reload) {
  const taken = new Set(r.files.map((f) => f.name));
  queue.innerHTML = `<div class="table-wrap"><table class="data cards">
    <thead><tr><th>File</th><th class="num">Size</th><th>What</th><th>Runs on</th><th>Progress</th></tr></thead>
    <tbody>${files.map((f, i) => {
      const problem = !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(f.name) ? 'Rename the file: letters, digits and . _ + - only.'
        : taken.has(f.name) ? 'Already in this release: remove it first.'
        : f.size > data.limits.maxFileSize ? 'Larger than 32 GB.'
        : !f.size ? 'The file is empty.' : '';
      const role = guessRole(f.name);
      const platform = guessPlatform(f.name);
      return `<tr data-q="${i}"${problem ? ' class="inactive"' : ''}>
        <td data-label="File" class="mono">${esc(f.name)}${problem ? `<div class="cell-sub error">${esc(problem)}</div>` : ''}</td>
        <td data-label="Size" class="num">${esc(fmtBytes(f.size))}</td>
        <td data-label="What"><select name="role" aria-label="What ${esc(f.name)} is"${problem ? ' disabled' : ''}>${Object.entries(ROLE_LABELS)
          .map(([k, l]) => `<option value="${k}"${k === role ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
        <td data-label="Runs on"><select name="platform" aria-label="What ${esc(f.name)} runs on"${problem ? ' disabled' : ''}>${Object.entries(PLATFORM_LABELS)
          .map(([k, l]) => `<option value="${k}"${k === platform ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
        <td data-label="Progress"><progress class="upload-bar" max="100" value="0" hidden></progress> <span class="muted" data-state>${problem ? 'skipped' : 'ready'}</span></td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <div class="btn-row"><button type="button" class="btn primary" data-upload data-icon="cloud-arrow-up">Upload</button>
      <button type="button" class="btn" data-clear>Cancel</button></div>`;
  hydrateIcons(queue);
  queue.querySelector('[data-clear]')?.addEventListener('click', () => { queue.innerHTML = ''; });
  const button = /** @type {HTMLButtonElement} */ (queue.querySelector('[data-upload]'));
  button.addEventListener('click', () => act(button, async () => {
    /** @type {HTMLButtonElement} */ (queue.querySelector('[data-clear]')).hidden = true;
    let failed = 0;
    running++;
    try {
      for (const [i, file] of files.entries()) {
        const row = /** @type {HTMLElement} */ (queue.querySelector(`[data-q="${i}"]`));
        if (row.classList.contains('inactive')) continue;
        const state = /** @type {HTMLElement} */ (row.querySelector('[data-state]'));
        const bar = /** @type {HTMLProgressElement} */ (row.querySelector('progress'));
        const role = /** @type {HTMLSelectElement} */ (row.querySelector('[name=role]'));
        const platform = /** @type {HTMLSelectElement} */ (row.querySelector('[name=platform]'));
        role.disabled = true;
        platform.disabled = true;
        bar.hidden = false;
        try {
          const done = await uploadFile(r, file, role.value, platform.value, (fraction, text) => {
            bar.value = Math.round(fraction * 100);
            state.textContent = text;
          });
          bar.value = 100;
          state.textContent = `done · SHA-256 ${shortHash(done.sha256)}`;
        } catch (err) {
          failed++;
          state.textContent = errorText(err);
          state.classList.add('error');
        }
      }
    } finally {
      running--;
    }
    if (failed) toast(`${plural(failed, 'file')} not uploaded.`, 'err');
    else { toast('Uploaded.'); reload(); }
  }));
}

/**
 * Upload one file: start, its parts (PARALLEL_PARTS at a time, each retried), complete.
 * @param {Release} r @param {File} file @param {string} role @param {string} platform
 * @param {(fraction: number, text: string) => void} progress
 * @returns {Promise<ImageFile>}
 */
async function uploadFile(r, file, role, platform, progress) {
  progress(0, 'starting…');
  /** @type {{ id: string, partSize: number, parts: number }} */
  const start = await api('POST', `${base(r)}/files`, { name: file.name, size: file.size, role, platform });
  /** @type {{ partNumber: number, etag: string }[]} */
  const parts = [];
  const sent = new Array(start.parts + 1).fill(0);
  const report = () => {
    const bytes = sent.reduce((a, b) => a + b, 0);
    progress(bytes / file.size * 0.98, `${fmtBytes(bytes)} of ${fmtBytes(file.size)}`);
  };
  let next = 1;
  const worker = async () => {
    while (next <= start.parts) {
      const n = next++;
      const from = (n - 1) * start.partSize;
      const blob = file.slice(from, Math.min(file.size, from + start.partSize));
      for (let attempt = 1; ; attempt++) {
        try {
          parts.push(await putBlob(`/images/uploads/${start.id}/parts/${n}`, blob, { onProgress: (loaded) => { sent[n] = loaded; report(); } }));
          sent[n] = blob.size;
          report();
          break;
        } catch (err) {
          sent[n] = 0;
          if (attempt >= PART_ATTEMPTS || (/** @type {any} */ (err).status >= 400 && /** @type {any} */ (err).status < 500)) {
            throw new Error(`Part ${n} of ${start.parts} failed: ${errorText(err)} Reload the page, abort the unfinished upload and try again.`);
          }
          await new Promise((res) => setTimeout(res, 1000 * attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, start.parts) }, worker));
  progress(0.99, 'checking the SHA-256 of the stored file…');
  return api('POST', `/images/uploads/${start.id}/complete`, { parts });
}

// ── New release / Edit ───────────────────────────────────────────────────────

/**
 * New release, in this order: the controller (one), the release date, the type (optional, e.g.
 * "1.07 - AV123": a system of its own), the version, the notes. What customers see as its name
 * follows from controller and type ("Moduline HMI1 · 1.07 - AV123"). Edit: the same, but the
 * controller: date, type, version and notes, of a published release too (customers see the new labels
 * at once; its folder and files stay).
 * @param {Overview} data @param {Release | null} r  null: a new release
 * @returns {Promise<boolean>}
 */
function releaseDialog(data, r) {
  const typesId = uniqueId('types');
  const types = [...new Set(data.releases.map((x) => x.type).filter(Boolean))].sort();
  const body = `<div class="form-grid two">
    ${r ? `<p class="span-2 muted">Moduline ${esc(r.controller)} · <span class="mono">${esc(r.folder)}/</span> (cannot be changed)${r.status === 'published' ? '. Published: customers see a change at once.' : ''}</p>` : `
    <fieldset class="span-2"><legend>Controller</legend><div class="checks seg" role="radiogroup" aria-label="Controller">${CONTROLLERS.map((c) => `
      <label class="check"><input type="radio" name="controller" value="${c}" required> ${c}</label>`).join('')}</div></fieldset>`}
    ${field('Release date', (id) => `<input type="date" id="${id}" name="released" required value="${esc(r?.released ?? today())}">`)}
    ${field('Type', (id) => `<input id="${id}" name="type" maxlength="40" list="${typesId}" placeholder="e.g. 1.07 - AV123" value="${esc(r?.type ?? '')}">
      <datalist id="${typesId}">${types.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`, '', 'Optional: a variant that is a system of its own (hardware version, adapter board), with its own latest release. Customers see it next to the version. Empty: the controller is one system.')}
    ${field('Version', (id) => `<input id="${id}" name="version" required maxlength="64" class="mono" placeholder="e.g. 6.12.87" value="${esc(r?.version ?? '')}">`)}
    ${field('Notes', (id) => `<textarea id="${id}" name="notes" rows="5" maxlength="4000" placeholder="What is new, how to install it">${esc(r?.notes ?? '')}</textarea>`, 'span-2', 'Plain text, shown to customers.')}
  </div>`;
  return formDialog({
    title: r ? `Edit ${titleOf(r)} ${r.version}` : 'New release',
    submitLabel: r ? 'Save' : 'Create draft',
    body,
    submit: async (form) => {
      const v = formValues(form);
      const payload = { released: v.released, notes: v.notes, type: String(v.type ?? '').trim(), version: String(v.version).trim() };
      if (r) await api('PATCH', base(r), payload);
      else await api('POST', '/images/releases', { ...payload, controller: v.controller });
      toast(r ? 'Saved.' : 'Draft created. Add its files.');
    },
  });
}
