import { adminSecretsStore, applyD1Migrations, env } from 'cloudflare:test';
import { TEST_KEK, TEST_MS365_SECRET } from './helpers';

// The pinned schemas of the two databases Deploy only reads: Hours' (customers, projects)
// under its d1_migrations, an excerpt of GOcontroll-Database's schema.sql under its own table.
await applyD1Migrations(env.BUSINESS_DB, env.TEST_BUSINESS_SCHEMA, 'd1_migrations');
await applyD1Migrations(env.MODULINE_DB, env.TEST_MODULINE_SCHEMA, 'd1_migrations');

// The Secrets Store bindings in Miniflare's local store, so the real bindings (get()) are what the
// suite exercises: the key-encryption key of the signing keys and the Microsoft 365 client secret
// (Graph is stubbed in every test that mails). Fixed test values, made once.
for (const [name, binding, value] of [
  ['DEPLOY_SIGNING_KEYS_KEY', env.SIGNING_KEYS_KEY, TEST_KEK],
  ['MS365_CLIENT_SECRET', env.MS365_CLIENT_SECRET, TEST_MS365_SECRET],
] as const) {
  using admin = adminSecretsStore(binding as SecretsStoreSecret);
  if (!(await admin.list()).some((s) => s.name === name)) await admin.create(value);
}
