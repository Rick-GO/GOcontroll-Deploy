import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Tests run inside the Workers runtime (Miniflare) with local R2 buckets (DEPLOY_BUCKET,
// STATE) and two local D1s built the way production has them: BUSINESS_DB from the pinned
// Hours schema (customers, projects), MODULINE_DB from a pinned excerpt of
// GOcontroll-Database's schema.sql (controllers, project_provisioning and, to prove they are
// never read, the tables with device secrets). test/setup.ts applies them.
//
// The bindings below win over wrangler.toml and a developer's .dev.vars, so the suite
// behaves the same on every machine and in CI: DEPLOY_GROUPS matches the DEV groups the
// helpers pass (access.test.ts sets an object ID for the token path), no Cloudflare API
// token (downloads.test.ts passes one per call, every call to Cloudflare is mocked), and no
// DEV_USER_* (helpers.ts passes the colleague per call). The Secrets Store binding
// SIGNING_KEYS_KEY cannot be replaced here; test/setup.ts gives it a value in the local store.
export default defineConfig(async () => {
  const businessSchema = await readD1Migrations('./test/fixtures/business');
  const modulineSchema = await readD1Migrations('./test/fixtures/moduline');
  // Every D1 database, R2 bucket and KV namespace the Worker binds, as `D1 <database_name>`, `R2 <bucket_name>`
  // and `KV <binding>`: test/admin-api.test.ts holds them against the backup, so a new one cannot fall out of it
  // unseen. workerd cannot read wrangler.toml itself.
  const toml = readFileSync('./wrangler.toml', 'utf8');
  const storage = [
    ...[...toml.matchAll(/^\s*database_name\s*=\s*"([^"]+)"/gm)].map((m) => `D1 ${m[1]}`),
    ...[...toml.matchAll(/^\s*bucket_name\s*=\s*"([^"]+)"/gm)].map((m) => `R2 ${m[1]}`),
    ...[...toml.matchAll(/^\[\[kv_namespaces\]\][^[]*?^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => `KV ${m[1]}`),
  ];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_STORAGE: storage,
            TEST_BUSINESS_SCHEMA: businessSchema,
            TEST_MODULINE_SCHEMA: modulineSchema,
            POLICY_AUD: 'test-aud-tag',
            DEPLOY_GROUPS: 'CF_Deploy',
            DEV_USER_EMAIL: '',
            DEV_USER_NAME: '',
            DEV_USER_GROUPS: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
      // Git worktrees of this repo (.claude/worktrees) hold their own copy of test/.
      exclude: [...configDefaults.exclude, '.claude/**', 'images/**'], // images/ (images.gocontroll.tech) has its own suite: npm run test:images
    },
  };
});
