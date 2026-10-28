// The answers that are not the page or a file: JSON for /api, and small self-contained HTML
// pages for 503 (not set up yet), 403, 404, 405 and errors. Those pages load nothing (no
// stylesheet, no script, no image): while IMAGES_AUD is empty or the token is refused, the assets
// are refused too, and the CSP forbids inline styles. Browser defaults are enough for two lines.

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

/** IMAGES_AUD is empty: the Access application does not exist yet, so nothing is served. */
export const SETUP_MESSAGE = 'Downloads are being set up. Please try again later.';
export function notSetUp(api: boolean): Response {
  const extra = { 'retry-after': '3600' };
  return api
    ? json(503, { error: SETUP_MESSAGE }, extra)
    : plainPage(503, 'Downloads are being set up', 'The GOcontroll download site is not open yet. Please try again later.', extra);
}

export function refused(api: boolean): Response {
  return api
    ? json(403, { error: 'You are not signed in. Reload the page to sign in again.' })
    : plainPage(403, 'Not signed in', 'Your sign-in could not be verified. Reload the page to sign in again.');
}

export function notFound(api: boolean): Response {
  return api
    ? json(404, { error: 'Not found.' })
    : plainPage(404, 'Not found', 'There is nothing here. The downloads are on the start page of images.gocontroll.tech.');
}

export function methodNotAllowed(api: boolean): Response {
  const extra = { allow: 'GET, HEAD' };
  return api
    ? json(405, { error: 'Only GET and HEAD are served here.' }, extra)
    : plainPage(405, 'Method not allowed', 'This site only serves pages and downloads.', extra);
}

export function unavailable(api: boolean): Response {
  return api
    ? json(503, { error: 'The downloads cannot be read right now. Please try again in a moment.' })
    : plainPage(503, 'Try again in a moment', 'The downloads cannot be read right now. Please try again in a moment.');
}
