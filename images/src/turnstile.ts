// Cloudflare Turnstile on the sign-in form: the page sends the widget's token as the body field
// `turnstile`, the Worker verifies it once with siteverify (the secret from the Secrets Store,
// IMAGES_TURNSTILE_SECRET) and checks that it was solved on this site's hostname for the action
// `access`. Every link is a mail from noreply@gocontroll.com to an address someone typed, so no
// mail goes out without it. Fail closed: no secret (or the placeholder not-set), no answer or any
// doubt is a refusal.
// Adapted from GOcontroll-Configurator (src/public/turnstile.ts): one action here.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

import { readSecret, type SecretSource } from '../../src/lib/secret';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The widget's action on the sign-in page (public/sign-in.js). */
export const TURNSTILE_ACTION = 'access';
/** Cloudflare: a token is at most 2048 characters. */
const TOKEN_MAX = 2048;

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'rejected' | 'hostname' | 'action' | 'unavailable' };

/**
 * Verify a token solved on `hostname`. `missing`: no usable token; `rejected`: siteverify says no
 * (expired, used already, invalid); `hostname` / `action`: solved elsewhere; `unavailable`: no
 * secret, the store or siteverify could not be reached.
 */
export async function verifyTurnstile(secretSource: SecretSource, hostname: string, token: unknown, ip: string | null): Promise<TurnstileOutcome> {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return { ok: false, reason: 'missing' };
  let secret: string | undefined;
  try {
    secret = await readSecret(secretSource);
  } catch (err) {
    console.error(`turnstile: the secret could not be read: ${(err as Error).message}`);
    return { ok: false, reason: 'unavailable' };
  }
  if (!secret || secret === 'not-set') {
    console.error('turnstile: no secret yet (IMAGES_TURNSTILE_SECRET is not set)');
    return { ok: false, reason: 'unavailable' };
  }
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  let data: { success?: unknown; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`turnstile: siteverify answered HTTP ${res.status}`);
      return { ok: false, reason: 'unavailable' };
    }
    data = await res.json();
  } catch (err) {
    console.error(`turnstile: siteverify failed: ${(err as Error).message}`);
    return { ok: false, reason: 'unavailable' };
  }
  if (data.success !== true) {
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'].map(String).join(',') : '';
    console.warn(`turnstile: rejected (${codes || 'no error code'})`);
    return { ok: false, reason: codes.includes('internal-error') ? 'unavailable' : 'rejected' };
  }
  const got = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : '';
  if (got !== hostname.toLowerCase()) {
    console.warn(`turnstile: solved on "${got}", expected "${hostname}"`);
    return { ok: false, reason: 'hostname' };
  }
  if (data.action !== TURNSTILE_ACTION) {
    console.warn(`turnstile: action "${String(data.action)}", expected "${TURNSTILE_ACTION}"`);
    return { ok: false, reason: 'action' };
  }
  return { ok: true };
}
