import { adminSecretsStore, applyD1Migrations, env } from 'cloudflare:test';
import { TEST_KEK } from './helpers';

// The pinned schemas of the two databases Deploy only reads: Hours' (customers, projects)
// under its d1_migrations, an excerpt of GOcontroll-Database's schema.sql under its own table.
await applyD1Migrations(env.BUSINESS_DB, env.TEST_BUSINESS_SCHEMA, 'd1_migrations');
await applyD1Migrations(env.MODULINE_DB, env.TEST_MODULINE_SCHEMA, 'd1_migrations');

// The key-encryption key of the signing keys, in Miniflare's local Secrets Store, so the
// real binding (SIGNING_KEYS_KEY.get()) is what the suite exercises. A fixed test value.
{
  using admin = adminSecretsStore(env.SIGNING_KEYS_KEY as SecretsStoreSecret);
  const existing = await admin.list();
  if (!existing.length) await admin.create(TEST_KEK);
}
