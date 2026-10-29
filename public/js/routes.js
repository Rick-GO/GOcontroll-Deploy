// @ts-check
// The hash routes of the pages (app.js), without the DOM, so the tests can hold them
// (test/pages.test.ts). The tabs, in this order: Applications, Firmware, Images, Key generator.

/** The tabs of the hero band, in their order: [data-tab, label, hash]. */
export const TABS = /** @type {const} */ ([
  ['applications', 'Applications', '#/applications'],
  ['firmware', 'Firmware', '#/firmware'],
  ['images', 'Images', '#/images'],
  ['key-generator', 'Key generator', '#/key-generator'],
]);

/** The page of one application. @param {string} appId */
export const applicationHref = (appId) => `#/applications/${encodeURIComponent(appId)}`;

/**
 * Where an older hash goes now (bookmarks keep working), or null when it is current:
 * #/ and #/status (with their ?q=&show=) → #/applications; #/folders/<APP_ID> →
 * #/applications/<APP_ID>; #/keys → #/key-generator; #/publish and #/sign (milestone 1) → the
 * application of their ?app=, or else Applications.
 * @param {string} path  the hash without "#" and query, e.g. "/folders/GOCO"
 * @param {URLSearchParams} params  its query
 * @returns {string | null}
 */
export function redirectFor(path, params) {
  const query = params.toString();
  if (path === '' || path === '/' || path === '/status') return `#/applications${query ? `?${query}` : ''}`;
  if (path === '/keys') return '#/key-generator';
  const folder = path.match(/^\/folders\/(.+)$/);
  if (folder) return `#/applications/${folder[1]}`;
  if (path === '/publish' || path === '/sign') {
    const app = params.get('app');
    return app ? applicationHref(app) : '#/applications';
  }
  return null;
}

/** The tab a page belongs to (its data-tab). @param {string} path */
export function tabOf(path) {
  if (path === '/firmware') return 'firmware';
  if (path === '/images') return 'images';
  if (path === '/key-generator') return 'key-generator';
  return 'applications';
}
