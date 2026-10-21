// Who is signed in, whether the Worker is healthy, and the customers for the assign picker.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { listCustomers } from '../business';
import { secretConfigured } from '../lib/secret';
import { APP_VERSION } from '../version';

export const meta = new Hono<AppEnv>();

meta.get('/me', (c) => {
  const u = c.get('user');
  return c.json({ email: u.email, name: u.name, groups: u.groups });
});

meta.get('/health', async (c) => {
  const [signingKeys, downloads] = await Promise.all([secretConfigured(c.env.SIGNING_KEYS_KEY), secretConfigured(c.env.CF_API_TOKEN)]);
  return c.json({ ok: true, version: APP_VERSION, signingKeys, downloads });
});

meta.get('/customers', async (c) => c.json(await listCustomers(c.env)));
