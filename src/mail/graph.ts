// Microsoft Graph: mail via sendMail from the shared noreply@gocontroll.com mailbox (MAIL_FROM).
// Copy of GOcontroll-Configurator/src/mail/graph.ts (keep them in step); used here for the sign-in
// links of images.gocontroll.tech (src/images-mail.ts).
//
// Same app registration, mailbox and mechanism as GOcontroll-Hours (src/mail/graph.ts, its export
// mails) and the telemetry monthly reports: a client-credentials token, Mail.Send (Application)
// restricted to the noreply mailbox by an ApplicationAccessPolicy, the client secret
// MS365_CLIENT_SECRET from the Secrets Store. M365 already sends for gocontroll.com, so no DNS
// change is involved. Adapted from Hours: a Reply-To (the requester) and no group lookup.

import type { Env } from '../env';
import { readSecret } from '../lib/secret';

/**
 * A file attachment (Graph accepts at most 4 MB per sendMail request, base64 and JSON included).
 * With `contentId` it is inline: the HTML shows it as <img src="cid:<contentId>"> (the logo of the
 * requester's copy, src/confirmation.ts), and mail clients do not list it as a file.
 */
export interface Attachment { name: string; contentType: string; bytes: Uint8Array; contentId?: string }
export interface MailMessage { to: string; replyTo?: { address: string; name?: string }; subject: string; html: string; attachments?: Attachment[] }

/** Mail could not be sent (not configured, Microsoft login or Graph failed): the caller answers 503. */
export class MailUnavailable extends Error {}

let tokenCache: { token: string; expires: number; key: string } | null = null;

async function getToken(env: Env): Promise<string> {
  const key = `${env.MS365_TENANT_ID}|${env.MS365_CLIENT_ID}`;
  // Reuse until two minutes before expiry.
  if (tokenCache && tokenCache.key === key && tokenCache.expires - 120_000 > Date.now()) return tokenCache.token;

  // The client secret lives in the Secrets Store. A store error throws here, so the mail fails
  // (and is reported as such) rather than running without a key.
  const secret = await readSecret(env.MS365_CLIENT_SECRET);
  if (!secret || !env.MS365_TENANT_ID || !env.MS365_CLIENT_ID) throw new MailUnavailable('MS365_TENANT_ID, MS365_CLIENT_ID or MS365_CLIENT_SECRET is not set');

  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS365_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS365_CLIENT_ID,
      client_secret: secret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new MailUnavailable(`Microsoft login: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json<{ access_token: string; expires_in: number }>();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000, key };
  return data.access_token;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export async function sendMail(env: Env, msg: MailMessage): Promise<void> {
  if (!env.MAIL_FROM) throw new MailUnavailable('MAIL_FROM is not set');
  const token = await getToken(env);
  const body = JSON.stringify({
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: [{ emailAddress: { address: msg.to } }],
      ...(msg.replyTo ? { replyTo: [{ emailAddress: msg.replyTo }] } : {}),
      attachments: (msg.attachments || []).map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.contentType,
        contentBytes: toBase64(a.bytes),
        ...(a.contentId ? { isInline: true, contentId: a.contentId } : {}),
      })),
    },
    saveToSentItems: false,
  });
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
  // No retry: the requester sees the failure and can send again (a retry could send it twice).
  if (res.status !== 202) throw new MailUnavailable(`Graph sendMail: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}
