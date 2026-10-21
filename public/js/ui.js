// @ts-check
// Shared UI pieces: the context every page gets, the hero band, the generic form dialog,
// badges, bar lists and form errors. Adapted from GOcontroll-Logistic (itself from Finance).

import { ApiError } from './api.js';
import { fmtCount } from './format.js';
import { $, esc, hydrateBars, hydrateIcons, wireDialog } from './lib.js';

/**
 * @typedef {import('./api.js').Me} Me
 * @typedef {import('./api.js').FolderSummary} FolderSummary
 * @typedef {{ me: Me, view: HTMLElement, nav: number, flash?: string | null }} Ctx
 *   nav counts navigations: a page that loaded slowly checks it before drawing (stale()).
 *   flash: a notice (markup) for the next page to show once, such as "folder deleted" on Status.
 */

/**
 * True when the colleague navigated elsewhere after `nav` was taken: the result of a slow
 * request is then dropped instead of drawn over the newer page.
 * @param {Ctx} ctx @param {number} nav
 */
export const stale = (ctx, nav) => ctx.nav !== nav;

/**
 * The hero band: an optional back link, the title, a line under it and tags.
 * @param {{ back?: { href: string, label: string }, title: string, lede?: string, tags?: string, mono?: boolean }} h  tags is markup
 */
export function setHero(h) {
  $('hero').innerHTML = `
    ${h.back ? `<p class="hero-date"><a href="${esc(h.back.href)}" data-icon="chevron-left">${esc(h.back.label)}</a></p>` : ''}
    <h1${h.mono ? ' class="mono-title"' : ''}>${esc(h.title)}</h1>
    ${h.lede ? `<p class="lede">${esc(h.lede)}</p>` : ''}
    ${h.tags ? `<div class="hero-tags">${h.tags}</div>` : ''}`;
  hydrateIcons($('hero'));
}

// ── Badges ───────────────────────────────────────────────────────────────────

/** The controller types an application can be set to by hand (DESIGN-v2 "Controller type"). */
export const CONTROLLERS = ['S1', 'M1', 'L4', 'HMI1'];

/**
 * The controller of a folder and where it comes from. Until the Worker sends `controller`,
 * an S1 manifest means S1.
 * @param {{ kind: string, controller?: string | null, controllerSource?: string | null }} f
 * @returns {{ controller: string | null, source: string | null }}
 */
export function controllerOf(f) {
  if (f.controller !== undefined) return { controller: f.controller ?? null, source: f.controllerSource ?? null };
  return f.kind === 's1' ? { controller: 'S1', source: 'manifest' } : { controller: null, source: null };
}

/**
 * Whether S1 releases are published into this folder here (upload and signing are S1 only):
 * an S1 manifest, or no Linux manifest and a controller that is S1 or not known yet.
 * @param {{ kind: string, controller?: string | null, controllerSource?: string | null }} f
 */
export function releasable(f) {
  if (f.kind === 's1') return true;
  if (f.kind === 'linux') return false;
  const { controller } = controllerOf(f);
  return controller === null || controller === 'S1';
}

/** Where a folder's controller type comes from, in words. @param {string | null} source */
export const controllerSourceText = (source) => ({
  manual: 'set by hand',
  manifest: 'from its manifest',
  controllers: 'from the controllers on this App ID',
})[source ?? ''] ?? '';

/** S1 / M1 / L4 / HMI1 (or a derived type), as a badge; a dash when unknown. @param {string | null} controller @param {string | null} [source] */
export function controllerBadge(controller, source = null) {
  if (!controller) return '<span class="muted" title="Not known: set it on the folder page">—</span>';
  const tone = controller === 'S1' ? 's1' : 'linux';
  const why = controllerSourceText(source);
  return `<span class="badge k-${tone}"${why ? ` title="${esc(why)}"` : ''}>${esc(controller)}</span>`;
}

/**
 * A small coloured badge. @param {string} text @param {'ok'|'warn'|'err'|'info'|'muted'|'brand'} [tone] @param {string} [title]
 */
export const badge = (text, tone = 'muted', title = '') => `<span class="badge b-${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

/** Where a folder's customer comes from, in words. @param {'manual'|'controllers'|'project'} source */
export const customerSource = (source) => ({
  manual: 'assigned by hand',
  controllers: 'from the controllers on this App ID',
  project: 'from the project provisioned with this App ID',
})[source] ?? source;

// ── Bar lists (no chart library) ─────────────────────────────────────────────

/**
 * A list of labelled horizontal bars, widths relative to the largest value.
 * @param {{ label: string, value: number | null, sub?: string, title?: string, mono?: boolean }[]} rows  label, sub and title are text
 * @param {string} [unit]  after the number, e.g. "approx."
 */
export function barList(rows, unit = '') {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return `<ul class="bars">${rows.map((r) => `<li${r.title ? ` title="${esc(r.title)}"` : ''}>
    <span class="bar-label${r.mono ? ' mono' : ''}">${esc(r.label)}</span>
    <span class="bar-track" aria-hidden="true"><span class="bar-fill" data-bar="${r.value ? Math.max(1, (r.value / max) * 100) : 0}"></span></span>
    <span class="bar-value num">${r.value === null ? '<span class="muted">n/a</span>' : esc(fmtCount(r.value))}${unit && r.value !== null ? ` <span class="muted">${esc(unit)}</span>` : ''}</span>
    ${r.sub ? `<span class="bar-sub">${esc(r.sub)}</span>` : ''}</li>`).join('')}</ul>`;
}

/** After drawing markup with bar lists. @param {HTMLElement} root */
export const drawBars = (root) => hydrateBars(root);

// ── A run in steps (Publish, Sign) ───────────────────────────────────────────

/**
 * Draw the steps of a run into `el`; the first one is the upload, with a bar.
 * @param {HTMLElement} el @param {string[]} labels  text
 * @returns {{ upload: (fraction: number) => void, step: (i: number) => void, fail: () => void, done: () => void }}
 */
export function runSteps(el, labels) {
  el.hidden = false;
  el.innerHTML = `<ol class="steps">${labels.map((l, i) => `<li${i === 0 ? ' class="active"' : ''}>
    <span class="step-dot" aria-hidden="true"></span><span class="step-label">${esc(l)}${i === 0 ? ' <span class="num muted" data-pct></span>' : ''}</span></li>`).join('')}</ol>
    <progress class="upload-bar" max="100" value="0" aria-label="Upload"></progress>`;
  const items = [...el.querySelectorAll('.steps li')];
  const bar = /** @type {HTMLProgressElement} */ (el.querySelector('progress'));
  const pct = /** @type {HTMLElement} */ (el.querySelector('[data-pct]'));
  let current = 0;
  const step = (/** @type {number} */ i) => {
    current = i;
    items.forEach((li, j) => {
      li.classList.toggle('done', j < i);
      li.classList.toggle('active', j === i);
      li.classList.remove('err');
    });
    if (i > 0) { bar.value = 100; pct.textContent = ''; }
  };
  return {
    upload: (f) => { bar.value = Math.round(f * 100); pct.textContent = `${Math.round(f * 100)}%`; },
    step,
    fail: () => { items[current]?.classList.remove('active'); items[current]?.classList.add('err'); },
    done: () => { step(items.length); bar.hidden = true; },
  };
}

// ── Forms ────────────────────────────────────────────────────────────────────

/**
 * Show an API error in a form: the message in its notice, and the field it names marked.
 * @param {HTMLElement} root @param {HTMLElement} notice @param {unknown} err
 */
function showError(root, notice, err) {
  root.querySelectorAll('[data-flagged]').forEach((el) => { el.removeAttribute('aria-invalid'); delete /** @type {HTMLElement} */ (el).dataset.flagged; });
  notice.textContent = err instanceof Error ? err.message : String(err);
  notice.hidden = false;
  const name = err instanceof ApiError ? err.field : undefined;
  if (!name) return;
  const el = root.querySelector(`[name="${CSS.escape(name.split('.')[0])}"]`);
  if (el instanceof HTMLElement) flagField(el);
}

/**
 * Mark a field a failed attempt names, and focus it; editing it unmarks it again (app.js).
 * @param {HTMLElement} el
 */
export function flagField(el) {
  el.setAttribute('aria-invalid', 'true');
  el.dataset.flagged = '1';
  el.focus();
}

/**
 * The generic form dialog. `body` is the markup of its fields; `submit` runs on submit and
 * closes the dialog when it resolves. An error stays in the dialog, at its field.
 * `valid`, when given, keeps the submit button disabled until it returns true (checked on
 * every edit and after a failed attempt).
 * @param {{ title: string, submitLabel: string, body: string, danger?: boolean, narrow?: boolean,
 *   onOpen?: (form: HTMLFormElement) => void, submit: (form: HTMLFormElement) => Promise<unknown>,
 *   valid?: (form: HTMLFormElement) => boolean }} opts
 * @returns {Promise<boolean>} true when submitted
 */
export function formDialog(opts) {
  /** @type {HTMLDialogElement} */
  const dialog = $('form-dialog');
  /** @type {HTMLFormElement} */
  const form = $('form-dialog-form');
  const notice = $('form-dialog-error');
  const button = $('form-dialog-submit');
  if (!dialog.dataset.wired) { wireDialog(dialog); dialog.dataset.wired = '1'; }
  $('form-dialog-title').textContent = opts.title;
  $('form-dialog-body').innerHTML = opts.body;
  hydrateIcons($('form-dialog-body'));
  button.textContent = opts.submitLabel;
  button.disabled = false;
  button.classList.toggle('danger', Boolean(opts.danger));
  button.classList.toggle('primary', !opts.danger);
  dialog.classList.toggle('narrow', Boolean(opts.narrow));
  notice.hidden = true;
  const check = () => { if (opts.valid) button.disabled = !opts.valid(form); };
  form.oninput = check;
  form.onchange = check;
  return new Promise((resolve) => {
    let done = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (button.disabled || (opts.valid && !opts.valid(form))) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await opts.submit(form);
        done = true;
        dialog.close();
      } catch (err) {
        showError(form, notice, err);
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        check();
      }
    };
    dialog.addEventListener('close', () => {
      form.onsubmit = null;
      form.oninput = null;
      form.onchange = null;
      $('form-dialog-body').innerHTML = '';
      resolve(done);
    }, { once: true });
    dialog.showModal();
    opts.onOpen?.(form);
    check();
    const first = /** @type {HTMLElement | null} */ (form.querySelector('#form-dialog-body input:not([type=hidden]):not([type=radio]):not([type=file]), #form-dialog-body select, #form-dialog-body textarea'));
    first?.focus();
  });
}

/** Ask before doing something that cannot be undone. @param {string} title @param {string} message markup @param {string} label @param {boolean} [danger] */
export function confirmDialog(title, message, label, danger = false) {
  return formDialog({ title, submitLabel: label, body: message.trim().startsWith('<') ? message : `<p>${message}</p>`, danger, narrow: true, submit: async () => {} });
}

/** The values of a form by name (strings; checkboxes as booleans; radios as the checked value). @param {HTMLFormElement} form */
export function formValues(form) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const el of /** @type {any[]} */ ([...form.elements])) {
    if (!el.name) continue;
    if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; continue; }
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

/** Row clicks open the row's link (the first <a> in it); links, buttons and fields keep their own. @param {HTMLElement} table */
export function wireRowLinks(table) {
  table.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('a, button, input, select, label')) return;
    const a = t.closest('tr')?.querySelector('a[href^="#"]');
    if (a) location.hash = /** @type {HTMLAnchorElement} */ (a).hash;
  });
}
