// Test helpers: session cookies signed with the test key (the one test/setup.ts puts in the local
// Secrets Store), requests to the Worker, a stubbed Turnstile siteverify, a recording stand-in for
// the intranet's ImagesMail, and a small published catalogue in the local bucket.

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import { catalogueText, CATALOGUE_KEY, emptyCatalogue, type AccessLinkMail, type AccessLinkResult, type Catalogue } from '../../src/images-format';
import worker from '../src/index';
import { SESSION_COOKIE, signSession } from '../src/session';

export const HOST = 'https://images.gocontroll.tech';
export const EMAIL = 'customer@example.com';
/** 32 fixed bytes, base64: SESSION_KEY in the local store. */
export const TEST_SESSION_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
export const TEST_TURNSTILE_SECRET = 'test-turnstile-secret';

/** The HMAC key of TEST_SESSION_KEY, as src/session.ts imports it. */
export const testKey = (raw = TEST_SESSION_KEY) => crypto.subtle.importKey(
  'raw', Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
);

/** A Cookie header with a session for `email` (signed at `now`). */
export async function sessionCookieHeader(email = EMAIL, now = Date.now()): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(await testKey(), email, now)}`;
}

/**
 * Empty the local bucket. The pool keeps storage between tests (and the files run one after the
 * other, images/vitest.config.ts), so every test starts from an empty bucket. Call in beforeEach.
 */
export async function emptyBucket() {
  for (;;) {
    const listed = await env.IMAGES_BUCKET.list({ limit: 1000 });
    if (!listed.objects.length) return;
    await env.IMAGES_BUCKET.delete(listed.objects.map((o) => o.key));
  }
}

/** Run one request through the Worker and wait for what it left in waitUntil (the download log). */
export async function run(request: Request, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...overrides } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A request on images.gocontroll.tech with a session cookie (unless `auth: false`). */
export async function signedIn(path: string, init: RequestInit & { auth?: boolean } = {}, overrides: Record<string, unknown> = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.auth !== false && !headers.has('cookie')) headers.set('cookie', await sessionCookieHeader());
  return run(new Request(`${HOST}${path}`, { ...init, headers }), overrides);
}

// ── Asking for a link ────────────────────────────────────────────────────────

/** What siteverify answers in a test: success on images.gocontroll.tech for `access`, unless changed. */
export type Siteverify = { success: boolean; hostname?: string; action?: string; 'error-codes'?: string[] } | 'down';

/** Stub every fetch: siteverify answers `answer`; anything else fails the test. Returns the spy. */
export function stubSiteverify(answer: Siteverify = { success: true, hostname: 'images.gocontroll.tech', action: 'access' }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      if (answer === 'down') throw new TypeError('network down');
      return Response.json(answer);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** A stand-in for the intranet's ImagesMail that records what it was asked to send. */
export function recordingMail(result: AccessLinkResult | 'throw' = { ok: true }) {
  const sent: AccessLinkMail[] = [];
  return {
    sent,
    MAIL: {
      async sendAccessLink(mail: AccessLinkMail): Promise<AccessLinkResult> {
        sent.push(mail);
        if (result === 'throw') throw new Error('service unavailable');
        return result;
      },
    },
  };
}

/** A rate limiter that always lets through (or never, with `false`). */
export const limiter = (success = true) => ({ limit: async () => ({ success }) });

/** POST /api/access as the sign-in page sends it. */
export function askForLink(body: unknown, init: { origin?: string; contentType?: string; ip?: string } = {}, overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    origin: init.origin ?? HOST,
    'content-type': init.contentType ?? 'application/json',
    'cf-connecting-ip': init.ip ?? '203.0.113.7',
  };
  return run(new Request(`${HOST}/api/access`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), {
    RL_ACCESS: limiter(), ...overrides,
  });
}

// ── A published catalogue ────────────────────────────────────────────────────

export const ROOTFS = 'images/moduline-l4/2026.11.0/rootfs.ext4.zst';
export const ROOTFS_BYTES = '0123456789abcdefghij'; // 20 bytes
export const OLD_ROOTFS = 'images/moduline-l4/2026.10.0/rootfs.ext4.zst';
/** The complete image for UUU (role package) of another controller. */
export const PACKAGE = 'images/moduline-hmi1-107-av123/2026.11.0/moduline-hmi1-107-av123-2026.11.0.zip';
/** In the bucket, but its release is a draft: not in manifest.json. */
export const DRAFT = 'images/moduline-l4/2026.12.0/rootfs.ext4.zst';
const SHA = 'a'.repeat(64);

export function sampleCatalogue(): Catalogue {
  return {
    format: 4,
    updated: '2026-10-28T09:00:00.000Z',
    releases: [
      {
        controller: 'L4', type: '', version: '2026.11.0', released: '2026-11-01', notes: 'Kernel 6.12.\n<b>Not HTML</b>',
        files: [{ name: 'rootfs.ext4.zst', path: ROOTFS, size: 20, sha256: SHA, role: 'rootfs', platform: 'any' }],
      },
      {
        controller: 'L4', type: '', version: '2026.10.0', released: '2026-10-01', notes: '',
        files: [{ name: 'rootfs.ext4.zst', path: OLD_ROOTFS, size: 5, sha256: SHA, role: 'rootfs', platform: 'any' }],
      },
      {
        controller: 'HMI1', type: '1.07 - AV123', version: '2026.11.0', released: '2026-09-15', notes: 'Everything UUU needs.',
        files: [{ name: 'moduline-hmi1-107-av123-2026.11.0.zip', path: PACKAGE, size: 3, sha256: SHA, role: 'package', platform: 'any' }],
      },
    ],
  };
}

/** Put the sample catalogue, its files and a draft's file into the local bucket. */
export async function publishSample(catalogue: Catalogue = sampleCatalogue()) {
  await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText(catalogue), { httpMetadata: { contentType: 'application/json' } });
  await env.IMAGES_BUCKET.put(ROOTFS, ROOTFS_BYTES);
  await env.IMAGES_BUCKET.put(OLD_ROOTFS, 'old!!');
  await env.IMAGES_BUCKET.put(PACKAGE, 'zip');
  await env.IMAGES_BUCKET.put(DRAFT, 'draft');
}

export const EMPTY = emptyCatalogue();

/** The objects of the download log, with their custom metadata. */
export async function downloadLog() {
  const listed = await env.IMAGES_BUCKET.list({ prefix: 'downloads/', include: ['customMetadata'] });
  return listed.objects;
}
