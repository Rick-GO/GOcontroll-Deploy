// What Deploy reads from gocontroll-business: customers (managed in the CRM, schema of
// GOcontroll-Hours) and the customer of a project. Reads only: test/readonly-db.test.ts fails
// when any statement on this binding is not a SELECT.

import type { Env } from './env';

export interface CustomerRef { id: number; name: string }

/** Every customer, for the assign picker. */
export async function listCustomers(env: Env): Promise<CustomerRef[]> {
  const { results } = await env.BUSINESS_DB.prepare(
    `SELECT id, name FROM customers ORDER BY name COLLATE NOCASE, id`,
  ).all<CustomerRef>();
  return results;
}

/** Names of the given customers. */
export async function customerNames(env: Env, ids: number[]): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
  if (!wanted.length) return new Map();
  const { results } = await env.BUSINESS_DB.prepare(
    `SELECT id, name FROM customers WHERE id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(wanted)).all<CustomerRef>();
  return new Map(results.map((r) => [r.id, r.name]));
}

/** The customer of each of the given projects. */
export async function projectCustomers(env: Env, projectIds: number[]): Promise<Map<number, number>> {
  const wanted = [...new Set(projectIds.filter((id) => Number.isSafeInteger(id)))];
  if (!wanted.length) return new Map();
  const { results } = await env.BUSINESS_DB.prepare(
    `SELECT id, customer_id FROM projects WHERE id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(wanted)).all<{ id: number; customer_id: number }>();
  return new Map(results.map((r) => [r.id, r.customer_id]));
}

export async function loadCustomer(env: Env, id: number): Promise<CustomerRef | null> {
  return env.BUSINESS_DB.prepare(`SELECT id, name FROM customers WHERE id = ?1`).bind(id).first<CustomerRef>();
}
