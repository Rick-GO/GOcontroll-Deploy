// Module firmware on firmware.gocontroll.tech: the overview and publishing an .srec (src/firmware.ts).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { firmwareOverview, publishFirmware } from '../firmware';
import { HttpError } from '../lib/http';

export const firmware = new Hono<AppEnv>();

firmware.get('/firmware', async (c) => c.json(await firmwareOverview(c.env)));

firmware.post('/firmware', async (c) => {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, 'The upload could not be read. Try again.');
  }
  return c.json(await publishFirmware(c.env, c.get('user'), form));
});
