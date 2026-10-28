// Who gets in: nobody while TURNSTILE_SITE_KEY is empty (503 everywhere); then whoever opens a link
// that was mailed to their address (POST /api/access → ImagesMail → GET /access?t=…), for
// SESSION_TTL_SECONDS. Locally DEV_USER_EMAIL on localhost only. Plain HTTP is redirected first,
// and every answer carries the security headers.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ACCESS_MAIL_PREFIX, LINK_TOKEN_RE, LINK_TTL_SECONDS, LINKS_PER_HOUR, SESSION_TTL_SECONDS } from '../../src/images-format';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, SIGN_IN_CSP } from '../src/headers';
import { SESSION_COOKIE, safeNext, signLink, signSession, verifyLink, verifySession } from '../src/session';
import {
  askForLink, EMAIL, emptyBucket, HOST, limiter, publishSample, recordingMail, ROOTFS, run, sessionCookieHeader, signedIn, stubSiteverify, testKey,
} from './helpers';

beforeEach(async () => {
  await emptyBucket();
  await publishSample();
});
afterEach(() => vi.restoreAllMocks());

const expectSecurityHeaders = (res: Response, what: string) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k !== 'content-security-policy') expect(res.headers.get(k), `${what}: ${k}`).toBe(v);
  }
  expect(res.headers.get('content-security-policy'), `${what}: csp`).toMatch(/^default-src 'none'/);
};

/** The token of a link as the Worker mailed it. */
const tokenOf = (link: string) => new URL(link).searchParams.get('t') ?? '';

describe('fail closed while TURNSTILE_SITE_KEY is empty', () => {
  test('every request gets 503: pages, assets, API, files, the link and the form, even with a session', async () => {
    const off = { TURNSTILE_SITE_KEY: '' };
    for (const path of ['/', '/sign-in', '/styles.css', '/app.js', '/nope', `/files/${ROOTFS}`, `/download/${ROOTFS}`, '/access?t=x']) {
      const res = await signedIn(path, {}, off);
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toMatch(/Downloads are being set up/);
      expect(res.headers.get('retry-after'), path).toBe('3600');
      expectSecurityHeaders(res, path);
    }
    const api = await signedIn('/api/catalogue', {}, off);
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'Downloads are being set up. Please try again later.' });
    const mail = recordingMail();
    expect((await askForLink({ email: EMAIL, turnstile: 't' }, {}, { ...off, ...mail })).status).toBe(503);
    expect(mail.sent).toEqual([]);
    expect((await env.IMAGES_BUCKET.list({ prefix: 'downloads/' })).objects).toEqual([]);
  });

  test('the setup page loads nothing: no stylesheet, script, image or inline style', async () => {
    const html = await (await signedIn('/', {}, { TURNSTILE_SITE_KEY: '' })).text();
    expect(html).not.toMatch(/<link|<script|<img|<style|style=/i);
  });
});

describe('without a session', () => {
  test('the pages send the browser to the sign-in page, a file link via its download page; the API says 401', async () => {
    const cases: [string, string][] = [
      ['/', '/sign-in'],
      [`/download/${ROOTFS}`, `/sign-in?next=${encodeURIComponent(`/download/${ROOTFS}`)}`],
      [`/files/${ROOTFS}`, `/sign-in?next=${encodeURIComponent(`/download/${ROOTFS}`)}`],
    ];
    for (const [path, location] of cases) {
      const res = await signedIn(path, { auth: false });
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe(location);
      expectSecurityHeaders(res, path);
    }
    const api = await signedIn('/api/catalogue', { auth: false });
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'You are not signed in.', signIn: '/sign-in' });
    expect((await env.IMAGES_BUCKET.list({ prefix: 'downloads/' })).objects).toEqual([]);
  });

  test('a forged, expired or tampered cookie, or a link token as cookie, is no session', async () => {
    const key = await testKey();
    const valid = await signSession(key, EMAIL, Date.now());
    const [kind, body, sig] = valid.split('.');
    const otherBody = btoa(JSON.stringify({ e: 'evil@example.com', x: 9_999_999_999 })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const otherKey = await testKey(btoa('x'.repeat(32)));
    const cookies = [
      'garbage',
      `${kind}.${otherBody}.${sig}`,
      `${kind}.${body}.${'A'.repeat(43)}`,
      await signSession(otherKey, EMAIL, Date.now()),
      await signSession(key, EMAIL, Date.now() - SESSION_TTL_SECONDS * 1000 - 1000),
      await signLink(key, EMAIL, '/', Date.now()),
    ];
    for (const cookie of cookies) {
      const res = await signedIn('/api/catalogue', { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
      expect(res.status, cookie).toBe(401);
    }
    // A cookie of another name, or the right one: the latter gets in.
    expect((await signedIn('/api/catalogue', { headers: { cookie: `other=${valid}` } })).status).toBe(401);
    expect((await signedIn('/api/catalogue', { headers: { cookie: `a=b; ${SESSION_COOKIE}=${valid}` } })).status).toBe(200);
  });

  test('a plain e-mail header is never believed', async () => {
    const res = await signedIn('/api/catalogue', { auth: false, headers: { 'Cf-Access-Authenticated-User-Email': 'someone@example.com' } });
    expect(res.status).toBe(401);
  });

  test('the session key unreadable: 503, nobody gets in and nobody is signed out', async () => {
    const res = await signedIn('/api/catalogue', {}, { SESSION_KEY: 'not base64!' });
    expect(res.status).toBe(503);
    expect((await signedIn('/', {}, { SESSION_KEY: btoa('short') })).status).toBe(503);
  });
});

describe('the sign-in page', () => {
  test('anyone gets it, with the site key in the widget and the Turnstile CSP; signed in already: onwards', async () => {
    const res = await signedIn('/sign-in', { auth: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(SIGN_IN_CSP);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toContain('id="turnstile" data-sitekey="1x00000000000000000000AA"');
    expect(SIGN_IN_CSP).toContain('script-src \'self\' https://challenges.cloudflare.com');
    expect(SIGN_IN_CSP).toContain('frame-src https://challenges.cloudflare.com');
    expect(SIGN_IN_CSP).not.toMatch(/unsafe-inline|unsafe-eval|data:/);

    const back = await signedIn(`/sign-in?next=${encodeURIComponent(`/download/${ROOTFS}`)}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/download/${ROOTFS}`);
    expect((await signedIn('/sign-in?next=https://evil.example')).headers.get('location')).toBe('/');
  });

  test('only the sign-in page may load Turnstile', async () => {
    for (const path of ['/', `/download/${ROOTFS}`, '/app.js']) {
      expect((await signedIn(path)).headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
    }
    expect(CONTENT_SECURITY_POLICY).not.toContain('challenges.cloudflare.com');
  });

  test('signing out clears the cookie', async () => {
    const res = await signedIn('/sign-out');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in?signed-out');
    expect(res.headers.get('set-cookie')).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  });
});

describe('POST /api/access: asking for a link', () => {
  test('a valid request mails a link to this site for that address only, and says so', async () => {
    const verify = stubSiteverify();
    const mail = recordingMail();
    const res = await askForLink({ email: '  Customer@Example.COM ', turnstile: 'tok', next: `/download/${ROOTFS}`, extra: 'ignored' }, {}, mail);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: EMAIL });
    expect(mail.sent).toHaveLength(1);
    const [sent] = mail.sent;
    expect(Object.keys(sent).sort()).toEqual(['email', 'file', 'link']);
    expect(sent.email).toBe(EMAIL);
    expect(sent.file).toBe('rootfs.ext4.zst');
    expect(sent.link.startsWith(`${HOST}/access?t=`)).toBe(true);
    expect(tokenOf(sent.link)).toMatch(LINK_TOKEN_RE);
    // Turnstile was asked once, with the secret, the token and the client's IP.
    expect(verify).toHaveBeenCalledTimes(1);
    const form = verify.mock.calls[0][1]!.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({ secret: 'test-turnstile-secret', response: 'tok', remoteip: '203.0.113.7' });
    // The hourly cap counts it, under a key that does not show the address.
    const caps = await env.IMAGES_BUCKET.list({ prefix: ACCESS_MAIL_PREFIX, include: ['customMetadata'] });
    expect(caps.objects).toHaveLength(1);
    expect(caps.objects[0].key).toMatch(/^access-mails\/[0-9a-f]{64}$/);
    expect(caps.objects[0].key).not.toContain('example');
    expect(caps.objects[0].customMetadata?.sent).toMatch(/^\d+$/);
  });

  test('without ?next= the link goes to the start page and the mail names no file', async () => {
    stubSiteverify();
    const mail = recordingMail();
    expect((await askForLink({ email: EMAIL, turnstile: 'tok' }, {}, mail)).status).toBe(200);
    expect(mail.sent[0].file).toBeUndefined();
    const opened = await run(new Request(mail.sent[0].link));
    expect(opened.headers.get('location')).toBe('/');
  });

  test('from another site, not JSON, too large or not an object: refused before anything else', async () => {
    const verify = stubSiteverify();
    const mail = recordingMail();
    const body = { email: EMAIL, turnstile: 'tok' };
    expect((await askForLink(body, { origin: 'https://evil.example' }, mail)).status).toBe(403);
    expect((await askForLink(body, { origin: 'null' }, mail)).status).toBe(403);
    expect((await askForLink(body, { contentType: 'text/plain' }, mail)).status).toBe(415);
    expect((await askForLink('{ not json', {}, mail)).status).toBe(400);
    expect((await askForLink('"a string"', {}, mail)).status).toBe(400);
    expect((await askForLink({ ...body, pad: 'x'.repeat(9000) }, {}, mail)).status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  test('not an e-mail address: 400, without asking Turnstile', async () => {
    const verify = stubSiteverify();
    const mail = recordingMail();
    for (const email of ['', 'no-at-sign', 'a@b', 'a b@example.com', 'a@exa mple.com', '<a@example.com>', `${'a'.repeat(250)}@example.com`, 42, null]) {
      const res = await askForLink({ email, turnstile: 'tok' }, {}, mail);
      expect(res.status, String(email)).toBe(400);
      expect((await res.json<any>()).error).toBe('Fill in a valid e-mail address.');
    }
    expect(verify).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  test('Turnstile: no token, rejected, another site or action → 403; no secret or siteverify down → 503', async () => {
    const mail = recordingMail();
    const body = { email: EMAIL, turnstile: 'tok' };
    stubSiteverify();
    expect((await askForLink({ email: EMAIL }, {}, mail)).status).toBe(403);
    vi.restoreAllMocks();
    for (const answer of [
      { success: false, 'error-codes': ['invalid-input-response'] },
      { success: true, hostname: 'configurator.gocontroll.com', action: 'access' },
      { success: true, hostname: 'images.gocontroll.tech', action: 'request' },
    ]) {
      stubSiteverify(answer);
      expect((await askForLink(body, {}, mail)).status, JSON.stringify(answer)).toBe(403);
      vi.restoreAllMocks();
    }
    stubSiteverify('down');
    expect((await askForLink(body, {}, mail)).status).toBe(503);
    vi.restoreAllMocks();
    stubSiteverify({ success: false, 'error-codes': ['internal-error'] });
    expect((await askForLink(body, {}, mail)).status).toBe(503);
    vi.restoreAllMocks();
    const verify = stubSiteverify();
    expect((await askForLink(body, {}, { ...mail, TURNSTILE_SECRET: 'not-set' })).status).toBe(503);
    expect(verify).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  test('the rate limit per IP: 429 before Turnstile', async () => {
    const verify = stubSiteverify();
    const mail = recordingMail();
    const res = await askForLink({ email: EMAIL, turnstile: 'tok' }, {}, { ...mail, RL_ACCESS: limiter(false) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(verify).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  test(`at most ${LINKS_PER_HOUR} links per address per hour; another address is not affected`, async () => {
    stubSiteverify();
    const mail = recordingMail();
    for (let i = 0; i < LINKS_PER_HOUR; i++) expect((await askForLink({ email: EMAIL, turnstile: 'tok' }, {}, mail)).status).toBe(200);
    const sixth = await askForLink({ email: 'CUSTOMER@example.com', turnstile: 'tok' }, {}, mail);
    expect(sixth.status).toBe(429);
    expect((await sixth.json<any>()).error).toMatch(/several links to this address/);
    expect(mail.sent).toHaveLength(LINKS_PER_HOUR);
    expect((await askForLink({ email: 'colleague@example.com', turnstile: 'tok' }, {}, mail)).status).toBe(200);
  });

  test('the intranet refuses or cannot be reached: 503, and the customer can try again', async () => {
    stubSiteverify();
    for (const result of [{ ok: false as const, error: 'unavailable' as const }, 'throw' as const]) {
      const res = await askForLink({ email: EMAIL, turnstile: 'tok' }, {}, recordingMail(result));
      expect(res.status).toBe(503);
      expect((await res.json<any>()).error).toMatch(/could not be sent/);
    }
  });

  test('only POST; and the stand-in of the real binding answers', async () => {
    expect((await run(new Request(`${HOST}/api/access`))).status).toBe(405);
    stubSiteverify();
    expect((await askForLink({ email: EMAIL, turnstile: 'tok' })).status).toBe(200);
  });
});

describe('GET /access: the link from the mail', () => {
  async function mailedLink(next?: string) {
    stubSiteverify();
    const mail = recordingMail();
    expect((await askForLink({ email: EMAIL, turnstile: 'tok', next }, {}, mail)).status).toBe(200);
    vi.restoreAllMocks();
    return mail.sent[0].link;
  }

  test('sets the session for the address and goes on to the file; the session opens the downloads', async () => {
    const link = await mailedLink(`/download/${ROOTFS}`);
    const res = await run(new Request(link));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/download/${ROOTFS}`);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=s\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax$`));
    const session = cookie.split(';')[0];
    const api = await signedIn('/api/catalogue', { headers: { cookie: session } });
    expect(api.status).toBe(200);
    expect((await api.json<any>()).email).toBe(EMAIL);
    const file = await signedIn(`/files/${ROOTFS}`, { headers: { cookie: session } });
    expect(file.status).toBe(200);
    await file.arrayBuffer();
    const log = await env.IMAGES_BUCKET.list({ prefix: 'downloads/', include: ['customMetadata'] });
    expect(log.objects.map((o) => o.customMetadata?.email)).toEqual([EMAIL]);
  });

  test('works twice within the hour (a mail scanner may open it first)', async () => {
    const link = await mailedLink();
    expect((await run(new Request(link))).status).toBe(303);
    expect((await run(new Request(link))).headers.get('set-cookie')).toMatch(/^__Host-images-session=s\./);
  });

  test('expired: back to the sign-in page saying so, keeping the file; broken or a session token: "does not work"', async () => {
    const key = await testKey();
    const old = Date.now() - LINK_TTL_SECONDS * 1000 - 1000;
    const expired = await run(new Request(`${HOST}/access?t=${await signLink(key, EMAIL, `/download/${ROOTFS}`, old)}`));
    expect(expired.status).toBe(303);
    expect(expired.headers.get('location')).toBe(`/sign-in?link=expired&next=${encodeURIComponent(`/download/${ROOTFS}`)}`);
    expect(expired.headers.get('set-cookie')).toBeNull();
    for (const t of ['', 'nonsense', await signSession(key, EMAIL, Date.now()), (await signLink(key, EMAIL, '/', Date.now())).slice(0, -2) + 'AA']) {
      const res = await run(new Request(`${HOST}/access?t=${encodeURIComponent(t)}`));
      expect(res.headers.get('location'), t).toBe('/sign-in?link=invalid');
      expect(res.headers.get('set-cookie'), t).toBeNull();
    }
  });

  test('never sends anyone off this site', async () => {
    const key = await testKey();
    for (const next of ['https://evil.example/', '//evil.example', '/download/../../x', '/download/images/a/1/b/c', '/api/catalogue', 'javascript:alert(1)']) {
      expect(safeNext(next), next).toBe('/');
      const res = await run(new Request(`${HOST}/access?t=${await signLink(key, EMAIL, next, Date.now())}`));
      expect(res.headers.get('location'), next).toBe('/');
    }
  });
});

describe('the tokens', () => {
  test('a link and a session are different kinds: neither verifies as the other', async () => {
    const key = await testKey();
    const now = Date.now();
    const link = await signLink(key, EMAIL, `/download/${ROOTFS}`, now);
    const session = await signSession(key, EMAIL, now);
    expect(await verifyLink(key, link, now)).toEqual({ status: 'ok', email: EMAIL, next: `/download/${ROOTFS}` });
    expect(await verifySession(key, session, now)).toEqual({ status: 'ok', email: EMAIL, next: '/' });
    expect((await verifySession(key, link, now)).status).toBe('invalid');
    expect((await verifyLink(key, session, now)).status).toBe('invalid');
    expect((await verifyLink(key, link, now + LINK_TTL_SECONDS * 1000 + 1000)).status).toBe('expired');
    expect((await verifySession(key, session, now + SESSION_TTL_SECONDS * 1000 - 1000)).status).toBe('ok');
  });
});

describe('local development', () => {
  test('DEV_USER_EMAIL works on localhost only, without a site key or a cookie', async () => {
    const dev = { DEV_USER_EMAIL: 'Dev@Example.com', TURNSTILE_SITE_KEY: '' };
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
      const res = await run(new Request(`http://${host}/api/catalogue`), dev);
      expect(res.status, host).toBe(200);
      expect((await res.json<any>()).email).toBe('dev@example.com');
    }
    // Off localhost it is ignored.
    expect((await run(new Request(`${HOST}/api/catalogue`), { DEV_USER_EMAIL: 'dev@example.com' })).status).toBe(401);
    expect((await run(new Request(`${HOST}/api/catalogue`), dev)).status).toBe(503);
  });
});

describe('HTTPS and the security headers', () => {
  test('plain HTTP is redirected to HTTPS on every path, before anything else', async () => {
    for (const path of ['/', '/app.js', '/api/catalogue', `/files/${ROOTFS}`, '/sign-in', '/access?t=x', '/nope?x=1']) {
      for (const overrides of [{}, { TURNSTILE_SITE_KEY: '' }]) {
        const res = await run(new Request(`http://images.gocontroll.tech${path}`), overrides);
        expect(res.status, path).toBe(301);
        expect(res.headers.get('location'), path).toBe(`https://images.gocontroll.tech${path}`);
        expectSecurityHeaders(res, path);
      }
    }
    const post = await run(new Request('http://images.gocontroll.tech/api/access', { method: 'POST', body: '{}' }));
    expect(post.status).toBe(308);
  });

  test('pages, assets, the API, redirects, a 404 and a 405 carry the security headers, X-Robots-Tag included', async () => {
    const answers = {
      page: await signedIn('/'),
      signIn: await signedIn('/sign-in', { auth: false }),
      asset: await signedIn('/styles.css'),
      api: await signedIn('/api/catalogue'),
      redirect: await signedIn('/', { auth: false }),
      missing: await signedIn('/nope'),
      missingApi: await signedIn('/api/nope'),
      post: await signedIn('/api/catalogue', { method: 'POST', body: '{}' }),
    };
    expect(Object.values(answers).map((r) => r.status)).toEqual([200, 200, 200, 200, 303, 404, 404, 405]);
    for (const [what, res] of Object.entries(answers)) expectSecurityHeaders(res, what);
    expect(answers.page.headers.get('cache-control')).toBe('private, no-store');
    expect(answers.post.headers.get('allow')).toBe('GET, HEAD');
    expect(SECURITY_HEADERS['x-robots-tag']).toBe('noindex, nofollow');
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([
      'content-security-policy', 'referrer-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'x-robots-tag',
    ]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|data:/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/frame-ancestors 'none'/);
    // The signed-in address only from the cookie.
    expect(await sessionCookieHeader()).toMatch(/^__Host-images-session=s\./);
  });
});
