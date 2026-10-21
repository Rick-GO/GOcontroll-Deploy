// @ts-check
// Small browser helpers. Copied from GOcontroll-Logistic/public/js/lib.js (itself from
// Finance, the CRM and Hours), with the icons Deploy uses (key, cloud-arrow-up, the tray
// arrows) and copy/download helpers. The API calls are in api.js.

import { errorText } from './api.js';

/** Heroicons v2 outline paths (stroke 1.5, currentColor), as in the hub (gocontroll.tools). */
const ICONS = {
  'arrow-left': 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18',
  logout: 'M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9',
  'chevron-left': 'M15.75 19.5 8.25 12l7.5-7.5',
  duplicate: 'M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75',
  plus: 'M12 4.5v15m7.5-7.5h-15',
  x: 'M6 18 18 6M6 6l12 12',
  trash: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',
  check: 'm4.5 12.75 6 6 9-13.5',
  document: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  'arrow-path': 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  key: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
  'cloud-arrow-up': 'M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z',
  'arrow-down-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',
  'arrow-up-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5',
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
function initials(name, email) {
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
 * the dialog does not. While the dialog is busy (holdDialog) nothing closes it, Escape
 * included.
 * @param {HTMLDialogElement} dialog
 */
export function wireDialog(dialog) {
  let downOnBackdrop = false;
  dialog.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (dialog.dataset.busy) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if ((t === dialog && downOnBackdrop) || t.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('cancel', (e) => { if (dialog.dataset.busy) e.preventDefault(); });
}

/**
 * Keep a dialog open while a run that must not be cut off goes on (the folder delete):
 * its close buttons are disabled and Escape does nothing.
 * @param {HTMLDialogElement} dialog @param {boolean} busy
 */
export function holdDialog(dialog, busy) {
  if (busy) dialog.dataset.busy = '1';
  else delete dialog.dataset.busy;
  dialog.querySelectorAll('[data-close]').forEach((b) => { /** @type {HTMLButtonElement} */ (b).disabled = busy; });
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
