-- PINNED COPY of GOcontroll-Hours/migrations/0001_init.sql (owner of the gocontroll-business
-- schema; copied 2026-10-21 at Hours commit 17948a8). Used only to build the test D1 with the
-- customers and projects tables Deploy reads. Hours 0002-0004 change only time_entries and are
-- left out. Keep in step with Hours; never apply this file to the remote database from this repo.

-- gocontroll-business: shared company data (customers, projects, employees,
-- categories) plus time registration. Owned by GOcontroll-Hours; see CLAUDE.md.
--
-- Conventions
--   * Durations are whole minutes (INTEGER), never floating-point hours.
--   * work_date is the local Europe/Amsterdam calendar date 'YYYY-MM-DD', so a
--     month is the plain string range ['YYYY-MM-01', next month's '-01').
--   * created_at / updated_at / deleted_at are UTC ISO-8601 strings.
--   * Time entries are soft-deleted (deleted_at); every read filters on it.
--   * customers.id and projects.id keep the ids of gocontroll-db's clients and
--     client_projects, because gocontroll-db.controllers refers to them.

CREATE TABLE users (
  email         TEXT PRIMARY KEY CHECK (email = lower(email)),
  display_name  TEXT NOT NULL,
  entra_oid     TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at  TEXT
);

CREATE TABLE customers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL CHECK (length(trim(name)) > 0),
  exact_relation_code  TEXT UNIQUE,          -- Exact Online relation code, for a later link
  street               TEXT,
  postcode             TEXT,
  city                 TEXT,
  country              TEXT,
  phone                TEXT,
  contact_name         TEXT,
  contact_email        TEXT,
  invoice_email        TEXT,
  report_language      TEXT NOT NULL DEFAULT 'en' CHECK (report_language IN ('nl', 'en')),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  code         TEXT NOT NULL CHECK (length(trim(code)) > 0),   -- not unique: existing data reuses codes
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_projects_customer ON projects(customer_id, status);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE CHECK (length(trim(label)) > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE time_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL REFERENCES users(email),
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  work_date       TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  minutes         INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440 AND minutes % 15 = 0),
  category_id     INTEGER NOT NULL REFERENCES categories(id),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0 AND length(description) <= 500),
  travel_minutes  INTEGER CHECK (travel_minutes IS NULL OR (travel_minutes > 0 AND travel_minutes <= 1440)),
  km              REAL CHECK (km IS NULL OR (km > 0 AND km <= 10000)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at      TEXT
);
CREATE INDEX idx_entries_date         ON time_entries(work_date);
CREATE INDEX idx_entries_project_date ON time_entries(project_id, work_date);
CREATE INDEX idx_entries_user_date    ON time_entries(user_email, work_date);

-- Audit trail of sent hour reports. One export = one mail; one PDF per project.
CREATE TABLE exports (
  id            TEXT PRIMARY KEY,               -- UUID
  requested_by  TEXT NOT NULL REFERENCES users(email),
  recipient     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  error         TEXT,
  r2_prefix     TEXT NOT NULL,                  -- exports/{yyyy}/{id}/
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE export_items (
  export_id   TEXT NOT NULL REFERENCES exports(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  month       TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  r2_key      TEXT NOT NULL,                    -- the project's PDF (shared by its months)
  PRIMARY KEY (export_id, project_id, month)
);

INSERT INTO categories (label, sort_order) VALUES
  ('Meeting', 10),
  ('Schematics', 20),
  ('Hardware design', 30),
  ('Labor', 40),
  ('Software development', 50);
