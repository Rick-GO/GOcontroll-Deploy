// Plain HTTP never serves anything: the Worker answers an http:// request with a redirect to the
// same path and query on https://, before anything else runs. Access does that for the paths it
// protects, but not for the /pub/ bypass, which was served over plain HTTP (the external security
// assessment of 2026-10-23, F4: GOcontroll-Team/docs/security/
// external-security-assessment-configurator-2026-10-23.md). Per Worker, never a zone-wide
// "Always Use HTTPS": controllers may fetch apt., firmware. and deploy.gocontroll.com over plain
// HTTP, and a redirect there is a contract change.
//
// The same file as GOcontroll-Configurator's src/lib/https.ts (where it was fixed first): keep
// the copies in step.
//
// `wrangler dev` serves http://localhost: local hosts are never redirected (the same hosts the
// DEV_USER bypass of src/auth.ts accepts).

/** The hosts of `wrangler dev`: plain HTTP stays allowed there. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export const isLocalHost = (url: URL): boolean => LOCAL_HOSTS.has(url.hostname);

/**
 * An http:// request (not on a local host) as a redirect to the same path and query on https://:
 * 301 for GET and HEAD, 308 for every other method, so a browser repeats it with its method and
 * body. Null for anything else.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' || isLocalHost(url)) return null;
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  return new Response(null, { status, headers: { location: `https://${url.hostname}${url.pathname}${url.search}` } });
}
