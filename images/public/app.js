// @ts-check
// The download page of images.gocontroll.tech: reads GET /api/catalogue and lists the published
// images (filtered per controller), each product with its releases newest first. Without
// a session the Worker sends the browser to /sign-in before this page loads; a session that ends
// while the page is open does the same (ui.js loadCatalogue).
//
// Every text from the catalogue goes into the page as text (textContent, attributes via
// setAttribute), never as HTML: no innerHTML or insertAdjacentHTML anywhere in this file
// (images/test/page.test.ts checks it). The CSP allows no inline script or style either.

import { CONTROLLERS, controllersText, formatDate, productGroups } from './format.js';
import { byId, fileItem, h, icon, loadCatalogue, showWho, wireCopyButtons } from './ui.js';

/** @typedef {import('./format.js').Catalogue} Catalogue */
/** @typedef {import('./format.js').CatalogueRelease} CatalogueRelease */

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Catalogue | null} */
let catalogue = null;

/** The controller of the filter, from the address (#L4, #M1, #HMI1); '' = all. */
function currentController() {
  const wanted = decodeURIComponent(window.location.hash.slice(1));
  return CONTROLLERS.includes(wanted) ? wanted : '';
}

// ── Rendering ────────────────────────────────────────────────────────────────

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
  const titleId = `product-${newest.product}`;
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
  renderSection(byId('images'), productGroups(catalogue.releases, controller),
    controller ? `No images for the ${controller} have been published yet.` : 'No images have been published yet.');
}

/** @param {string} text */
function showError(text) {
  byId('notice-text').textContent = text;
  byId('notice').hidden = false;
  byId('images').replaceChildren(h('p', { class: 'empty' }, 'The downloads could not be loaded.'));
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load() {
  const data = await loadCatalogue('/');
  if (!data) return;
  if ('error' in data) {
    showError(data.error);
    return;
  }
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

wireCopyButtons();
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
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
