// @ts-check
// Small browser helpers. Copied from GOcontroll-Logistic/public/js/lib.js (itself from
// Finance, the CRM and Hours), with the icons Deploy adds (key, cloud-arrow-up, tray
// arrows, shield, folder, chip) and copy/download helpers. The API calls are in api.js.

import { errorText } from './api.js';

/** Heroicons v2 outline paths (stroke 1.5, currentColor), as in the hub (gocontroll.tools). */
const ICONS = {
  'arrow-left': 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18',
  'chevron-down': 'm19.5 8.25-7.5 7.5-7.5-7.5',
  logout: 'M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9',
  'chevron-left': 'M15.75 19.5 8.25 12l7.5-7.5',
  'chevron-right': 'm8.25 4.5 7.5 7.5-7.5 7.5',
  duplicate: 'M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75',
  plus: 'M12 4.5v15m7.5-7.5h-15',
  x: 'M6 18 18 6M6 6l12 12',
  pencil: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  check: 'm4.5 12.75 6 6 9-13.5',
  lock: 'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z',
  document: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  'arrow-path': 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  external: 'M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
  key: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
  'cloud-arrow-up': 'M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z',
  'arrow-down-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',
  'arrow-up-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5',
  'shield-check': 'M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z',
  warning: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  folder: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  chip: 'M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z',
};

/** @param {string} name @param {number} [size] */
export function icon(name, size = 20) {
  const d = ICONS[/** @type {keyof typeof ICONS} */ (name)];
  if (!d) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="${size}" height="${size}" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
}

/** Put icons into every element with data-icon (prepended to existing content). @param {ParentNode} [root] */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.insertAdjacentHTML('afterbegin', icon(/** @type {string} */ (el.getAttribute('data-icon'))));
    el.removeAttribute('data-icon');
  });
}

/**
 * Bar widths (data-bar="0–100") set through the CSSOM: the CSP allows no style
 * attributes in markup. @param {ParentNode} root
 */
export function hydrateBars(root) {
  root.querySelectorAll('[data-bar]').forEach((el) => {
    const pct = Math.max(0, Math.min(100, Number(el.getAttribute('data-bar')) || 0));
    /** @type {HTMLElement} */ (el).style.width = `${pct}%`;
    el.removeAttribute('data-bar');
  });
}

/** HTML-escape for template strings. @param {unknown} s */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
));

/** @param {string} id */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return /** @type {any} */ (el);
}

let toastTimer = 0;
/** @param {string} message @param {'ok'|'err'} [kind] */
export function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', kind === 'err');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), kind === 'err' ? 6000 : 2500);
}

/**
 * Run what a button starts. The button is disabled (aria-busy) until it is done, so a
 * double click never sends it twice; an error goes to onError, or else to a toast.
 * @template T
 * @param {Element | null | undefined} btn
 * @param {() => Promise<T>} fn
 * @param {(err: unknown) => void} [onError]
 * @returns {Promise<T | undefined>}
 */
export async function act(btn, fn, onError) {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b?.disabled) return undefined;
  if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
  try {
    return await fn();
  } catch (err) {
    if (onError) onError(err);
    else toast(errorText(err), 'err');
    return undefined;
  } finally {
    if (b) { b.disabled = false; b.removeAttribute('aria-busy'); }
  }
}

let uid = 0;
/** A fresh element id, to tie a <label for> to its field in markup drawn more than once. @param {string} prefix */
export const uniqueId = (prefix) => `${prefix}-${++uid}`;

/**
 * A labelled form field (label tied to the control by id).
 * @param {string} label  text, escaped here
 * @param {(id: string) => string} control  markup of the input/select/textarea, given its id
 * @param {string} [cls]  extra classes on the field, e.g. 'span-2'
 * @param {string} [hint]  markup under the control
 */
export function field(label, control, cls = '', hint = '') {
  const id = uniqueId('fld');
  return `<div class="field${cls ? ` ${cls}` : ''}"><label for="${id}">${esc(label)}</label>${control(id)}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

/** Header avatar initials, like the hub (gocontroll.tools). @param {string} name @param {string} email */
export function initials(name, email) {
  const source = name && name !== email ? name : email.split('@')[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

/** Fill the header's user block. @param {{ name: string, email: string }} me */
export function showUser(me) {
  $('who-initials').textContent = initials(me.name, me.email);
  $('who-name').textContent = me.name;
  $('who').title = me.email;
}

/**
 * Wire [data-close] buttons and backdrop clicks of a <dialog>. Only a click that also
 * started on the backdrop closes it: selecting text in a field and letting go outside
 * the dialog does not.
 * @param {HTMLDialogElement} dialog
 */
export function wireDialog(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if ((t === dialog && downOnBackdrop) || t.closest('[data-close]')) dialog.close();
  });
}

// ── Copy and download ────────────────────────────────────────────────────────

/**
 * Copy text to the clipboard. The button (if given) reads "Copied" for a moment.
 * @param {string} text @param {HTMLElement} [btn]
 */
export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('This browser does not allow copying here: select the text and copy it yourself.', 'err');
    return;
  }
  if (!btn) { toast('Copied.'); return; }
  const label = btn.querySelector('.copy-label');
  if (!label) return;
  const before = label.textContent;
  btn.classList.add('copied');
  label.textContent = 'Copied';
  window.setTimeout(() => { btn.classList.remove('copied'); label.textContent = before; }, 1600);
}

/**
 * A Copy button for the text of the element with id `from` (wired once in app.js:
 * every [data-copy-from] click copies). @param {string} from @param {string} [what]  for screen readers
 */
export const copyButton = (from, what = '') => `<button type="button" class="btn sm copy-btn" data-copy-from="${esc(from)}" data-icon="duplicate"${
  what ? ` aria-label="Copy ${esc(what)}"` : ''}><span class="copy-label">Copy</span></button>`;

/** Hand a file to the browser to save. @param {Blob} blob @param {string} filename */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
