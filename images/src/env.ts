import type { AccessLinkMail, AccessLinkResult } from '../../src/images-format';

/** The intranet Worker's RPC entrypoint ImagesMail (../../src/images-mail.ts), as far as it is used here. */
export interface ImagesMailService {
  sendAccessLink(mail: AccessLinkMail): Promise<AccessLinkResult>;
}

/**
 * The bindings of gocontroll-images (images/wrangler.toml), and nothing else: no state bucket, no
 * database, no Microsoft 365 secret. images/test/config.test.ts pins the list.
 */
export interface Env {
  IMAGES_BUCKET: R2Bucket; // gocontroll-images: manifest.json, the releases, the download log, access-mails/
  ASSETS: Fetcher;         // images/public: the pages, their scripts and stylesheet, the brand images
  MAIL: ImagesMailService; // service binding to gocontroll-deploy-intranet, entrypoint ImagesMail: sends the link
  RL_ACCESS?: RateLimit;   // requests for a link per client IP (a brake; Turnstile and the hourly cap are the locks)

  // Secrets Store (../../src/lib/secret.ts reads both forms; a plain string in tests).
  SESSION_KEY?: SecretsStoreSecret | string;      // store IMAGES_SESSION_KEY: HMAC key of links and session cookies (base64, 32 bytes)
  TURNSTILE_SECRET?: SecretsStoreSecret | string; // store IMAGES_TURNSTILE_SECRET; not-set = no links can be sent

  SITE_URL: string;           // https://images.gocontroll.tech: the origin of the links and of the sign-in form
  TURNSTILE_SITE_KEY: string; // the widget's site key; empty: 503 everywhere (not set up yet)

  // Local development only, honoured on a localhost URL (src/session.ts).
  DEV_USER_EMAIL?: string;
}
