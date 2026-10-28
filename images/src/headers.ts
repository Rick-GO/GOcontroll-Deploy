// The security headers of every answer of images.gocontroll.tech: the pages, the assets, the API,
// the downloads, the redirects, the plain pages (503, 404, 405) and the HTTP → HTTPS redirect.
//
// The approach of the intranet Worker (../../src/lib/headers.ts), not that module itself: this is
// a site for customers on another domain, and a change to the intranet's policy should not land
// here unseen. Stricter where the pages allow it: no data: images and no form submissions (the
// sign-in form is sent by its script; signing out is a link). Only the sign-in page may load
// Cloudflare Turnstile (SIGN_IN_CSP). X-Robots-Tag keeps every answer out of search engines.
//
// Its own module, not src/index.ts: workerd refuses a named export of the main module that is not
// a handler.

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The sign-in page: CONTENT_SECURITY_POLICY plus Cloudflare's Turnstile script and its frame
 * (https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
 */
export const SIGN_IN_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  'x-robots-tag': 'noindex, nofollow',
});

/** Add SECURITY_HEADERS to `headers` (in place) and return them. */
export function secure(headers: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

/** A copy of `res` with SECURITY_HEADERS (and `csp` instead of the default); an HTML answer is never cached. */
export function withSecurityHeaders(res: Response, csp?: string): Response {
  const out = new Response(res.body, res);
  secure(out.headers);
  if (csp) out.headers.set('content-security-policy', csp);
  if ((out.headers.get('content-type') || '').includes('text/html')) out.headers.set('cache-control', 'private, no-store');
  return out;
}
