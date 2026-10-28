// Getting in: POST /api/access mails a link, GET /access?t=<token> (the link) sets the session.
//
// POST /api/access { email, turnstile, next }, from the sign-in page only, in this order:
//   1. same origin (Origin header) and a JSON body of at most 8 kB;
//   2. RL_ACCESS per client IP (a brake: Workers rate limiting is per location and approximate);
//   3. a valid e-mail address (normaliseEmail of ../../src/images-format.ts);
//   4. Turnstile (src/turnstile.ts), solved on this site for the action `access`;
//   5. at most LINKS_PER_HOUR links per address per hour (access-mails/<hmac>, custom metadata `sent`);
//   6. the link signed (src/session.ts) and handed to the intranet's ImagesMail (service binding MAIL),
//      which mails it from noreply@gocontroll.com. Its answer is { ok } or { ok: false, error }.
// The answer never says more about an address than that the link was sent to it.
//
// GET /access?t=<link token>: valid → the session cookie and 303 to where the customer was going
// (the start page, or the download page of one file); expired → the sign-in page saying so (and
// where they were going); anything else → the sign-in page saying the link does not work. Opening
// a link twice within the hour works (a mail scanner may open it first); nothing is kept.

import { ACCESS_PATH, LINKS_PER_HOUR, normaliseEmail, type AccessLinkMail } from '../../src/images-format';
import { isLocalHost } from '../../src/lib/https';
import type { Env } from './env';
import { json, seeOther } from './respond';
import { accessMailKey, safeNext, sessionCookie, sessionKey, signLink, signSession, verifyLink } from './session';
import { verifyTurnstile } from './turnstile';

const BODY_MAX = 8 * 1024;
const HOUR = 60 * 60 * 1000;

/** The origin of this site: the links and the sign-in form. localhost stays itself during `wrangler dev`. */
export function siteOrigin(url: URL, env: Env): string {
  return isLocalHost(url) ? url.origin : new URL(env.SITE_URL).origin;
}

/** The client's IP as Cloudflare saw it; one shared key when the header is missing (local runs). */
const clientIp = (request: Request): string => request.headers.get('cf-connecting-ip')?.trim() || 'unknown';

async function withinRateLimit(env: Env, ip: string): Promise<boolean> {
  if (!env.RL_ACCESS) return true;
  try {
    return (await env.RL_ACCESS.limit({ key: ip })).success;
  } catch (err) {
    // A brake, not a lock: Turnstile and the hourly cap still apply.
    console.error(`rate limit: ${(err as Error).message}`);
    return true;
  }
}

/** Count one link for this address, unless it had LINKS_PER_HOUR in the last hour already. */
async function takeLinkSlot(env: Env, objectKey: string, now: number): Promise<boolean> {
  const head = await env.IMAGES_BUCKET.head(objectKey);
  const recent = (head?.customMetadata?.sent ?? '').split(',').map(Number).filter((t) => Number.isFinite(t) && now - t < HOUR);
  if (recent.length >= LINKS_PER_HOUR) return false;
  await env.IMAGES_BUCKET.put(objectKey, '', { customMetadata: { sent: [...recent, now].join(',') } });
  return true;
}

export async function requestAccess(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const origin = siteOrigin(url, env);
  if (request.headers.get('origin') !== origin) return json(403, { error: 'Ask for a link on the sign-in page.' });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'Send the form as JSON.' });
  }
  const text = await request.text();
  if (text.length > BODY_MAX) return json(413, { error: 'The request is too large.' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
    if (!body || typeof body !== 'object') throw new Error('not an object');
  } catch {
    return json(400, { error: 'Send the form as JSON.' });
  }

  const ip = clientIp(request);
  if (!(await withinRateLimit(env, ip))) {
    return json(429, { error: 'Too many requests from your network. Please wait a minute and try again.' }, { 'retry-after': '60' });
  }
  const email = normaliseEmail(body.email);
  if (!email) return json(400, { error: 'Fill in a valid e-mail address.' });
  const next = safeNext(body.next);

  const check = await verifyTurnstile(env.TURNSTILE_SECRET, new URL(origin).hostname, body.turnstile, ip);
  if (!check.ok) {
    return check.reason === 'unavailable'
      ? json(503, { error: 'The check could not be verified right now. Please try again in a moment.' })
      : json(403, { error: 'The check that you are a person did not pass. Please try again.' });
  }

  const key = await sessionKey(env);
  if (!(await takeLinkSlot(env, await accessMailKey(key, email), now))) {
    return json(429, { error: 'We have sent several links to this address in the last hour. Use the newest one, or try again later.' }, { 'retry-after': '3600' });
  }
  const mail: AccessLinkMail = { email, link: `${origin}${ACCESS_PATH}?t=${await signLink(key, email, next, now)}` };
  if (next !== '/') mail.file = next.slice(next.lastIndexOf('/') + 1);

  let result: Awaited<ReturnType<Env['MAIL']['sendAccessLink']>> | undefined;
  try {
    result = await env.MAIL.sendAccessLink(mail);
  } catch (err) {
    console.error(`access mail: the intranet could not be reached: ${(err as Error).message}`);
  }
  if (!result?.ok) {
    if (result) console.error(`access mail: refused by the intranet (${result.error})`);
    return json(503, { error: 'The e-mail could not be sent right now. Please try again in a few minutes.' });
  }
  return json(200, { ok: true, email });
}

/** GET /access?t=<token>: the link from the mail. */
export async function openLink(url: URL, env: Env, now = Date.now()): Promise<Response> {
  const key = await sessionKey(env);
  const result = await verifyLink(key, url.searchParams.get('t') ?? '', now);
  if (result.status === 'ok') {
    return seeOther(result.next, { 'set-cookie': sessionCookie(await signSession(key, result.email, now)) });
  }
  if (result.status === 'expired') {
    return seeOther(`/sign-in?link=expired${result.next !== '/' ? `&next=${encodeURIComponent(result.next)}` : ''}`);
  }
  return seeOther('/sign-in?link=invalid');
}
