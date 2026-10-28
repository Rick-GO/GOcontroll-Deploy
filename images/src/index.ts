// gocontroll-images: images.gocontroll.tech, where GOcontroll's customers download Linux images
// for the Moduline L4, M1 and HMI1 and the tools to flash them.
//
// run_worker_first = true (images/wrangler.toml), so every request passes through here, in this
// order:
//   1. plain HTTP → the same path and query on https:// (../../src/lib/https.ts);
//   2. IMAGES_AUD empty (the Access application does not exist yet) → 503 "Downloads are being
//      set up" for everything: the page, the assets, the API and the files (fail closed);
//   3. the Access token verified (../../src/access.ts), or 403; the e-mail address comes only from
//      that token. Locally DEV_USER_EMAIL on a localhost URL stands in for it (src/auth.ts);
//   4. GET or HEAD only, then:
//        /api/catalogue   { email, catalogue }: manifest.json, parsed (empty when there is none)
//        /files/<path>    a file of a published release (src/files.ts), logged once per download
//        anything else    the static page and its assets (images/public), or 404
// Every answer carries the security headers (src/headers.ts).
//
// The bucket's layout and manifest.json are the contract with the intranet Worker of this repo:
// ../../src/images-format.ts. Only default exports here: workerd refuses a named export of the
// main module that is not a handler.

import { AccessError } from '../../src/access';
import { httpsRedirect } from '../../src/lib/https';
import { devUser, verifiedEmail } from './auth';
import { loadCatalogue } from './catalogue';
import type { Env } from './env';
import { requestedPath, serveFile, FILES_PREFIX } from './files';
import { withSecurityHeaders } from './headers';
import { json, methodNotAllowed, notFound, notSetUp, refused, unavailable } from './respond';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const redirect = httpsRedirect(request);
    if (redirect) return withSecurityHeaders(redirect);

    const url = new URL(request.url);
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/');

    let email = devUser(request, env);
    if (email === null) {
      if (!env.IMAGES_AUD) return notSetUp(api);
      try {
        email = await verifiedEmail(request, env);
      } catch (err) {
        if (err instanceof AccessError) {
          console.warn(`access denied: ${err.message}`);
          return refused(api);
        }
        // The team's signing keys could not be fetched: not the customer's fault, and no reason to let anyone in.
        console.error(`access check failed: ${(err as Error).message}`);
        return unavailable(api);
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(api);

    try {
      if (api) {
        if (url.pathname !== '/api/catalogue') return notFound(true);
        return json(200, { email, catalogue: await loadCatalogue(env.IMAGES_BUCKET) });
      }
      if (url.pathname.startsWith(FILES_PREFIX)) {
        const path = requestedPath(url.pathname);
        if (path === null) return notFound(false);
        return await serveFile(request, env, ctx, email, await loadCatalogue(env.IMAGES_BUCKET), path);
      }
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 404) return notFound(false);
      return withSecurityHeaders(asset);
    } catch (err) {
      console.error(err);
      return unavailable(api);
    }
  },
} satisfies ExportedHandler<Env>;
