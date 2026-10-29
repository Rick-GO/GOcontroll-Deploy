// ImagesMail: the RPC entrypoint (WorkerEntrypoint, exported from src/index.ts) through which
// images.gocontroll.tech (Worker gocontroll-images, images/) mails a customer the link that signs
// them in, so the Microsoft 365 secret never leaves this intranet Worker. The download site binds it:
//
//   [[services]] binding = "MAIL", service = "gocontroll-deploy-intranet", entrypoint = "ImagesMail"
//
// A service binding is not reachable from the internet and only Workers in this Cloudflare account
// can declare one. Whatever the caller sends, sendAccessLink mails one fixed message, written here,
// from MAIL_FROM (noreply@) through Graph (src/mail/graph.ts), Reply-To IMAGES_MAIL_REPLY_TO:
//   - to the one address in `email` (normaliseEmail of src/images-format.ts), never anyone else;
//   - with a link only of the form <IMAGES_URL>/access?t=<LINK_TOKEN_RE>, so a compromised download
//     site cannot make noreply@gocontroll.com send another link or any text of its own;
//   - `file` only as a FILE_NAME_RE name; other fields are ignored.
// The download site does the abuse checks before it calls (Turnstile, a rate limit per IP, at most
// LINKS_PER_HOUR links per address). Answers { ok } instead of throwing; the Graph error stays in
// this Worker's log, which names the address's domain only.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import {
  ACCESS_PATH, FILE_NAME_RE, LINK_TOKEN_RE, LINK_TTL_SECONDS, normaliseEmail, SESSION_TTL_SECONDS, type AccessLinkMail, type AccessLinkResult,
} from './images-format';
import { sendMail, type Attachment } from './mail/graph';

const BRAND = '#e94e25';
const TEXT = '#1a1a1a';
const MUTED = '#6b7280';
const LINE = '#e2e2e2';
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** The logo of the mail: the PNG of public/pub (mail clients do not show SVG), inline. */
export const LOGO_PNG = '/pub/logo.png';
export const LOGO_CID = 'gocontroll-logo';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch]
));

/** The mail as this Worker accepts it, or null: the address, a link to IMAGES_URL only, a file name. */
export function parseAccessLinkMail(input: unknown, imagesUrl: string): AccessLinkMail | null {
  if (!input || typeof input !== 'object') return null;
  const m = input as Record<string, unknown>;
  const email = normaliseEmail(m.email);
  if (!email || typeof m.link !== 'string') return null;
  const prefix = `${new URL(imagesUrl).origin}${ACCESS_PATH}?t=`;
  if (!m.link.startsWith(prefix) || !LINK_TOKEN_RE.test(m.link.slice(prefix.length))) return null;
  const out: AccessLinkMail = { email, link: m.link };
  if (m.file !== undefined) {
    if (typeof m.file !== 'string' || !FILE_NAME_RE.test(m.file)) return null;
    out.file = m.file;
  }
  return out;
}

/** Subject and HTML of the mail; pure. */
export function accessMail(mail: AccessLinkMail): { subject: string; html: string } {
  const minutes = Math.round(LINK_TTL_SECONDS / 60);
  const days = Math.round(SESSION_TTL_SECONDS / 86400);
  const subject = 'Your link to the GOcontroll downloads';
  const p = (html: string, style = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${TEXT};${style}">${html}</p>`;
  const what = mail.file
    ? `Open the link below to sign in; the download of <strong>${esc(mail.file)}</strong> then starts.`
    : 'Open the link below to sign in to the Linux images for the Moduline L4, M1 and HMI1.';
  const button = `<a href="${esc(mail.link)}" style="display:inline-block;padding:12px 22px;background:${BRAND};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px">${mail.file ? 'Sign in and download' : 'Open the downloads'}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title>
<style>@media (max-width:520px){.gc-outer{padding:0!important}.gc-card{border-radius:0!important}.gc-pad{padding-left:16px!important;padding-right:16px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6"><tr><td class="gc-outer" align="center" style="padding:24px 12px">
<table class="gc-card" role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;${FONT}">
<tr><td class="gc-pad" style="padding:22px 28px 18px;border-bottom:3px solid ${BRAND}"><img src="cid:${LOGO_CID}" width="200" height="33" alt="GOcontroll — Modular Embedded Electronics" style="display:block;border:0;width:200px;height:33px"></td></tr>
<tr><td class="gc-pad" style="padding:24px 28px 8px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700;color:${TEXT}">Your link to the downloads</h1>
${p(what)}
<p style="margin:4px 0 18px">${button}</p>
${p(`The link works for ${minutes} minutes. Once you open it, you have access on that device for ${days} days.`, `color:${MUTED};font-size:13px`)}
${p(`Does the button not work? Copy this address into your browser:<br><a href="${esc(mail.link)}" style="color:${BRAND};word-break:break-all">${esc(mail.link)}</a>`, `color:${MUTED};font-size:13px`)}
</td></tr>
<tr><td class="gc-pad" style="padding:18px 28px 22px;border-top:1px solid ${LINE};font-size:12px;line-height:1.5;color:${MUTED}">
GOcontroll B.V. · De Hogenkamp 20, 7071 EC Ulft, the Netherlands · <a href="https://gocontroll.com" style="color:${MUTED}">gocontroll.com</a><br>
You receive this e-mail because this address was entered on the GOcontroll download site. If that was not you, you can ignore it: nobody gets access without this link.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, html };
}

/** The logo as an inline attachment, or null when the file is missing (the mail goes without). */
async function logoAttachment(env: Env): Promise<Attachment | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(LOGO_PNG, 'https://assets.local').toString()));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { name: 'gocontroll-logo.png', contentType: 'image/png', bytes: new Uint8Array(await res.arrayBuffer()), contentId: LOGO_CID };
  } catch (err) {
    console.warn(`images mail: ${LOGO_PNG} is missing (${(err as Error).message})`);
    return null;
  }
}

/** Check, write and send one sign-in mail. */
export async function sendAccessLink(env: Env, input: unknown): Promise<AccessLinkResult> {
  const mail = parseAccessLinkMail(input, env.IMAGES_URL || 'https://images.gocontroll.tech');
  if (!mail) {
    console.warn('images mail: refused (not an address and a link to the download site)');
    return { ok: false, error: 'refused' };
  }
  const { subject, html } = accessMail(mail);
  const logo = await logoAttachment(env);
  try {
    await sendMail(env, {
      to: mail.email,
      replyTo: env.IMAGES_MAIL_REPLY_TO ? { address: env.IMAGES_MAIL_REPLY_TO, name: 'GOcontroll' } : undefined,
      subject,
      html,
      attachments: logo ? [logo] : [],
    });
  } catch (err) {
    console.error(`images mail to an address at ${mail.email.split('@')[1]}: ${(err as Error).message}`);
    return { ok: false, error: 'unavailable' };
  }
  console.log(`images mail: link sent to an address at ${mail.email.split('@')[1]}`);
  return { ok: true };
}

export class ImagesMail extends WorkerEntrypoint<Env> {
  /** Mail the sign-in link of images.gocontroll.tech (the caller is that Worker, through its MAIL binding). */
  async sendAccessLink(input: unknown): Promise<AccessLinkResult> {
    return sendAccessLink(this.env, input);
  }
}
