// The answers that are not a page or a file: JSON for /api, redirects, and small self-contained
// HTML pages for 503 (not set up yet, or a store or bucket that cannot be read), 404, 405 and
// errors. Those pages load nothing (no stylesheet, no script, no image): the CSP forbids inline
// styles, and browser defaults are enough for two lines.

import { secure } from './headers';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch]
));

/** A JSON answer, never cached, with the security headers. */
export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = secure(new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...extra }));
  return new Response(JSON.stringify(body), { status, headers });
}

/** A minimal HTML page, never cached, with the security headers. */
export function plainPage(status: number, title: string, message: string, extra: Record<string, string> = {}): Response {
  const html = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · GOcontroll Downloads</title></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><small>GOcontroll Downloads · HTTP ${status}</small></p></main></body></html>
`;
  const headers = secure(new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', ...extra }));
  return new Response(html, { status, headers });
}

/** 303 to a path of this site (never another site: callers pass a path from safeNext or a constant). */
export function seeOther(location: string, extra: Record<string, string> = {}): Response {
  const headers = secure(new Headers({ location, 'cache-control': 'private, no-store', ...extra }));
  return new Response(null, { status: 303, headers });
}

/** TURNSTILE_SITE_KEY is empty: the sign-in is not set up yet, so nothing is served. */
export const SETUP_MESSAGE = 'Downloads are being set up. Please try again later.';
export function notSetUp(api: boolean): Response {
  const extra = { 'retry-after': '3600' };
  return api
    ? json(503, { error: SETUP_MESSAGE }, extra)
    : plainPage(503, 'Downloads are being set up', 'The GOcontroll download site is not open yet. Please try again later.', extra);
}

/** The API without a session: the page sends the customer to /sign-in. */
export function notSignedIn(): Response {
  return json(401, { error: 'You are not signed in.', signIn: '/sign-in' });
}

export function notFound(api: boolean): Response {
  return api
    ? json(404, { error: 'Not found.' })
    : plainPage(404, 'Not found', 'There is nothing here. The downloads are on the start page of images.gocontroll.tech.');
}

export function methodNotAllowed(api: boolean, allow = 'GET, HEAD'): Response {
  const extra = { allow };
  return api
    ? json(405, { error: `Only ${allow} is accepted here.` }, extra)
    : plainPage(405, 'Method not allowed', 'This site only serves pages and downloads.', extra);
}

export function unavailable(api: boolean): Response {
  return api
    ? json(503, { error: 'The downloads cannot be read right now. Please try again in a moment.' })
    : plainPage(503, 'Try again in a moment', 'The downloads cannot be read right now. Please try again in a moment.');
}
