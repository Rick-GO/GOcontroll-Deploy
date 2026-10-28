import type { Env as ImagesBindings } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends ImagesBindings {}
  }
}
