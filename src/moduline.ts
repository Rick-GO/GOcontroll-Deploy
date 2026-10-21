// What Deploy reads from gocontroll-db (the controller database, schema owned by
// GOcontroll-Database, schema.sql): which controllers report which App ID, version and
// distribution URL, whether they are online, what type they are (controller_series), and the
// App ID set on a project (project_provisioning). Reads only, and only these columns:
//   controllers        client_id, project_id, app_id, app_version, app_uptodate,
//                      distribution_url, online, last_online, controller_series_id (COUNT(*) to count)
//   controller_series  id, controller_type
//   project_provisioning project_id, app_id
// Never a secret column, never another table: test/readonly-db.test.ts fails on any statement
// that is not such a SELECT (it checks every c./s. column against these lists).

import type { Env } from './env';

export interface ControllerGroup {
  app_id: string;
  app_version: string | null;
  client_id: number | null;
  distribution_url: string | null;
  controller_type: string | null; // controller_series.controller_type, e.g. "Moduline S1"
  total: number;
  online: number;
  up_to_date: number;   // app_uptodate = 1
  last_online: string | null;
}

/**
 * Controllers grouped by App ID, version, customer, distribution URL and type; for one App ID,
 * or for all. Small: one row per combination, not per controller.
 */
export async function controllerGroups(env: Env, appId?: string): Promise<ControllerGroup[]> {
  const stmt = appId === undefined
    ? env.MODULINE_DB.prepare(
      `SELECT TRIM(c.app_id) AS app_id, c.app_version, c.client_id, c.distribution_url, s.controller_type, COUNT(*) AS total,
              SUM(CASE WHEN c.online = 1 THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN c.app_uptodate = 1 THEN 1 ELSE 0 END) AS up_to_date,
              MAX(c.last_online) AS last_online
         FROM controllers c LEFT JOIN controller_series s ON s.id = c.controller_series_id
        WHERE c.app_id IS NOT NULL AND TRIM(c.app_id) <> ''
        GROUP BY TRIM(c.app_id), c.app_version, c.client_id, c.distribution_url, s.controller_type`,
    )
    : env.MODULINE_DB.prepare(
      `SELECT TRIM(c.app_id) AS app_id, c.app_version, c.client_id, c.distribution_url, s.controller_type, COUNT(*) AS total,
              SUM(CASE WHEN c.online = 1 THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN c.app_uptodate = 1 THEN 1 ELSE 0 END) AS up_to_date,
              MAX(c.last_online) AS last_online
         FROM controllers c LEFT JOIN controller_series s ON s.id = c.controller_series_id
        WHERE TRIM(c.app_id) = ?1
        GROUP BY TRIM(c.app_id), c.app_version, c.client_id, c.distribution_url, s.controller_type`,
    ).bind(appId);
  const { results } = await stmt.all<ControllerGroup>();
  return results;
}

/** The projects whose provisioning names an App ID: { project_id, app_id }. */
export async function provisionedProjects(env: Env, appId?: string): Promise<{ project_id: number; app_id: string }[]> {
  const stmt = appId === undefined
    ? env.MODULINE_DB.prepare(
      `SELECT p.project_id, TRIM(p.app_id) AS app_id FROM project_provisioning p
        WHERE p.app_id IS NOT NULL AND TRIM(p.app_id) <> '' ORDER BY p.project_id`,
    )
    : env.MODULINE_DB.prepare(
      `SELECT p.project_id, TRIM(p.app_id) AS app_id FROM project_provisioning p WHERE TRIM(p.app_id) = ?1 ORDER BY p.project_id`,
    ).bind(appId);
  const { results } = await stmt.all<{ project_id: number; app_id: string }>();
  return results;
}
