// gocontroll-images: images.gocontroll.tech, where GOcontroll's customers download Linux images
// for the Moduline L4, M1 and HMI1 and the tools to flash them. A customer gets in with an e-mail
// address: a link by mail, a session cookie for SESSION_TTL_SECONDS (src/access.ts, src/session.ts).
//
// run_worker_first = true (images/wrangler.toml), so every request passes through here, in this
// order:
//   1. plain HTTP → the same path and query on https:// (../../src/lib/https.ts);
//   2. TURNSTILE_SITE_KEY empty (the sign-in is not set up yet) → 503 "Downloads are being set up"
//      for everything (fail closed); locally DEV_USER_EMAIL on a localhost URL passes;
//   3. the routes:
//        POST /api/access      ask for a link (src/access.ts); the only POST
//        GET  /access?t=…      the link from the mail: the session cookie, then 303 onwards
//        GET  /sign-in         the sign-in page (public; signed in already → 303 onwards)
//        GET  /sign-out        the cookie cleared, 303 to /sign-in?signed-out
//        GET  /                the downloads page             } signed in, else 303 to /sign-in
//        GET  /download/<path> the page that starts one file  }   (with ?next= for a file)
//        GET  /api/catalogue   { email, catalogue }: manifest.json, parsed; signed in, else 401
//        GET|HEAD /files/<path> a file of a published release (src/files.ts), logged once per
//                              download; signed in, else 303 to /sign-in?next=/download/<path>
//        anything else         the static assets (images/public: scripts, stylesheet, brand
//                              images, robots.txt), public: they hold no data; *.html directly: 404
// Every answer carries the security headers (src/headers.ts); the sign-in page may load Turnstile.
//
// The bucket's layout, manifest.json and the mail of the link are the contract with the intranet
// Worker of this repo: ../../src/images-format.ts. Only default exports here: workerd refuses a
// named export of the main module that is not a handler.

import { ACCESS_PATH, DOWNLOAD_PAGE_PREFIX, downloadPagePath, isReleaseFilePath } from '../../src/images-format';
import { httpsRedirect } from '../../src/lib/https';
import { openLink, requestAccess } from './access';
import { loadCatalogue } from './catalogue';
import type { Env } from './env';
import { requestedPath, serveFile, FILES_PREFIX } from './files';
import { SIGN_IN_CSP, withSecurityHeaders } from './headers';
import { json, methodNotAllowed, notFound, notSetUp, notSignedIn, seeOther, unavailable } from './respond';
import { clearedCookie, devUser, safeNext, SessionKeyError, signedInEmail } from './session';

/** A page of images/public by its asset path (`/`, `/sign-in`, `/download`), with the security headers. */
async function page(request: Request, env: Env, assetPath: string, csp?: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), { method: request.method }));
  if (!res.ok) return notFound(false);
  return withSecurityHeaders(res, csp);
}

/** The sign-in page with the widget's site key in #turnstile (data-sitekey). */
async function signInPage(request: Request, env: Env): Promise<Response> {
  const res = await page(request, env, '/sign-in', SIGN_IN_CSP);
  if (res.status !== 200 || request.method === 'HEAD') return res;
  return new HTMLRewriter()
    .on('#turnstile', { element: (el) => { el.setAttribute('data-sitekey', env.TURNSTILE_SITE_KEY); } })
    .transform(res);
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL, api: boolean): Promise<Response> {
  const path = url.pathname;
  if (path === '/api/access') {
    return request.method === 'POST' ? requestAccess(request, env) : methodNotAllowed(true, 'POST');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(api);

  if (path === ACCESS_PATH) return openLink(url, env);
  if (path === '/sign-out') return seeOther('/sign-in?signed-out', { 'set-cookie': clearedCookie() });

  const email = await signedInEmail(request, env);
  if (path === '/sign-in') return email ? seeOther(safeNext(url.searchParams.get('next'))) : signInPage(request, env);

  if (api) {
    if (path !== '/api/catalogue') return notFound(true);
    if (!email) return notSignedIn();
    return json(200, { email, catalogue: await loadCatalogue(env.IMAGES_BUCKET) });
  }
  if (path === '/') return email ? page(request, env, '/') : seeOther('/sign-in');
  if (path.startsWith(DOWNLOAD_PAGE_PREFIX)) {
    if (!isReleaseFilePath(path.slice(DOWNLOAD_PAGE_PREFIX.length))) return notFound(false);
    return email ? page(request, env, '/download') : seeOther(`/sign-in?next=${encodeURIComponent(path)}`);
  }
  if (path.startsWith(FILES_PREFIX)) {
    const file = requestedPath(path);
    if (file === null) return notFound(false);
    if (!email) {
      return seeOther(isReleaseFilePath(file) ? `/sign-in?next=${encodeURIComponent(downloadPagePath(file))}` : '/sign-in');
    }
    return serveFile(request, env, ctx, email, await loadCatalogue(env.IMAGES_BUCKET), file);
  }

  // The pages only by their routes above (the asset handler would serve /index.html and friends).
  if (path.endsWith('.html') || path === '/download' || path === '/index') return notFound(false);
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return notFound(false);
  return withSecurityHeaders(asset);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const redirect = httpsRedirect(request);
    if (redirect) return withSecurityHeaders(redirect);

    const url = new URL(request.url);
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!env.TURNSTILE_SITE_KEY && !devUser(request, env)) return notSetUp(api);

    try {
      return await route(request, env, ctx, url, api);
    } catch (err) {
      // The session key or the bucket could not be read: nobody gets in, nobody is signed out.
      if (err instanceof SessionKeyError) console.error(`session: ${err.message}`);
      else console.error(err);
      return unavailable(api);
    }
  },
} satisfies ExportedHandler<Env>;
