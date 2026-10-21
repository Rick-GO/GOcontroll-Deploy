// What Deploy reads from gocontroll-db (the controller database, schema owned by
// GOcontroll-Database, schema.sql): which controllers report which App ID, version and
// distribution URL, whether they are online, and the App ID set on a project
// (project_provisioning). Reads only, and only these columns of controllers: client_id,
// project_id, app_id, app_version, app_uptodate, distribution_url, online, last_online
// (COUNT(*) to count them). Never a secret column, never another table:
// test/readonly-db.test.ts fails on any statement that is not such a SELECT.

import type { Env } from './env';

export interface ControllerGroup {
  app_id: string;
  app_version: string | null;
  client_id: number | null;
  distribution_url: string | null;
  total: number;
  online: number;
  up_to_date: number;   // app_uptodate = 1
  last_online: string | null;
}

/**
 * Controllers grouped by App ID, version, customer and distribution URL; for one App ID, or
 * for all. Small: one row per combination, not per controller.
 */
export async function controllerGroups(env: Env, appId?: string): Promise<ControllerGroup[]> {
  const stmt = appId === undefined
    ? env.MODULINE_DB.prepare(
      `SELECT TRIM(app_id) AS app_id, app_version, client_id, distribution_url, COUNT(*) AS total,
              SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN app_uptodate = 1 THEN 1 ELSE 0 END) AS up_to_date,
              MAX(last_online) AS last_online
         FROM controllers
        WHERE app_id IS NOT NULL AND TRIM(app_id) <> ''
        GROUP BY TRIM(app_id), app_version, client_id, distribution_url`,
    )
    : env.MODULINE_DB.prepare(
      `SELECT TRIM(app_id) AS app_id, app_version, client_id, distribution_url, COUNT(*) AS total,
              SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN app_uptodate = 1 THEN 1 ELSE 0 END) AS up_to_date,
              MAX(last_online) AS last_online
         FROM controllers
        WHERE TRIM(app_id) = ?1
        GROUP BY TRIM(app_id), app_version, client_id, distribution_url`,
    ).bind(appId);
  const { results } = await stmt.all<ControllerGroup>();
  return results;
}

/** The projects whose provisioning names an App ID: { project_id, app_id }. */
export async function provisionedProjects(env: Env, appId?: string): Promise<{ project_id: number; app_id: string }[]> {
  const stmt = appId === undefined
    ? env.MODULINE_DB.prepare(
      `SELECT project_id, TRIM(app_id) AS app_id FROM project_provisioning
        WHERE app_id IS NOT NULL AND TRIM(app_id) <> '' ORDER BY project_id`,
    )
    : env.MODULINE_DB.prepare(
      `SELECT project_id, TRIM(app_id) AS app_id FROM project_provisioning WHERE TRIM(app_id) = ?1 ORDER BY project_id`,
    ).bind(appId);
  const { results } = await stmt.all<{ project_id: number; app_id: string }>();
  return results;
}
