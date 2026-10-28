import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import worker from '../src/index';
import { buildHeader, concat } from '../src/goco';

export const ME = 'jane.doe@gocontroll.com';

/** The key-encryption key test/setup.ts puts in the local Secrets Store. */
export const TEST_KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
/** The Microsoft 365 client secret in the local store (test/setup.ts); Graph is always stubbed. */
export const TEST_MS365_SECRET = 'test-ms365-secret';

const ORIGIN = 'http://localhost';

/**
 * Call the API as a signed-in colleague in DEPLOY_GROUPS. Uses the localhost DEV_USER_* bypass;
 * the token path itself is covered by access.test.ts.
 */
export async function call(method: string, path: string, body?: unknown, envOverrides: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return send(new Request(`${ORIGIN}${path}`, init), envOverrides);
}

/** call() that must answer with `status`; returns the body. */
export async function ok(method: string, path: string, body?: unknown, status = 200, envOverrides: Record<string, unknown> = {}) {
  const res = await call(method, path, body, envOverrides);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

/** POST a multipart form, as the browser does for /api/sign and /api/releases. */
export async function upload(path: string, fields: Record<string, string | Uint8Array>, envOverrides: Record<string, unknown> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') form.append(k, v);
    else form.append(k, new File([v as Uint8Array<ArrayBuffer>], `${k}.bin`, { type: 'application/octet-stream' }));
  }
  return send(new Request(`${ORIGIN}${path}`, { method: 'POST', body: form, headers: { origin: ORIGIN } }), envOverrides);
}

async function send(req: Request, envOverrides: Record<string, unknown>) {
  const res = await worker.fetch(req, {
    ...env, DEV_USER_EMAIL: ME, DEV_USER_NAME: 'Jane Doe', DEV_USER_GROUPS: 'CF_Deploy', ...envOverrides,
  } as typeof env);
  const type = res.headers.get('content-type') || '';
  const json = type.includes('json') ? await res.json<any>().catch(() => null) : null;
  const bytes = type.includes('octet-stream') ? new Uint8Array(await res.arrayBuffer()) : null;
  return { status: res.status, body: json, bytes, res };
}

// ── Test data ───────────────────────────────────────────────────────────────

let seq = 0;
/** A fresh App ID per test (at most 8 characters), so tests never see each other's folders. */
export const appId = (prefix = 'T') => `${prefix}${crypto.randomUUID().replace(/-/g, '')}`.toUpperCase().slice(0, 8);

/** A small zlib stream (what CompressionStream('deflate') makes) and the raw size behind it. */
export async function zlibPayload(text = 'GOcontroll test image '.repeat(40)): Promise<{ payload: Uint8Array<ArrayBuffer>; rawSize: number }> {
  const raw = new TextEncoder().encode(text);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return { payload: new Uint8Array(await new Response(stream).arrayBuffer()), rawSize: raw.length };
}

/** An unsigned container, as a CI build or the Deployment Tool would make it. */
export async function unsignedContainer(id: string, version: string, text?: string): Promise<Uint8Array<ArrayBuffer>> {
  const { payload, rawSize } = await zlibPayload(text);
  return concat(await buildHeader({ appId: id, version, payload, rawSize }), payload);
}

/** Put a manifest straight into the bucket (as the Deployment Tool or CI would have). */
export async function putManifest(id: string, doc: unknown) {
  await env.DEPLOY_BUCKET.put(`${id}/manifest.json`, JSON.stringify(doc, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

let customerSeq = 5000;
export async function customer(name: string): Promise<number> {
  const id = ++customerSeq;
  await env.BUSINESS_DB.prepare(`INSERT INTO customers (id, name) VALUES (?1, ?2)`).bind(id, name).run();
  return id;
}

export async function project(customerId: number, code = 'P-1'): Promise<number> {
  const row = await env.BUSINESS_DB.prepare(`INSERT INTO projects (customer_id, code, name) VALUES (?1, ?2, 'Project') RETURNING id`).bind(customerId, code).first<{ id: number }>();
  return row!.id;
}

/** The controller_series row of a type ("Moduline S1"), made once. */
async function seriesId(type: string): Promise<number> {
  const hit = await env.MODULINE_DB.prepare('SELECT id FROM controller_series WHERE controller_type = ?1').bind(type).first<{ id: number }>();
  if (hit) return hit.id;
  const row = await env.MODULINE_DB.prepare('INSERT INTO controller_series (controller_type) VALUES (?1) RETURNING id').bind(type).first<{ id: number }>();
  return row!.id;
}

export async function controller(fields: { app_id: string; app_version?: string | null; client_id?: number | null; online?: number; app_uptodate?: number; distribution_url?: string | null; type?: string }) {
  const series = fields.type ? await seriesId(fields.type) : null;
  await env.MODULINE_DB.prepare(
    `INSERT INTO controllers (serial_number, app_id, app_version, client_id, online, app_uptodate, distribution_url, controller_series_id, last_online)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '2026-10-20T10:00:00Z')`,
  ).bind(`SN-${++seq}`, fields.app_id, fields.app_version ?? null, fields.client_id ?? null, fields.online ?? 0, fields.app_uptodate ?? 0, fields.distribution_url ?? null, series).run();
}

/**
 * A bucket that tells `before(method, args, real)` about every call before passing it on
 * (to record the order of writes, or to race them).
 */
export function spyBucket(real: R2Bucket, before: (method: string, args: any[], target: R2Bucket) => Promise<void>): R2Bucket {
  return new Proxy(real, {
    get(target, prop) {
      const v = (target as any)[prop];
      if (typeof v !== 'function') return v;
      return async (...args: any[]) => {
        await before(String(prop), args, target);
        return v.apply(target, args);
      };
    },
  });
}
