import { adminSecretsStore, env } from 'cloudflare:test';
import { TEST_SESSION_KEY, TEST_TURNSTILE_SECRET } from './helpers';

// The two Secrets Store bindings, in Miniflare's local store, so the real bindings (get()) are what
// the suite exercises. Fixed test values; made once (the pool keeps the store between files).
for (const [name, binding, value] of [
  ['IMAGES_SESSION_KEY', env.SESSION_KEY, TEST_SESSION_KEY],
  ['IMAGES_TURNSTILE_SECRET', env.TURNSTILE_SECRET, TEST_TURNSTILE_SECRET],
] as const) {
  using admin = adminSecretsStore(binding as SecretsStoreSecret);
  if (!(await admin.list()).some((s) => s.name === name)) await admin.create(value);
}
