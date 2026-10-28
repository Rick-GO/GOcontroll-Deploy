// images.gocontroll.tech is reachable by anyone on the internet: it binds the images bucket, its own
// assets, the intranet's mail entrypoint ImagesMail, a rate limit and two secrets of its own, nothing
// else. No state bucket, no D1, no Microsoft 365 secret, no other service: whatever goes wrong here
// can never reach the intranet's data, and the most the mail binding can do is mail a link to this
// site to one address (../../src/images-mail.ts).

import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import wranglerToml from '../wrangler.toml?raw';

/** The uncommented lines of images/wrangler.toml. */
const lines = wranglerToml.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
const text = lines.join('\n');

test('the Worker binds the bucket, its assets, the mail entrypoint, a rate limit, two secrets and two vars; nothing else', () => {
  // DEV_USER_EMAIL is a test binding (images/vitest.config.ts); __VITEST_POOL_WORKERS_* are the pool's own.
  const keys = Object.keys(env).filter((k) => !k.startsWith('__VITEST_POOL_WORKERS_')).sort();
  expect(keys).toEqual(['ASSETS', 'DEV_USER_EMAIL', 'IMAGES_BUCKET', 'MAIL', 'RL_ACCESS', 'SESSION_KEY', 'SITE_URL', 'TURNSTILE_SECRET', 'TURNSTILE_SITE_KEY']);
});

test('wrangler.toml has only these tables: no D1, no KV, no other bucket or service', () => {
  const tables = lines.filter((l) => l.startsWith('[')).map((l) => l.replace(/\s+/g, ''));
  expect(tables).toEqual([
    '[assets]', '[observability]', '[[r2_buckets]]', '[[services]]', '[[ratelimits]]',
    '[[secrets_store_secrets]]', '[[secrets_store_secrets]]', '[vars]', '[dev]',
  ]);
  expect(lines).toContain('bucket_name = "gocontroll-images"');
  for (const forbidden of ['d1_databases', 'kv_namespaces', 'durable_objects', 'queues', 'triggers', 'STATE', 'MS365', 'gocontroll-deploy-state']) {
    expect(text, forbidden).not.toContain(forbidden);
  }
});

test('the mail binding is the intranet entrypoint ImagesMail; the secrets are the images ones', () => {
  expect(text).toMatch(/\[\[services\]\]\nbinding = "MAIL"\nservice = "gocontroll-deploy-intranet"\nentrypoint = "ImagesMail"/);
  expect(text).toMatch(/binding = "SESSION_KEY"\nstore_id = "33801ac6937549ae8f6f92169586a707"\nsecret_name = "IMAGES_SESSION_KEY"/);
  expect(text).toMatch(/binding = "TURNSTILE_SECRET"\nstore_id = "33801ac6937549ae8f6f92169586a707"\nsecret_name = "IMAGES_TURNSTILE_SECRET"/);
  expect(text).toMatch(/name = "RL_ACCESS"\nnamespace_id = "4731"/);
});

test('the vars: the site URL and a site key that is empty until the Turnstile widget exists', () => {
  const vars = lines.slice(lines.indexOf('[vars]') + 1, lines.indexOf('[dev]'));
  expect(vars).toEqual(['SITE_URL = "https://images.gocontroll.tech"', expect.stringMatching(/^TURNSTILE_SITE_KEY = "[0-9A-Za-z_-]*"$/)]);
});

test('only the custom domain: no workers.dev, no preview URLs, the Worker runs before every asset', () => {
  expect(lines).toContain('name = "gocontroll-images"');
  expect(lines).toContain('workers_dev = false');
  expect(lines).toContain('preview_urls = false');
  expect(lines).toContain('routes = [{ pattern = "images.gocontroll.tech", custom_domain = true }]');
  expect(lines).toContain('run_worker_first = true');
});
