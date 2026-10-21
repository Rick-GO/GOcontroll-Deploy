// Who gets into Deploy: a verified Access token for this app AND membership of
// DEPLOY_GROUPS (fail closed). The token checks themselves (signature, issuer, audience,
// expiry) are the shared src/access.ts, covered in depth by GOcontroll-CRM's
// test/access.test.ts; here the Worker end to end. Adapted from GOcontroll-Logistic.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { extractGroupIds, resetAccessCaches } from '../src/access';
import { isDeployMember } from '../src/auth';
import worker from '../src/index';

const TEAM = 'https://gocontroll.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const KID = 'kid-1';
const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

const { privateKey, publicKey } = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', publicKey) as JsonWebKey), kid: KID, alg: 'RS256' };

const b64url = (data: string | Uint8Array) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function sign(payload: object) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const token = (extra = {}) => sign({
  iss: TEAM, aud: [AUD], email: 'Jane@GOcontroll.com', sub: 'u1', identity_nonce: `n-${Math.random()}`,
  iat: now(), nbf: now(), exp: now() + 600, ...extra,
});

let identity: object | null;
beforeEach(() => {
  resetAccessCaches();
  identity = { email: 'jane@gocontroll.com', name: 'Jane Doe | GOcontroll', groups: [{ id: 'GID-DEP', name: 'CF_Deploy' }] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [publicJwk] });
    if (url.endsWith('/cdn-cgi/access/get-identity')) return identity ? Response.json(identity) : new Response('no', { status: 401 });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

// In production DEPLOY_GROUPS holds the object ID(s) of the Entra group(s) that may publish.
const prod = (path: string, headers: Record<string, string> = {}, overrides: Record<string, unknown> = {}) =>
  worker.fetch(new Request(`https://deploy.gocontroll.tools${path}`, { headers }), { ...env, DEPLOY_GROUPS: 'GID-DEP', ...overrides } as typeof env);

describe('the Worker', () => {
  test('a member of DEPLOY_GROUPS with a valid token gets in', async () => {
    const res = await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'jane@gocontroll.com', name: 'Jane Doe', groups: ['GID-DEP', 'CF_Deploy'] });
  });

  test('a valid token is not enough: without the group, or when the group lookup fails, no access', async () => {
    identity = { email: 'jane@gocontroll.com', name: 'Jane', groups: [{ id: 'GID-CRM', name: 'CF_CRM' }] };
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() })).status).toBe(403);
    identity = null;
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() })).status).toBe(403);
    const page = await prod('/', { 'Cf-Access-Jwt-Assertion': await token() });
    expect(page.status).toBe(403);
    expect(await page.text()).toMatch(/colleagues who publish controller firmware/);
  });

  test('only the object ID counts (any case); a display name never does; empty lets nobody in', async () => {
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() }, { DEPLOY_GROUPS: 'gid-dep' })).status).toBe(200);
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() }, { DEPLOY_GROUPS: 'CF_Deploy' })).status).toBe(403);
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() }, { DEPLOY_GROUPS: '' })).status).toBe(403);
    // Anyone can make a Microsoft 365 group named like the object ID of the Deploy group.
    identity = { email: 'jane@gocontroll.com', name: 'Jane', groups: [{ id: 'GID-MINE', name: 'GID-DEP' }, 'GID-DEP'] };
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token() })).status).toBe(403);
  });

  test('no token, or a token for another Access app, gets 403', async () => {
    expect((await prod('/api/me')).status).toBe(403);
    expect((await prod('/api/me', { 'Cf-Access-Jwt-Assertion': await token({ aud: ['the-crm'] }) })).status).toBe(403);
    expect((await prod('/styles.css')).status).toBe(403);
    expect((await prod('/api/overview')).status).toBe(403);
    expect((await prod('/api/folders/GOCO/key')).status).toBe(403);
  });

  test('/pub/ is served without a token; nothing else is', async () => {
    let served = '';
    const assets = { fetch: async (r: Request) => { served = new URL(r.url).pathname; return new Response('asset'); } };
    expect((await prod('/pub/logo.svg', {}, { ASSETS: assets })).status).toBe(200);
    expect(served).toBe('/pub/logo.svg');
    expect((await prod('/pubx', {}, { ASSETS: assets })).status).toBe(403);
  });

  test('the DEV_USER bypass works on localhost only, and still needs the group', async () => {
    const dev = { DEV_USER_EMAIL: 'dev@gocontroll.com', DEV_USER_GROUPS: 'CF_Deploy' };
    expect((await prod('/api/me', {}, dev)).status).toBe(403);
    const local = (o: Record<string, unknown>) => worker.fetch(new Request('http://localhost/api/me'), { ...env, ...o } as typeof env);
    expect((await local(dev)).status).toBe(200);
    expect((await local({ ...dev, DEV_USER_GROUPS: 'CF_CRM' })).status).toBe(403);
  });

  test('state-changing calls must be same-origin JSON; uploads same-origin multipart with an Origin', async () => {
    const dev = { ...env, DEV_USER_EMAIL: 'dev@gocontroll.com', DEV_USER_GROUPS: 'CF_Deploy' } as typeof env;
    const send = (path: string, headers: Record<string, string>, body: BodyInit = '{}') =>
      worker.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers, body }), dev);
    expect((await send('/api/folders/GOCO/key', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send('/api/folders/GOCO/key', { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    // A cross-site form can send multipart without a preflight: Origin is required and must match.
    const form = () => { const f = new FormData(); f.append('appId', 'GOCO'); return f; };
    expect((await send('/api/releases', {}, form())).status).toBe(403);
    expect((await send('/api/releases', { origin: 'https://evil.example' }, form())).status).toBe(403);
    expect((await send('/api/sign', { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' }, form())).status).toBe(403);
    expect((await send('/api/releases', { origin: 'http://localhost', 'content-type': 'application/json' })).status).toBe(415);
    expect((await send('/api/releases', { origin: 'http://localhost' }, form())).status).toBe(400); // past the guard: no file
  });
});

test('isDeployMember is case-insensitive and needs one listed group', () => {
  expect(isDeployMember(['gid-1'], 'GID-1')).toBe(true);
  expect(isDeployMember(['GID-2'], 'GID-1, GID-3')).toBe(false);
  expect(isDeployMember(['gid-3'], 'GID-1, GID-3')).toBe(true);
  expect(isDeployMember(['GID-1'], '')).toBe(false);
});

test('extractGroupIds keeps only the id of group objects', () => {
  expect(extractGroupIds({ groups: [{ id: 'a', name: 'CF_Deploy' }, 'b', { name: 'c' }] }, { custom: { groups: [{ id: 'd' }] } })).toEqual(['a', 'd']);
});
