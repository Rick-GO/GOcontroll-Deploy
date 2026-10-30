// GOcontroll Deploy — Worker entry point.
//
// run_worker_first = true in wrangler.toml, so every request (pages, static assets and the
// API alike) passes through authenticate() before anything is served — except /pub/: brand
// assets, which Access serves through a bypass app. Who may use Deploy is decided here
// (verified Access token + membership of DEPLOY_GROUPS), never in the browser.
//
// Before all of that, plain HTTP is redirected to HTTPS on every path (src/lib/https.ts): Access
// does so for the paths it protects, but not for the /pub/ bypass. /pub/ answers carry the same
// security headers as the pages, assets and API (src/lib/headers.ts; the external security
// assessment of 2026-10-23, F4).
// scheduled() is the daily cron of wrangler.toml: the download counts of finished days, and the
// image download counts of finished months (src/images-stats.ts).
//
// ImagesMail (src/images-mail.ts) is the RPC entrypoint images.gocontroll.tech binds as MAIL: it
// mails a customer's sign-in link, so the Microsoft 365 secret stays in this Worker. AdminApi
// (src/admin-api.ts) is the one the hub's admin Worker binds: the tools of the MCP connector and the
// backup. A class is a handler, so workerd accepts it as a named export of this module (constants
// it does not).

import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { AccessError } from './access';
import { authenticate } from './auth';
import { collectMissingDays } from './downloads';
import { collectFinishedMonths } from './images-stats';
import { withSecurityHeaders, SECURITY_HEADERS } from './lib/headers';
import { HttpError } from './lib/http';
import { httpsRedirect } from './lib/https';
import { PART_SIZE } from './images';
import { firmware } from './routes/firmware';
import { folders } from './routes/folders';
import { images } from './routes/images';
import { meta } from './routes/meta';
import { releases } from './routes/releases';

const PUBLIC_PREFIX = '/pub/';
/**
 * The calls that take an upload (multipart/form-data), with their largest body: a full S1
 * image, compressed, or a Linux package of at most 100 MB, each with room for the form around
 * it. Everything else that writes is JSON.
 */
const MULTIPART_PATHS = new Map([
  ['/api/sign', 4 * 1024 * 1024],
  ['/api/releases', 4 * 1024 * 1024],
  ['/api/linux-releases', 102 * 1024 * 1024],
  ['/api/firmware', 5 * 1024 * 1024],
]);
/** One part of a file for images.gocontroll.tech: its raw bytes (src/images.ts), at most PART_SIZE. */
const PART_PATH = /^\/api\/images\/uploads\/[0-9a-f]{32}\/parts\/\d{1,5}$/;

export const app = new Hono<AppEnv>();

// Plain HTTP: to the same path and query on https://, before /pub/, the token check and the assets.
app.use('*', async (c, next) => {
  const redirect = httpsRedirect(c.req.raw);
  if (redirect) return withSecurityHeaders(redirect);
  await next();
});

// Static files only: no token is read and nothing user-specific is served here.
app.use('/pub/*', async (c) => withSecurityHeaders(await c.env.ASSETS.fetch(c.req.raw)));

// ── Authentication ───────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  if (c.req.path.startsWith(PUBLIC_PREFIX)) return next();
  try {
    c.set('user', await authenticate(c.req.raw, c.env));
  } catch (err) {
    if (!(err instanceof AccessError)) throw err;
    console.warn(`access denied: ${err.message}`);
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'No access to Deploy.' }, 403);
    return c.html(renderError(403, 'No access', 'Deploy is for the colleagues who publish controller firmware. Ask IT to add you if you need it.'), 403);
  }
  await next();
});

// ── API ──────────────────────────────────────────────────────────────────────
const api = new Hono<AppEnv>();

api.use('*', async (c, next) => {
  c.header('cache-control', 'private, no-store');
  // The security headers on every answer: here for the refusals below, after next() for the routes
  // and the errors of app.onError.
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  // State-changing calls must come from this origin. JSON cannot be sent cross-site without a
  // CORS preflight, which this API never grants. An upload is multipart, which a cross-site
  // form can send, so it must carry this Origin (every browser sends one on a POST).
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const self = new URL(c.req.url).origin;
    const origin = c.req.header('origin');
    if (origin && origin !== self) return c.json({ error: 'Invalid origin.' }, 403);
    const type = c.req.header('content-type') || '';
    if (PART_PATH.test(c.req.path)) {
      // Raw bytes, which a cross-site form cannot send with this method and type; still only from here.
      if (!origin || (c.req.header('sec-fetch-site') ?? 'same-origin') !== 'same-origin') return c.json({ error: 'Invalid origin.' }, 403);
      if (c.req.method !== 'PUT' || !type.startsWith('application/octet-stream')) return c.json({ error: 'Expected the bytes of a part (application/octet-stream).' }, 415);
      if (Number(c.req.header('content-length') || 0) > PART_SIZE) return c.json({ error: 'A part is larger than it can be.' }, 413);
    } else if (MULTIPART_PATHS.has(c.req.path)) {
      if (!origin || (c.req.header('sec-fetch-site') ?? 'same-origin') !== 'same-origin') return c.json({ error: 'Invalid origin.' }, 403);
      if (!type.startsWith('multipart/form-data')) return c.json({ error: 'Expected an upload (multipart/form-data).' }, 415);
      if (Number(c.req.header('content-length') || 0) > MULTIPART_PATHS.get(c.req.path)!) {
        const error = c.req.path === '/api/linux-releases' ? 'A package is at most 100 MB.'
          : c.req.path === '/api/firmware' ? 'An .srec of a module is at most 4 MB.' : 'The upload is larger than an S1 image can be.';
        return c.json({ error }, 413);
      }
    } else if (!type.startsWith('application/json')) {
      return c.json({ error: 'Expected JSON.' }, 415);
    }
  }
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
});

api.route('/', meta);
api.route('/', folders);
api.route('/', releases);
api.route('/', firmware);
api.route('/', images);
api.all('*', (c) => c.json({ error: 'Not found.' }, 404));

app.route('/api', api);

// ── Pages and assets ─────────────────────────────────────────────────────────
app.all('*', async (c) => withSecurityHeaders(await c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ ...err.extra, error: err.message, field: err.field }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(collectMissingDays(env, controller.scheduledTime).then((w) => {
      if (!w.configured) return;
      console.log(`downloads: ${w.fetched} day(s) stored, ${w.missingDays} still without counts${w.error ? `; ${w.error}` : ''}`);
    }));
    ctx.waitUntil(collectFinishedMonths(env, new Date(controller.scheduledTime)).then(
      (r) => { if (r.stored.length) console.log(`images stats: ${r.stored.join(', ')} stored`); },
      (err) => console.error(`images stats: ${(err as Error).message}`),
    ));
  },
} satisfies ExportedHandler<Env>;

export { AdminApi } from './admin-api';
export { ImagesMail } from './images-mail';
export { RelationUse } from './relation-use';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch]
));

/**
 * Minimal, self-contained page for 403 (assets are behind the same check). Inline styles, so it
 * goes out without the CSP of SECURITY_HEADERS (as does the JSON 403 of the token check).
 */
function renderError(status: number, title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Deploy</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#1a1a1a;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="background:#fff;border:1px solid #e2e2e2;border-top:3px solid #e94e25;border-radius:12px;padding:40px 44px;max-width:400px;margin:16px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.10)">
<h1 style="font-size:17px;font-weight:600;margin:0 0 8px">${esc(title)}</h1>
<p style="font-size:13px;color:#6b7280;margin:0">${esc(message)}</p>
<p style="font-size:11px;color:#6b7280;margin:24px 0 0">HTTP ${status}</p>
</div></body></html>`;
}
