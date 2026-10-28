// @ts-check
// The download page of images.gocontroll.tech: reads GET /api/catalogue and lists the published
// images (filtered per controller) and tools, each product with its releases newest first.
//
// Every text from the catalogue goes into the page as text (textContent, attributes via
// setAttribute), never as HTML: no innerHTML or insertAdjacentHTML anywhere in this file
// (images/test/page.test.ts checks it). The CSP allows no inline script or style either.

import { CONTROLLERS, controllersText, formatDate, formatSize, platformLabel, productGroups, roleLabel } from './format.js';

/** @typedef {import('./format.js').Catalogue} Catalogue */
/** @typedef {import('./format.js').CatalogueRelease} CatalogueRelease */
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
function icon(name) {
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
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) if (child !== null && child !== false) el.append(child);
  return el;
}

/** @param {string} id */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Catalogue | null} */
let catalogue = null;

/** The controller of the filter, from the address (#L4, #M1, #HMI1); '' = all. */
function currentController() {
  const wanted = decodeURIComponent(window.location.hash.slice(1));
  return CONTROLLERS.includes(wanted) ? wanted : '';
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** @param {CatalogueFile} file */
function fileItem(file) {
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

/**
 * @param {CatalogueRelease} release @param {boolean} latest @param {boolean} open
 * @param {string} productTitle
 */
function releaseItem(release, latest, open, productTitle) {
  const date = formatDate(release.released);
  const summary = h('summary', {},
    icon('chevron-right'),
    h('span', { class: 'rel-line' },
      h('span', { class: 'rel-version' }, `Version ${release.version}`),
      latest ? h('span', { class: 'badge latest' }, 'Latest') : null),
    h('span', { class: 'rel-meta' }, [date ? `Released ${date}` : '', controllersText(release)].filter(Boolean).join(' · ')));

  const body = h('div', { class: 'release-body' },
    release.title !== productTitle ? h('p', { class: 'rel-title' }, release.title) : null,
    release.notes.trim() ? h('p', { class: 'notes' }, release.notes.trim()) : null,
    release.files.length
      ? h('ul', { class: 'files', 'aria-label': `Files of version ${release.version}` }, ...release.files.map(fileItem))
      : h('p', { class: 'muted' }, 'This release has no files.'));

  return h('details', { class: 'release', open }, summary, body);
}

/** @param {CatalogueRelease[]} releases  one product, newest first */
function productCard(releases) {
  const [newest] = releases;
  const titleId = `product-${newest.kind}-${newest.product}`;
  return h('article', { class: 'product', 'aria-labelledby': titleId },
    h('header', { class: 'product-head' },
      h('h3', { id: titleId }, newest.title),
      h('span', { class: 'product-id' }, newest.product)),
    h('div', { class: 'releases' }, ...releases.map((r, i) => releaseItem(r, i === 0, i === 0, newest.title))));
}

/** @param {HTMLElement} container @param {CatalogueRelease[][]} groups @param {string} emptyText */
function renderSection(container, groups, emptyText) {
  container.replaceChildren(...(groups.length ? groups.map(productCard) : [h('p', { class: 'empty' }, emptyText)]));
}

function render() {
  if (!catalogue) return;
  const controller = currentController();
  for (const button of document.querySelectorAll('[data-controller]')) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-controller') === controller));
  }
  renderSection(byId('images'), productGroups(catalogue.releases, 'image', controller),
    controller ? `No images for the ${controller} have been published yet.` : 'No images have been published yet.');
  renderSection(byId('tools'), productGroups(catalogue.releases, 'tool'), 'No tools have been published yet.');
}

/** @param {string} email */
function showWho(email) {
  for (const id of ['who', 'hero-who']) {
    const el = byId(id);
    el.textContent = id === 'who' ? email : `Signed in as ${email}`;
    el.hidden = false;
  }
}

/** @param {string} text */
function showError(text) {
  byId('notice-text').textContent = text;
  byId('notice').hidden = false;
  for (const id of ['images', 'tools']) byId(id).replaceChildren(h('p', { class: 'empty' }, 'The downloads could not be loaded.'));
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load() {
  /** @type {Response} */
  let res;
  try {
    // An ended Access session answers with a redirect to the sign-in page: not followed here
    // (another origin), but told to the customer.
    res = await fetch('/api/catalogue', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { accept: 'application/json' } });
  } catch {
    showError('The downloads could not be loaded. Check your connection and reload the page.');
    return;
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    showError('Your sign-in has ended. Reload the page to sign in again.');
    return;
  }
  if (!res.ok) {
    showError(res.status === 503
      ? 'The downloads are not available right now. Please try again later.'
      : 'The downloads could not be loaded. Please reload the page.');
    return;
  }
  /** @type {{ email: string, catalogue: Catalogue }} */
  const data = await res.json();
  catalogue = data.catalogue;
  showWho(data.email);
  if (catalogue.updated) {
    const updated = byId('hero-updated');
    updated.textContent = `Last updated ${formatDate(catalogue.updated)}`;
    updated.hidden = false;
  }
  render();
}

// ── Events ───────────────────────────────────────────────────────────────────

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

document.addEventListener('click', (event) => {
  const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
  const copyButton = /** @type {HTMLElement | null} */ (target?.closest('[data-copy]') ?? null);
  if (copyButton) {
    void copy(copyButton, copyButton.getAttribute('data-copy') ?? '');
    return;
  }
  const filter = target?.closest('[data-controller]');
  if (filter) {
    const controller = filter.getAttribute('data-controller') ?? '';
    // replaceState: the filter is not a page of its own in the history; the address keeps it for a link or a reload.
    window.history.replaceState(null, '', controller ? `#${controller}` : window.location.pathname);
    render();
  }
});
window.addEventListener('hashchange', render);
byId('notice-retry').addEventListener('click', () => window.location.reload());

void load();
