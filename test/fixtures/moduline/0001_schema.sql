-- PINNED EXCERPT of GOcontroll-Database/schema.sql (owner of the gocontroll-db schema; copied
-- 2026-10-21 at Database commit 239123e). Used only to build the test D1 behind MODULINE_DB.
-- controllers and project_provisioning are what Deploy reads; controller_tunnels is here
-- because it holds device secrets (tunnel_token, mqtt_password) that Deploy must never read
-- (test/readonly-db.test.ts). REFERENCES clauses to tables left out are dropped. Keep in step
-- with schema.sql; never apply this file to the remote database from this repo.

CREATE TABLE IF NOT EXISTS controllers (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_number            TEXT,
  article_number           TEXT,
  label_code               TEXT,
  controller_series_id     INTEGER,
  processorboard_id        INTEGER,
  hw_code                  INTEGER,
  ems_code                 INTEGER,
  enc_code                 INTEGER,
  integrator_code          INTEGER,
  integrator_id            INTEGER,
  integrator_batch         INTEGER,
  com_module_id            INTEGER,
  software_id              INTEGER,
  led_card_id              INTEGER,
  display_adapter_id       INTEGER,
  display_adapter_ems_code INTEGER,
  display_adapter_type_id  INTEGER,
  connector_config_id      INTEGER,
  slot1_id  INTEGER,
  slot2_id  INTEGER,
  slot3_id  INTEGER,
  slot4_id  INTEGER,
  slot5_id  INTEGER,
  slot6_id  INTEGER,
  slot7_id  INTEGER,
  slot8_id  INTEGER,
  can1_id   INTEGER,
  can2_id   INTEGER,
  can3_id   INTEGER,
  can4_id   INTEGER,
  wlan_module_id INTEGER,
  wlan_serial    TEXT,
  wan_module_id  INTEGER,
  wan_serial     TEXT,
  sim_card_id    INTEGER,
  manufacturer_date TEXT,
  client_id      INTEGER,
  client_number  TEXT,
  project_id     INTEGER,
  notes          TEXT,
  m12_selection_id INTEGER,
  state          TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','wrong','validated')),
  esp_mac        TEXT,
  online         INTEGER DEFAULT 0,
  last_online    TEXT,
  app_version    TEXT,
  app_uptodate   INTEGER,
  app_auto_update INTEGER NOT NULL DEFAULT 0,
  app_id         TEXT,
  distribution_url TEXT,
  tunnel_active_until INTEGER,
  tunnel_online  INTEGER
);

CREATE TABLE IF NOT EXISTS project_provisioning (
  project_id        INTEGER PRIMARY KEY,
  app_id            TEXT,
  service_defaults  TEXT,
  action_defaults   TEXT
);

CREATE TABLE IF NOT EXISTS controller_tunnels (
  serial_number   TEXT PRIMARY KEY,
  tunnel_id       TEXT NOT NULL,
  tunnel_token    TEXT NOT NULL,
  tunnel_hostname TEXT NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  status          TEXT DEFAULT 'configured',
  mqtt_password   TEXT,
  tunnel_domains  TEXT NOT NULL DEFAULT '["gocontroll.com"]',
  primary_domain  TEXT NOT NULL DEFAULT 'gocontroll.com'
);
