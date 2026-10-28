import { configDefaults, defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// The suite of gocontroll-images (images.gocontroll.tech), run from the repo root:
// `npm run test:images` (= vitest run --config images/vitest.config.ts; `npm test` runs both
// suites). Paths are relative to the repo root; the root config excludes images/.
//
// Tests run inside the Workers runtime (Miniflare) with a local R2 bucket for IMAGES_BUCKET
// (emptied before every test) and the real static assets of images/public. The bindings below win over
// images/wrangler.toml and a developer's images/.dev.vars, so the suite behaves the same on every
// machine and in CI: Cloudflare's always-passing Turnstile test site key (the fail-closed tests pass
// TURNSTILE_SITE_KEY: '' per call), and no DEV_USER_EMAIL (the localhost tests pass one per call).
// The Secrets Store bindings SESSION_KEY and TURNSTILE_SECRET read Miniflare's local store, which
// test/setup.ts fills. siteverify is stubbed in every test that asks for a link.
//
// MAIL binds the intranet Worker's entrypoint ImagesMail: a stand-in with the same name and method
// answers { ok: true } (the real one is tested with the intranet Worker, test/images-mail.test.ts);
// tests that look at what was sent replace MAIL per call with a recording fake (test/helpers.ts).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './images/wrangler.toml' },
      miniflare: {
        workers: [{
          name: 'gocontroll-deploy-intranet',
          modules: true,
          compatibilityDate: '2026-09-01',
          script: `import { WorkerEntrypoint } from 'cloudflare:workers';
export class ImagesMail extends WorkerEntrypoint {
  async sendAccessLink() { return { ok: true }; }
}
export default { fetch: () => new Response('Not found', { status: 404 }) };`,
        }],
        bindings: {
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          DEV_USER_EMAIL: '',
        },
      },
    }),
  ],
  test: {
    include: ['images/test/**/*.test.ts'],
    setupFiles: ['./images/test/setup.ts'],
    testTimeout: 30_000,
    // The pool keeps R2 storage between tests and files; each test empties the bucket first
    // (test/helpers.ts emptyBucket), so the files must not run at the same time.
    fileParallelism: false,
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
