// @ts-check
// The DOM helpers of the pages of images.gocontroll.tech (app.js, download.js, sign-in.js): elements,
// icons, the file card with its Download button and checksum, and copying to the clipboard.
//
// Every text goes into the page as text (textContent, attributes via setAttribute), never as HTML:
// no innerHTML or insertAdjacentHTML in any script of the site (images/test/page.test.ts checks it).

import { formatSize, platformLabel, roleLabel } from './format.js';

/** @typedef {import('./format.js').CatalogueFile} CatalogueFile */

/** Heroicons v2 outline paths (stroke 1.5, currentColor), as on the intranet apps. */
const ICONS = {
  'chevron-right': 'm8.25 4.5 7.5 7.5-7.5 7.5',
  'arrow-down-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',
  duplicate: 'M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75',
  check: 'm4.5 12.75 6 6 9-13.5',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @param {keyof typeof ICONS} name @returns {SVGSVGElement} */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/**
 * A new element: `attrs` as attributes (class via `class`), children as nodes or text.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Record<string, string | boolean>} [attrs] @param {(Node | string | null | false)[]} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) if (child !== null && child !== false) el.append(child);
  return el;
}

/** @param {string} id */
export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}

/** The address a page was opened for, in the header (and the hero on narrow screens). @param {string} email */
export function showWho(email) {
  const who = document.getElementById('who');
  if (who) {
    who.textContent = email;
    who.hidden = false;
  }
  const hero = document.getElementById('hero-who');
  if (hero) {
    hero.textContent = `Signed in as ${email}`;
    hero.hidden = false;
  }
}

/** The file of a release: name, role, platform, size, Download and its SHA-256 with Copy. @param {CatalogueFile} file */
export function fileItem(file) {
  const tags = [h('span', { class: 'tag role' }, roleLabel(file.role))];
  const platform = platformLabel(file.platform);
  if (platform) tags.push(h('span', { class: 'tag' }, platform));
  if (file.size > 0) tags.push(h('span', { class: 'tag', title: `${file.size.toLocaleString('en-GB')} bytes` }, formatSize(file.size)));

  const download = h('a', { class: 'btn primary dl', href: `/files/${file.path}`, download: file.name, 'aria-label': `Download ${file.name}` },
    icon('arrow-down-tray'), h('span', {}, 'Download'));

  /** @type {HTMLElement} */
  let sha;
  if (file.sha256) {
    const copy = h('button', { type: 'button', class: 'btn copy-btn', 'data-copy': file.sha256, 'aria-label': `Copy the SHA-256 of ${file.name}` },
      icon('duplicate'), h('span', { class: 'copy-label' }, 'Copy'));
    sha = h('div', { class: 'file-sha' }, h('span', { class: 'sha-label' }, 'SHA-256'), h('code', { class: 'sha' }, file.sha256), copy);
  } else {
    sha = h('div', { class: 'file-sha' }, h('span', { class: 'sha-label' }, 'SHA-256'), h('span', { class: 'muted' }, 'Not available'));
  }

  return h('li', { class: 'file' },
    h('div', { class: 'file-main' }, h('span', { class: 'file-name' }, file.name), h('span', { class: 'tags' }, ...tags)),
    download,
    sha);
}

/** @param {HTMLElement} button @param {string} text */
async function copy(button, text) {
  const label = button.querySelector('.copy-label');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard here (an old browser, or not allowed): select the checksum to copy by hand.
    const code = button.parentElement?.querySelector('.sha');
    const selection = window.getSelection();
    if (code && selection) {
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (label) label.textContent = 'Selected';
    window.setTimeout(() => { if (label) label.textContent = 'Copy'; }, 1600);
    return;
  }
  button.classList.add('copied');
  if (label) label.textContent = 'Copied';
  window.setTimeout(() => {
    button.classList.remove('copied');
    if (label) label.textContent = 'Copy';
  }, 1600);
}

/** Every [data-copy] button of the page copies its value (one listener, also for cards drawn later). */
export function wireCopyButtons() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = /** @type {HTMLElement | null} */ (target?.closest('[data-copy]') ?? null);
    if (button) void copy(button, button.getAttribute('data-copy') ?? '');
  });
}

/**
 * GET /api/catalogue. Not signed in (any more): to the sign-in page, coming back to `back`.
 * @param {string} back  the path to return to after signing in ('/' or a /download/ page)
 * @returns {Promise<{ email: string, catalogue: import('./format.js').Catalogue } | { error: string } | null>}
 *   null while the browser leaves for the sign-in page
 */
export async function loadCatalogue(back) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch('/api/catalogue', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return { error: 'The downloads could not be loaded. Check your connection and reload the page.' };
  }
  if (res.status === 401) {
    window.location.assign(back === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(back)}`);
    return null;
  }
  if (!res.ok) {
    return { error: res.status === 503
      ? 'The downloads are not available right now. Please try again later.'
      : 'The downloads could not be loaded. Please reload the page.' };
  }
  return res.json();
}
