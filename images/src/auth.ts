// Who is asking? images.gocontroll.tech has one Access application, with one login method: a
// one-time PIN mailed to the address the customer types. Access decides who may sign in (its
// policy); the Worker verifies the application token on every request all the same (signature,
// issuer, IMAGES_AUD, expiry: the shared ../../src/access.ts) and takes the e-mail address only from
// that verified token, never from a plain header. There is no group check: a one-time-PIN identity
// has no groups, and any address Access let in may download.
//
// Local development: DEV_USER_EMAIL (images/.dev.vars), honoured only on a localhost URL, as in
// ../../src/auth.ts.

import { verifyAccessJwt } from '../../src/access';
import { isLocalHost } from '../../src/lib/https';
import type { Env } from './env';

/** The DEV_USER_EMAIL of a local run (a localhost URL); null anywhere else. */
export function devUser(request: Request, env: Env): string | null {
  if (!env.DEV_USER_EMAIL || !isLocalHost(new URL(request.url))) return null;
  return env.DEV_USER_EMAIL.toLowerCase();
}

/**
 * The e-mail address in the request's verified Access token, in lower case.
 * @throws {AccessError} when the token is missing or does not hold up
 */
export async function verifiedEmail(request: Request, env: Env): Promise<string> {
  const payload = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), {
    teamDomain: env.TEAM_DOMAIN,
    aud: env.IMAGES_AUD,
  });
  return payload.email.toLowerCase();
}
