// Who gets in: nobody while IMAGES_AUD is empty (503 everywhere), then anyone with a verified
// Access token for this application (no group check), locally DEV_USER_EMAIL on localhost only.
// Plain HTTP is redirected first, and every answer carries the security headers.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/headers';
import { emptyBucket, HOST, mockAccess, publishSample, ROOTFS, run, signedIn, token } from './helpers';

let fetchMock: ReturnType<typeof mockAccess>;
beforeEach(async () => {
  fetchMock = mockAccess();
  await emptyBucket();
  await publishSample();
});
afterEach(() => vi.restoreAllMocks());

const expectSecurityHeaders = (res: Response, what: string) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), `${what}: ${k}`).toBe(v);
};

describe('fail closed while IMAGES_AUD is empty', () => {
  test('every request gets 503: the page, the assets, the API and the files, even with a token', async () => {
    const noAud = { IMAGES_AUD: '' };
    for (const path of ['/', '/styles.css', '/app.js', '/logo.svg', '/nope', `/files/${ROOTFS}`]) {
      const res = await signedIn(path, {}, noAud);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(await res.text(), path).toMatch(/Downloads are being set up/);
      expect(res.headers.get('retry-after'), path).toBe('3600');
      expect(res.headers.get('cache-control'), path).toBe('private, no-store');
      expectSecurityHeaders(res, path);
    }
    const api = await signedIn('/api/catalogue', {}, noAud);
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'Downloads are being set up. Please try again later.' });
    expectSecurityHeaders(api, 'api');
    // Not even the team's keys were fetched, and nothing was logged.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await env.IMAGES_BUCKET.list({ prefix: 'downloads/' })).objects).toEqual([]);
  });

  test('the setup page loads nothing: no stylesheet, script, image or inline style', async () => {
    const html = await (await signedIn('/', {}, { IMAGES_AUD: '' })).text();
    expect(html).not.toMatch(/<link|<script|<img|<style|style=/i);
  });

  test('DEV_USER_EMAIL does not open it off localhost', async () => {
    const res = await run(new Request(`${HOST}/api/catalogue`), { IMAGES_AUD: '', DEV_USER_EMAIL: 'dev@example.com' });
    expect(res.status).toBe(503);
  });
});

describe('the Access token', () => {
  test('a valid token for this application gets in; the e-mail address comes from the token', async () => {
    const res = await signedIn('/api/catalogue');
    expect(res.status).toBe(200);
    expect((await res.json<any>()).email).toBe('customer@example.com');
    // Only the certs were fetched: no get-identity, no groups.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('no token, a forged one, an expired one or one of another Access application: 403', async () => {
    const forged = (await token()).replace(/\.[^.]+$/, '.AAAA');
    const cases: [string, Record<string, string>][] = [
      ['none', {}],
      ['garbage', { 'Cf-Access-Jwt-Assertion': 'not.a.token' }],
      ['forged', { 'Cf-Access-Jwt-Assertion': forged }],
      ['expired', { 'Cf-Access-Jwt-Assertion': await token({ exp: Math.floor(Date.now() / 1000) - 3600 }) }],
      ['intranet app', { 'Cf-Access-Jwt-Assertion': await token({ aud: ['d26a80ee-the-deploy-intranet'] }) }],
      ['other team', { 'Cf-Access-Jwt-Assertion': await token({ iss: 'https://evil.cloudflareaccess.com' }) }],
      ['no e-mail', { 'Cf-Access-Jwt-Assertion': await token({ email: '' }) }],
    ];
    for (const [what, headers] of cases) {
      const api = await signedIn('/api/catalogue', { auth: false, headers });
      expect(api.status, what).toBe(403);
      expect((await api.json<any>()).error, what).toMatch(/not signed in/);
      expectSecurityHeaders(api, what);
      for (const path of ['/', '/styles.css', `/files/${ROOTFS}`]) {
        const res = await signedIn(path, { auth: false, headers });
        expect(res.status, `${what} ${path}`).toBe(403);
        expect(res.headers.get('content-type')).toMatch(/^text\/html/);
        expectSecurityHeaders(res, `${what} ${path}`);
      }
    }
    expect((await env.IMAGES_BUCKET.list({ prefix: 'downloads/' })).objects).toEqual([]);
  });

  test('a plain e-mail header is never believed', async () => {
    const res = await signedIn('/api/catalogue', { auth: false, headers: { 'Cf-Access-Authenticated-User-Email': 'someone@example.com' } });
    expect(res.status).toBe(403);
  });

  test('the team domain unreachable: 503, nobody gets in', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('network down'); });
    expect((await signedIn('/api/catalogue')).status).toBe(503);
    expect((await signedIn('/')).status).toBe(503);
  });
});

describe('local development', () => {
  test('DEV_USER_EMAIL works on localhost only, without an AUD or a token', async () => {
    const dev = { DEV_USER_EMAIL: 'Dev@Example.com', IMAGES_AUD: '' };
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
      const res = await run(new Request(`http://${host}/api/catalogue`), dev);
      expect(res.status, host).toBe(200);
      expect((await res.json<any>()).email).toBe('dev@example.com');
    }
    // Off localhost it is ignored: with an AUD the token is required.
    expect((await run(new Request(`${HOST}/api/catalogue`), { DEV_USER_EMAIL: 'dev@example.com' })).status).toBe(403);
    // On localhost without DEV_USER_EMAIL: the normal path (here: no AUD, so 503).
    expect((await run(new Request('http://localhost/api/catalogue'), { IMAGES_AUD: '' })).status).toBe(503);
  });
});

describe('HTTPS and the security headers', () => {
  test('plain HTTP is redirected to HTTPS on every path, before the AUD and token checks', async () => {
    for (const path of ['/', '/app.js', '/api/catalogue', `/files/${ROOTFS}`, '/nope?x=1']) {
      for (const overrides of [{}, { IMAGES_AUD: '' }]) {
        const res = await run(new Request(`http://images.gocontroll.tech${path}`), overrides);
        expect(res.status, path).toBe(301);
        expect(res.headers.get('location'), path).toBe(`https://images.gocontroll.tech${path}`);
        expectSecurityHeaders(res, path);
      }
    }
    const post = await run(new Request('http://images.gocontroll.tech/api/catalogue', { method: 'POST', body: '{}' }));
    expect(post.status).toBe(308);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the page, an asset, the API, a 404 and a 405 carry the security headers', async () => {
    const page = await signedIn('/');
    const asset = await signedIn('/styles.css');
    const api = await signedIn('/api/catalogue');
    const missing = await signedIn('/nope');
    const missingApi = await signedIn('/api/nope');
    const post = await signedIn('/api/catalogue', { method: 'POST', body: '{}' });
    expect([page.status, asset.status, api.status, missing.status, missingApi.status, post.status]).toEqual([200, 200, 200, 404, 404, 405]);
    for (const [what, res] of Object.entries({ page, asset, api, missing, missingApi, post })) expectSecurityHeaders(res, what);
    expect(page.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(api.headers.get('cache-control')).toBe('private, no-store');
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([
      'content-security-policy', 'referrer-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options',
    ]);
    // No inline script or style may be needed: the policy allows neither, nor data: images.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|data:/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/frame-ancestors 'none'/);
  });
});
