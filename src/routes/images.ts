// Linux images for images.gocontroll.tech (src/images.ts): releases, their files (a multipart
// upload per file) and publishing. Every write is JSON, except a part: its raw bytes
// (application/octet-stream, checked in src/index.ts).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  cancelUpload, completeUpload, createRelease, deleteRelease, imagesOverview, publishRelease, releaseRef, removeFile, startUpload,
  updateRelease, uploadParam, uploadPart, withdrawRelease,
} from '../images';

export const images = new Hono<AppEnv>();

const body = (req: Request) => req.json().catch(() => null);
const ref = (p: Record<string, string>) => releaseRef(p.controller, p.version);
const RELEASE = '/images/releases/:controller/:version';

images.get('/images', async (c) => c.json(await imagesOverview(c.env)));

images.post('/images/releases', async (c) => c.json(await createRelease(c.env, c.get('user'), await body(c.req.raw)), 201));
images.patch(RELEASE, async (c) => c.json(await updateRelease(c.env, c.get('user'), ref(c.req.param()), await body(c.req.raw))));
images.delete(RELEASE, async (c) => {
  await deleteRelease(c.env, c.get('user'), ref(c.req.param()));
  return c.json({ ok: true });
});
images.post(`${RELEASE}/publish`, async (c) => c.json(await publishRelease(c.env, c.get('user'), ref(c.req.param()))));
images.post(`${RELEASE}/withdraw`, async (c) => c.json(await withdrawRelease(c.env, c.get('user'), ref(c.req.param()))));

images.post(`${RELEASE}/files`, async (c) => c.json(await startUpload(c.env, c.get('user'), ref(c.req.param()), await body(c.req.raw)), 201));
images.delete(`${RELEASE}/files/:name`, async (c) => c.json(await removeFile(c.env, c.get('user'), ref(c.req.param()), c.req.param('name'))));

images.put('/images/uploads/:id/parts/:n', async (c) =>
  c.json(await uploadPart(c.env, uploadParam(c.req.param('id')), Number(c.req.param('n')), c.req.raw)));
images.post('/images/uploads/:id/complete', async (c) =>
  c.json(await completeUpload(c.env, c.get('user'), uploadParam(c.req.param('id')), await body(c.req.raw))));
images.delete('/images/uploads/:id', async (c) => {
  await cancelUpload(c.env, c.get('user'), uploadParam(c.req.param('id')));
  return c.json({ ok: true });
});
