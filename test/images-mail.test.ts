// ImagesMail (src/images-mail.ts): the RPC entrypoint images.gocontroll.tech binds as MAIL. Whatever
// the caller sends, it mails one fixed message to the one address it is given, with a link to the
// download site only, from noreply@ through Graph. A wrong shape is refused without a call to
// Microsoft. fetch is stubbed: nothing is ever sent.

import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOGO_CID, ImagesMail, accessMail, parseAccessLinkMail, sendAccessLink } from '../src/images-mail';
import { TEST_MS365_SECRET } from './helpers';

type Sent = { url: string; body: any };
/** Stub Microsoft login and Graph; every sendMail answers `status`. */
function stubGraph(status = 202) {
  const sent: Sent[] = [];
  const logins: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      logins.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(status === 202 ? null : '{"error":"nope"}', { status });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { sent, logins };
}
afterEach(() => vi.restoreAllMocks());

const TOKEN = `l.${'eyJlIjoiYUBiLmMifQ'.padEnd(40, 'A')}.${'s'.repeat(43)}`;
const LINK = `https://images.gocontroll.tech/access?t=${TOKEN}`;

describe('parseAccessLinkMail: only an address and a link to the download site', () => {
  const URL_ = 'https://images.gocontroll.tech';
  test('accepted: the address normalised, a file name kept, other fields dropped', () => {
    expect(parseAccessLinkMail({ email: ' Customer@Example.com ', link: LINK, file: 'rootfs.ext4.zst', to: 'x@evil.example', html: '<b>' }, URL_))
      .toEqual({ email: 'customer@example.com', link: LINK, file: 'rootfs.ext4.zst' });
    expect(parseAccessLinkMail({ email: 'a@example.com', link: LINK }, URL_)).toEqual({ email: 'a@example.com', link: LINK });
  });

  test('refused: no address, several, another site, another path, a token of another shape, a file with a path', () => {
    const bad: unknown[] = [
      null, 'a string', {},
      { email: 'not an address', link: LINK },
      { email: 'a@example.com, b@example.com', link: LINK },
      { email: 'a@example.com', link: LINK.replace('images.gocontroll.tech', 'evil.example') },
      { email: 'a@example.com', link: LINK.replace('https://', 'http://') },
      { email: 'a@example.com', link: LINK.replace('/access?', '/files/x?') },
      { email: 'a@example.com', link: `${LINK}&x=<script>` },
      { email: 'a@example.com', link: LINK.replace('t=l.', 't=s.') },
      { email: 'a@example.com', link: 'https://images.gocontroll.tech.evil.example/access?t=' + TOKEN },
      { email: 'a@example.com', link: LINK, file: '../etc/passwd' },
      { email: 'a@example.com', link: LINK, file: 42 },
    ];
    for (const input of bad) expect(parseAccessLinkMail(input, URL_), JSON.stringify(input)).toBeNull();
  });
});

describe('the mail', () => {
  test('in the house style: the link as a button and as text, its validity, no other link to us than the site', () => {
    const { subject, html } = accessMail({ email: 'a@example.com', link: LINK, file: 'rootfs.ext4.zst' });
    expect(subject).toBe('Your link to the GOcontroll downloads');
    expect(html).toContain(`href="${LINK}"`);
    expect(html.split(LINK).length - 1).toBe(3); // button, link text, its href
    expect(html).toContain('<strong>rootfs.ext4.zst</strong>');
    expect(html).toContain('works for 60 minutes');
    expect(html).toContain('for 7 days');
    expect(html).toContain(`cid:${LOGO_CID}`);
    expect(html).toContain('If that was not you, you can ignore it');
    const plain = accessMail({ email: 'a@example.com', link: LINK }).html;
    expect(plain).toContain('Open the downloads');
    expect(plain).toContain('the Linux images for the Moduline L4, M1 and HMI1');
    expect(plain).not.toMatch(/\btools?\b/i); // there are only controller images (since 0.8.0)
  });
});

describe('sendAccessLink', () => {
  test('one mail through Graph from noreply@, to the address only, Reply-To info@, with the logo inline', async () => {
    const { sent, logins } = stubGraph();
    expect(await sendAccessLink(env, { email: 'Customer@Example.com', link: LINK, bcc: 'someone@else.example' })).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://graph.microsoft.com/v1.0/users/noreply%40gocontroll.com/sendMail');
    const m = sent[0].body.message;
    expect(m.toRecipients).toEqual([{ emailAddress: { address: 'customer@example.com' } }]);
    expect(m.ccRecipients).toBeUndefined();
    expect(m.bccRecipients).toBeUndefined();
    expect(m.replyTo).toEqual([{ emailAddress: { address: 'info@gocontroll.com', name: 'GOcontroll' } }]);
    expect(m.subject).toBe('Your link to the GOcontroll downloads');
    expect(m.body.content).toContain(LINK);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ name: 'gocontroll-logo.png', contentType: 'image/png', isInline: true, contentId: LOGO_CID });
    expect(sent[0].body.saveToSentItems).toBe(false);
    // The secret came from the Secrets Store binding.
    expect(logins[0].get('client_secret')).toBe(TEST_MS365_SECRET);
  });

  test('a wrong shape: refused, Microsoft never asked', async () => {
    const { sent, logins } = stubGraph();
    expect(await sendAccessLink(env, { email: 'a@example.com', link: 'https://evil.example/' })).toEqual({ ok: false, error: 'refused' });
    expect(sent).toEqual([]);
    expect(logins).toEqual([]);
  });

  test('Graph refuses: unavailable, not thrown', async () => {
    stubGraph(500);
    expect(await sendAccessLink(env, { email: 'a@example.com', link: LINK })).toEqual({ ok: false, error: 'unavailable' });
  });

  test('the entrypoint calls the same code', async () => {
    const { sent } = stubGraph();
    const entry = new ImagesMail(createExecutionContext(), env);
    expect(await entry.sendAccessLink({ email: 'a@example.com', link: LINK })).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });
});
