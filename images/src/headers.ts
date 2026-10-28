// The security headers of every answer of images.gocontroll.tech: the page, the assets, the API,
// the downloads, the plain pages (503, 403, 404, 405) and the HTTP → HTTPS redirect.
//
// The approach of the intranet Worker (../../src/lib/headers.ts), not that module itself: this is
// a site for customers on another domain, and a change to the intranet's policy should not land
// here unseen. Stricter where the page allows it: no data: images and no form submissions (the
// page has no form; signing out is a link).
//
// Its own module, not src/index.ts: workerd refuses a named export of the main module that is not
// a handler.

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * HSTS for this hostname only (no includeSubDomains: the other gocontroll.tech hosts serve
 * controllers, some of which may still fetch over plain HTTP).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
});

/** Add SECURITY_HEADERS to `headers` (in place) and return them. */
export function secure(headers: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

/** A copy of `res` with SECURITY_HEADERS; an HTML answer is never cached. */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  secure(out.headers);
  if ((out.headers.get('content-type') || '').includes('text/html')) out.headers.set('cache-control', 'private, no-store');
  return out;
}
