// Test helpers: Access tokens signed with a key of our own (the team's certs endpoint is mocked
// to hand out its public half, as in ../../test/access.test.ts), requests to the Worker, and a
// small published catalogue in the local bucket.

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import { resetAccessCaches } from '../../src/access';
import { catalogueText, CATALOGUE_KEY, emptyCatalogue, type Catalogue } from '../../src/images-format';
import worker from '../src/index';

export const TEAM = 'https://gocontroll.cloudflareaccess.com';
export const AUD = 'test-images-aud';
export const HOST = 'https://images.gocontroll.tech';
const KID = 'kid-images';
const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

const { privateKey, publicKey } = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', publicKey) as JsonWebKey), kid: KID, alg: 'RS256' };

const b64url = (data: string | Uint8Array) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const now = () => Math.floor(Date.now() / 1000);

/** An Access application token for images.gocontroll.tech; `extra` overrides any claim. */
export async function token(extra: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: TEAM, aud: [AUD], email: 'Customer@Example.com', sub: 'otp-1', identity_nonce: `n-${Math.random()}`,
    iat: now(), nbf: now(), exp: now() + 600, ...extra,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
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

/** Mock the team domain (only the certs endpoint exists); forget cached keys. Call in beforeEach. */
export function mockAccess() {
  resetAccessCaches();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** Run one request through the Worker and wait for what it left in waitUntil (the download log). */
export async function run(request: Request, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...overrides } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A request on images.gocontroll.tech with a valid token (unless `auth: false`). */
export async function signedIn(path: string, init: RequestInit & { auth?: boolean } = {}, overrides: Record<string, unknown> = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.auth !== false) headers.set('Cf-Access-Jwt-Assertion', await token());
  return run(new Request(`${HOST}${path}`, { ...init, headers }), overrides);
}

// ── A published catalogue ────────────────────────────────────────────────────

export const ROOTFS = 'images/moduline-headless/2026.11.0/rootfs.ext4.zst';
export const ROOTFS_BYTES = '0123456789abcdefghij'; // 20 bytes
export const OLD_ROOTFS = 'images/moduline-headless/2026.10.0/rootfs.ext4.zst';
export const FLASHER = 'tools/flash-tools/1.4.2/flash.ps1';
/** In the bucket, but its release is a draft: not in manifest.json. */
export const DRAFT = 'images/moduline-headless/2026.12.0/rootfs.ext4.zst';
const SHA = 'a'.repeat(64);

export function sampleCatalogue(): Catalogue {
  return {
    format: 1,
    updated: '2026-10-28T09:00:00.000Z',
    releases: [
      {
        kind: 'image', product: 'moduline-headless', title: 'Moduline headless image', version: '2026.11.0',
        controllers: ['L4', 'M1'], released: '2026-11-01', notes: 'Kernel 6.12.\n<b>Not HTML</b>',
        files: [{ name: 'rootfs.ext4.zst', path: ROOTFS, size: 20, sha256: SHA, role: 'rootfs', platform: 'any' }],
      },
      {
        kind: 'image', product: 'moduline-headless', title: 'Moduline headless image', version: '2026.10.0',
        controllers: ['L4'], released: '2026-10-01', notes: '',
        files: [{ name: 'rootfs.ext4.zst', path: OLD_ROOTFS, size: 5, sha256: SHA, role: 'rootfs', platform: 'any' }],
      },
      {
        kind: 'tool', product: 'flash-tools', title: 'Flash tools', version: '1.4.2',
        controllers: [], released: '2026-09-15', notes: 'For Windows.',
        files: [{ name: 'flash.ps1', path: FLASHER, size: 3, sha256: SHA, role: 'script', platform: 'windows' }],
      },
    ],
  };
}

/** Put the sample catalogue, its files and a draft's file into the local bucket. */
export async function publishSample(catalogue: Catalogue = sampleCatalogue()) {
  await env.IMAGES_BUCKET.put(CATALOGUE_KEY, catalogueText(catalogue), { httpMetadata: { contentType: 'application/json' } });
  await env.IMAGES_BUCKET.put(ROOTFS, ROOTFS_BYTES);
  await env.IMAGES_BUCKET.put(OLD_ROOTFS, 'old!!');
  await env.IMAGES_BUCKET.put(FLASHER, 'ps1');
  await env.IMAGES_BUCKET.put(DRAFT, 'draft');
}

export const EMPTY = emptyCatalogue();

/** The objects of the download log, with their custom metadata. */
export async function downloadLog() {
  const listed = await env.IMAGES_BUCKET.list({ prefix: 'downloads/', include: ['customMetadata'] });
  return listed.objects;
}
