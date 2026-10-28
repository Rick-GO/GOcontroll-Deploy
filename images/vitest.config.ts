import { configDefaults, defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// The suite of gocontroll-images (images.gocontroll.tech), run from the repo root:
// `npm run test:images` (= vitest run --config images/vitest.config.ts; `npm test` runs both
// suites). Paths are relative to the repo root; the root config excludes images/.
//
// Tests run inside the Workers runtime (Miniflare) with a local R2 bucket for IMAGES_BUCKET
// (emptied before every test) and the real static assets of images/public. The bindings below win over
// images/wrangler.toml and a developer's images/.dev.vars, so the suite behaves the same on every
// machine and in CI: an AUD for the token path (the fail-closed tests pass IMAGES_AUD: '' per
// call), and no DEV_USER_EMAIL (the localhost tests pass one per call). Every call to the Access
// team domain is mocked.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './images/wrangler.toml' },
      miniflare: {
        bindings: {
          IMAGES_AUD: 'test-images-aud',
          DEV_USER_EMAIL: '',
        },
      },
    }),
  ],
  test: {
    include: ['images/test/**/*.test.ts'],
    testTimeout: 30_000,
    // The pool keeps R2 storage between tests and files; each test empties the bucket first
    // (test/helpers.ts emptyBucket), so the files must not run at the same time.
    fileParallelism: false,
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
