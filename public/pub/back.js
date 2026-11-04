// @ts-check
// The back arrow in the header of every intranet app: one step back *within this app*, never out of it.
//
// Canonical copy: GOcontroll-Architecture/styling/back.js. Every app serves a byte-identical copy next to
// its signout.js; a fix goes here first and then into every copy (README.md → "Header navigation").
//
// The GOcontroll logo in the header leads to the hub (gocontroll.tools); this arrow never does. Each app
// has its own hostname, so "within this app" means "the previous history entry has this origin". The
// Navigation API answers exactly that: navigation.entries() holds only the contiguous entries of this
// origin, so navigation.canGoBack is false on the first page after the hub, a bookmark or a new tab, and
// navigation.back() can never land outside the app. Every section tab or page that made a history entry
// (a hash route, pushState, another page of the app) is one step; a reload is not.
//
// Without the Navigation API the arrow does not guess from history.length or document.referrer: it goes
// to the start page of the app (data-home, default "/") and is inactive there.
//
// Markup, once per page (the app title stays the link to the start page of the app):
//   <button type="button" class="back" data-back aria-label="Back" title="Back" disabled>…arrow icon…</button>
// The button starts disabled, so without JavaScript it does nothing. Event delegation: a button that is
// added later works too; call it with a "gc:back-refresh" event on document to update its state at once.
(() => {
  /** @type {any} */
  const nav = /** @type {any} */ (globalThis).navigation;
  const hasNav = !!nav && typeof nav.canGoBack === 'boolean';

  /** @param {Element} el */
  const homeOf = (el) => new URL(el.getAttribute('data-home') || '/', location.href);

  /** True on the start page: same path and query, and no route in the hash ("", "#" and "#/" are the same). */
  /** @param {URL} home */
  function atHome(home) {
    const route = (/** @type {string} */ h) => (h === '#' || h === '#/' ? '' : h);
    return home.pathname === location.pathname && home.search === location.search && route(home.hash) === route(location.hash);
  }

  /** @param {Element} el */
  const canStepBack = (el) => (hasNav ? nav.canGoBack : !atHome(homeOf(el)));

  function update() {
    document.querySelectorAll('[data-back]').forEach((el) => {
      const off = !canStepBack(el);
      if (el instanceof HTMLButtonElement) el.disabled = off;
      else el.setAttribute('aria-disabled', String(off));
    });
  }

  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-back]') : null;
    if (!el) return;
    event.preventDefault();
    if (!canStepBack(el)) return update();
    if (hasNav) {
      const result = nav.back();
      // A step that is cancelled or replaced (another click, an unload) is not an error.
      result.committed.catch(() => {});
      result.finished.catch(() => {});
    } else {
      location.assign(homeOf(el).href);
    }
  });

  if (hasNav) nav.addEventListener('currententrychange', update);
  window.addEventListener('hashchange', update);
  window.addEventListener('popstate', update);
  window.addEventListener('pageshow', update);
  document.addEventListener('gc:back-refresh', update);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update);
  else update();
})();
