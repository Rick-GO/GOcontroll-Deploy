// Module firmware on firmware.gocontroll.tech: the overview and publishing an .srec (src/firmware.ts).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { firmwareOverview, publishFirmware } from '../firmware';
import { checkGitHub, githubToken, tagAndRelease } from '../github';
import { HttpError } from '../lib/http';

export const firmware = new Hono<AppEnv>();

firmware.get('/firmware', async (c) => {
  const [overview, token] = await Promise.all([firmwareOverview(c.env), githubToken(c.env).catch(() => undefined)]);
  return c.json({ ...overview, github: { configured: Boolean(token), repos: c.env.GITHUB_REPOS || '' } });
});

// Whether Deploy can tag and release in a repository (read only).
firmware.get('/firmware/github', async (c) => c.json(await checkGitHub(c.env, c.req.query('repo') ?? '')));

// Tag v<version> and the GitHub release of a publish (src/github.ts).
firmware.post('/firmware/releases', async (c) => c.json(await tagAndRelease(c.env, c.get('user'), await c.req.json().catch(() => null))));

firmware.post('/firmware', async (c) => {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, 'The upload could not be read. Try again.');
  }
  return c.json(await publishFirmware(c.env, c.get('user'), form));
});
