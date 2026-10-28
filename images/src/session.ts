// Who is asking? images.gocontroll.tech has no Access application and no accounts: a customer types
// an e-mail address, gets a link by mail (src/access.ts) and opening it sets a session cookie. Both
// are tokens this Worker signs itself with SESSION_KEY (Secrets Store IMAGES_SESSION_KEY):
//
//   l.<payload>.<sig>   the link in the mail: { e: address, x: expiry, n: where to go }, LINK_TTL_SECONDS
//   s.<payload>.<sig>   the cookie __Host-images-session: { e: address, x: expiry }, SESSION_TTL_SECONDS
//
// payload = base64url(JSON), sig = base64url(HMAC-SHA256(key, "<kind>.<payload>")). The kind is part
// of what is signed, so a link is never accepted as a cookie or the other way round. Nothing is kept
// on the server: a new SESSION_KEY ends every session and every link at once (everyone asks again).
// The address in a valid token is what the download log records; it was proven by opening the link.
//
// Local development: DEV_USER_EMAIL (images/.dev.vars), honoured only on a localhost URL.

import { ACCESS_MAIL_PREFIX, DOWNLOAD_PAGE_PREFIX, isReleaseFilePath, LINK_TTL_SECONDS, SESSION_TTL_SECONDS } from '../../src/images-format';
import { isLocalHost } from '../../src/lib/https';
import { readSecret } from '../../src/lib/secret';
import type { Env } from './env';

export const SESSION_COOKIE = '__Host-images-session';

type Kind = 'l' | 's';
interface Payload { e: string; x: number; n?: string }
export type Verified =
  | { status: 'ok'; email: string; next: string }
  | { status: 'expired'; next: string }
  | { status: 'invalid' };

/** The SESSION_KEY could not be read or is not a key: the caller answers 503, never "signed out". */
export class SessionKeyError extends Error {}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * The HMAC key from SESSION_KEY (base64 of at least 32 random bytes).
 * @throws {SessionKeyError} when the store cannot be read or the value is not such a key
 */
export async function sessionKey(env: Env): Promise<CryptoKey> {
  let raw: string | undefined;
  try {
    raw = await readSecret(env.SESSION_KEY);
  } catch (err) {
    throw new SessionKeyError(`SESSION_KEY could not be read: ${(err as Error).message}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw ?? ''), (c) => c.charCodeAt(0));
  } catch {
    throw new SessionKeyError('SESSION_KEY is not base64');
  }
  if (bytes.length < 32) throw new SessionKeyError('SESSION_KEY is missing or shorter than 32 bytes');
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(key: CryptoKey, kind: Kind, payload: Payload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${kind}.${body}`)));
  return `${kind}.${body}.${b64url(sig)}`;
}

async function verify(key: CryptoKey, kind: Kind, token: string, now: number): Promise<Verified> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== kind || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { status: 'invalid' };
  let payload: Payload;
  try {
    const ok = await crypto.subtle.verify('HMAC', key, fromB64url(parts[2]), enc.encode(`${kind}.${parts[1]}`));
    if (!ok) return { status: 'invalid' };
    payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    return { status: 'invalid' };
  }
  if (!payload || typeof payload.e !== 'string' || !payload.e || typeof payload.x !== 'number') return { status: 'invalid' };
  const next = safeNext(payload.n);
  if (payload.x * 1000 <= now) return { status: 'expired', next };
  return { status: 'ok', email: payload.e, next };
}

/** The token of the link in the mail. */
export const signLink = (key: CryptoKey, email: string, next: string, now: number): Promise<string> =>
  sign(key, 'l', { e: email, x: Math.floor(now / 1000) + LINK_TTL_SECONDS, n: safeNext(next) });

export const verifyLink = (key: CryptoKey, token: string, now: number): Promise<Verified> => verify(key, 'l', token, now);

/** The value of the session cookie. */
export const signSession = (key: CryptoKey, email: string, now: number): Promise<string> =>
  sign(key, 's', { e: email, x: Math.floor(now / 1000) + SESSION_TTL_SECONDS });

export const verifySession = (key: CryptoKey, token: string, now: number): Promise<Verified> => verify(key, 's', token, now);

/** Set-Cookie for a session; HttpOnly, Secure, SameSite=Lax, host-only (__Host- prefix). */
export const sessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`;

/** Set-Cookie that ends the session. */
export const clearedCookie = (): string => `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

/** The session cookie of a request, or null. */
export function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/**
 * The signed-in address of a request: DEV_USER_EMAIL on localhost, else the session cookie's.
 * Null without a (valid, unexpired) cookie.
 * @throws {SessionKeyError} when there is a cookie but the key cannot be read
 */
export async function signedInEmail(request: Request, env: Env, now = Date.now()): Promise<string | null> {
  const dev = devUser(request, env);
  if (dev) return dev;
  const token = cookieValue(request);
  if (!token) return null;
  const result = await verifySession(await sessionKey(env), token, now);
  return result.status === 'ok' ? result.email : null;
}

/** The DEV_USER_EMAIL of a local run (a localhost URL); null anywhere else. */
export function devUser(request: Request, env: Env): string | null {
  if (!env.DEV_USER_EMAIL || !isLocalHost(new URL(request.url))) return null;
  return env.DEV_USER_EMAIL.toLowerCase();
}

/**
 * Where to go after signing in: `/download/<path of a release file>`, or `/`. Anything else (another
 * site, `//host`, `..`, an escape) becomes `/`, so a link can never send anyone off this site.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith(DOWNLOAD_PAGE_PREFIX)) return '/';
  return isReleaseFilePath(raw.slice(DOWNLOAD_PAGE_PREFIX.length)) ? raw : '/';
}

/** The object of an address in access-mails/: an HMAC of the address, so the key does not reveal it. */
export async function accessMailKey(key: CryptoKey, email: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`access-mail:${email}`)));
  return `${ACCESS_MAIL_PREFIX}${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
