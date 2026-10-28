// images.gocontroll.tech is reachable by anyone who receives a one-time PIN: it binds the images
// bucket and its own assets, nothing else. No state bucket, no D1, no secret, no service binding:
// whatever goes wrong here can never reach the intranet's data.

import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import wranglerToml from '../wrangler.toml?raw';

/** The uncommented lines of images/wrangler.toml. */
const lines = wranglerToml.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

test('the Worker binds the images bucket, its assets and two vars; nothing else', () => {
  // DEV_USER_EMAIL is a test binding (images/vitest.config.ts); __VITEST_POOL_WORKERS_* are the pool's own.
  const keys = Object.keys(env).filter((k) => !k.startsWith('__VITEST_POOL_WORKERS_')).sort();
  expect(keys).toEqual(['ASSETS', 'DEV_USER_EMAIL', 'IMAGES_AUD', 'IMAGES_BUCKET', 'TEAM_DOMAIN']);
});

test('wrangler.toml has only these tables: no D1, no secrets, no services, no KV, no other bucket', () => {
  const tables = lines.filter((l) => l.startsWith('[')).map((l) => l.replace(/\s+/g, ''));
  expect(tables).toEqual(['[assets]', '[observability]', '[[r2_buckets]]', '[vars]', '[dev]']);
  expect(lines).toContain('bucket_name = "gocontroll-images"');
  expect(lines).toContain('binding = "IMAGES_BUCKET"');
  for (const forbidden of ['d1_databases', 'secrets_store_secrets', 'services', 'kv_namespaces', 'durable_objects', 'queues', 'triggers', 'STATE']) {
    expect(lines.join('\n'), forbidden).not.toContain(forbidden);
  }
});

test('the vars: the team domain and an AUD that is empty until the Access application exists', () => {
  const vars = lines.slice(lines.indexOf('[vars]') + 1, lines.indexOf('[dev]'));
  expect(vars).toEqual(['TEAM_DOMAIN = "https://gocontroll.cloudflareaccess.com"', expect.stringMatching(/^IMAGES_AUD = "[0-9a-f]*"$/)]);
  expect(env.TEAM_DOMAIN).toBe('https://gocontroll.cloudflareaccess.com');
});

test('only the custom domain: no workers.dev, no preview URLs, the Worker runs before every asset', () => {
  expect(lines).toContain('name = "gocontroll-images"');
  expect(lines).toContain('workers_dev = false');
  expect(lines).toContain('preview_urls = false');
  expect(lines).toContain('routes = [{ pattern = "images.gocontroll.tech", custom_domain = true }]');
  expect(lines).toContain('run_worker_first = true');
});
