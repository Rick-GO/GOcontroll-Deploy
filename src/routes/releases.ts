// Publishing a release into the bucket (S1 firmware, or a Linux go-deploy package), and
// signing an S1 binary without publishing it.
// Both take multipart/form-data (the browser sends the compressed payload or a container);
// the rules are in src/release.ts.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/http';
import { publishLinux } from '../linux';
import { publish, signOnly } from '../release';

export const releases = new Hono<AppEnv>();

async function form(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, 'The upload could not be read. Try again.');
  }
}

releases.post('/sign', async (c) => {
  const { body, filename, size } = await signOnly(c.env, c.get('user'), await form(c.req.raw));
  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

releases.post('/releases', async (c) => c.json(await publish(c.env, c.get('user'), await form(c.req.raw))));

// A Linux (go-deploy) release: tarball + version manifest, then the root manifest (src/linux.ts).
releases.post('/linux-releases', async (c) => c.json(await publishLinux(c.env, c.get('user'), await form(c.req.raw))));
