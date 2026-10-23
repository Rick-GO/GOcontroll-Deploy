// The security headers of every answer of this Worker: pages, assets, /pub/ files, API answers
// (refusals and errors included) and the HTTP → HTTPS redirect of src/lib/https.ts. Not the 403
// of the token check (src/index.ts renderError, a page with inline styles).
//
// /pub/ (served without a token, through the Access bypass) had none of them until 2026-10-23
// (F4 of the external security assessment of that day); X-Frame-Options and HSTS are new since
// then everywhere. Its own module, not src/index.ts: workerd refuses a named export of the main
// module that is not a handler.

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * HSTS for this hostname only (no includeSubDomains: other gocontroll.tools hosts are not this
 * Worker's to decide).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
});

/** A copy of `res` with SECURITY_HEADERS; an HTML answer is never cached. */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if ((out.headers.get('content-type') || '').includes('text/html')) out.headers.set('cache-control', 'private, no-store');
  return out;
}
