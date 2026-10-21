// gocontroll-business belongs to Hours and the CRM, gocontroll-db to GOcontroll-Database:
// Deploy only reads them, and from gocontroll-db never a secret. This test runs every flow
// with recording bindings and fails on any statement that is not a SELECT, or that names a
// table or column outside what Deploy may read; a scan of src/ backs it up.

import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { appId, call, controller, customer, ok, upload, zlibPayload } from './helpers';

const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** What Deploy may read per table of gocontroll-db (no secrets; COUNT(*) to count), by the alias the queries use. */
const ALLOWED: Record<string, { table: string; columns: Set<string> }> = {
  c: { table: 'controllers', columns: new Set(['client_id', 'project_id', 'app_id', 'app_version', 'app_uptodate', 'distribution_url', 'online', 'last_online', 'controller_series_id']) },
  s: { table: 'controller_series', columns: new Set(['id', 'controller_type']) },
  p: { table: 'project_provisioning', columns: new Set(['project_id', 'app_id']) },
};
const SECRET = /tunnel_token|mqtt_password|controller_tunnels|app_settings|password|secret|token|esp_mac|sim_card|wlan_serial|wan_serial/i;

function recording(real: D1Database, seen: string[]): D1Database {
  return {
    prepare: (q: string) => { seen.push(q); return real.prepare(q); },
    batch: (s: D1PreparedStatement[]) => real.batch(s),
    exec: (q: string) => { seen.push(q); return real.exec(q); },
    dump: () => real.dump(),
    withSession: () => { throw new Error('not used'); },
  } as unknown as D1Database;
}

test('every statement on BUSINESS_DB and MODULINE_DB is a SELECT of what Deploy may read', async () => {
  const business: string[] = [];
  const moduline: string[] = [];
  const dbs = { BUSINESS_DB: recording(env.BUSINESS_DB, business), MODULINE_DB: recording(env.MODULINE_DB, moduline) };
  const id = appId('R');
  const cu = await customer(`Recorded ${id}`);
  await controller({ app_id: id, app_version: '1.0.0', client_id: cu, online: 1, type: 'Moduline S1' });
  await env.MODULINE_DB.prepare(`INSERT INTO controller_tunnels (serial_number, tunnel_id, tunnel_token, tunnel_hostname, mqtt_password) VALUES ('SN-R', 't', 'SECRET-TOKEN', 'h', 'SECRET-PW')`).run();

  const { payload, rawSize } = await zlibPayload();
  expect((await upload('/api/releases', { appId: id, version: '1.0.0', description: 'x', payload, rawSize: String(rawSize) }, dbs)).status).toBe(200);
  await ok('POST', `/api/folders/${id}/key`, { action: 'generate', replace: true, confirm: id }, 200, dbs);
  expect((await upload('/api/sign', { appId: id, version: '1.0.1', payload, rawSize: String(rawSize) }, dbs)).status).toBe(200);
  expect((await upload('/api/releases', { appId: id, version: '1.0.1', description: 'x', sign: '1', payload, rawSize: String(rawSize) }, dbs)).status).toBe(200);
  for (const path of ['/api/me', '/api/health', '/api/overview', `/api/folders/${id}`, `/api/folders/${id}/key`, '/api/customers', `/api/downloads?appId=${id}`]) {
    expect((await call('GET', path, undefined, dbs)).status, path).toBe(200);
  }
  await ok('PUT', `/api/folders/${id}/customer`, { customerId: cu }, 200, dbs);
  await ok('PUT', `/api/folders/${id}/customer`, { customerId: null }, 200, dbs);

  expect(business.length).toBeGreaterThan(0);
  expect(moduline.length).toBeGreaterThan(0);
  for (const s of [...business, ...moduline]) {
    expect(s, s).toMatch(/^\s*SELECT\b/i);
    expect(s, s).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA)\b/i);
    expect(s, s).not.toMatch(SECRET);
  }
  expect(moduline.some((s) => /\bcontroller_series\b/.test(s)), 'the controller type is read').toBe(true);
  for (const s of moduline) {
    // Every table named is one of the three, under its alias; every column is qualified and allowed.
    const tables = [...s.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)(?:\s+([a-z]))?/gi)];
    expect(tables.length, s).toBeGreaterThan(0);
    for (const [, table, alias] of tables) expect(ALLOWED[alias]?.table, `${table} ${alias} in ${s}`).toBe(table);
    for (const [, alias, column] of s.matchAll(/\b([a-z])\.([a-z_]+)\b/g)) expect(ALLOWED[alias]?.columns.has(column), `${alias}.${column} in ${s}`).toBe(true);
    const bare = s.replace(/'[^']*'/g, '').replace(/\b[a-z]\.[a-z_]+\b/g, '').replace(/\b(?:FROM|JOIN)\s+[a-z_]+(?:\s+[a-z])?\b/gi, '').replace(/\bAS\s+[a-z_]+\b/gi, '');
    expect(bare.match(/\b[a-z][a-z_]*_[a-z_]+\b|\bonline\b/g) ?? [], `unqualified columns in ${s}`).toEqual([]);
  }
});

test('src/ prepares only SELECT literals on the two shared databases', () => {
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  const offenders: string[] = [];
  for (const [file, code] of Object.entries(sources)) {
    for (const m of code.matchAll(/\b(BUSINESS_DB|MODULINE_DB)\b([\s\S]{0,200})/g)) {
      const after = m[2];
      if (/^\s*:\s*D1Database/.test(after)) continue; // the type declaration in env.ts
      if (!/^\s*\.prepare\(\s*[`'"]\s*SELECT\b/i.test(after)) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
    }
  }
  expect(offenders).toEqual([]);
});
