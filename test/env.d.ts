import type { D1Migration } from 'cloudflare:test';
import type { Env as AppBindings } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      TEST_BUSINESS_SCHEMA: D1Migration[];
      TEST_MODULINE_SCHEMA: D1Migration[];
      /** The D1 databases, R2 buckets and KV namespaces of wrangler.toml, as `D1 <name>`, `R2 <name>`, `KV <binding>` (vitest.config.ts). */
      TEST_STORAGE: string[];
    }
  }
}
