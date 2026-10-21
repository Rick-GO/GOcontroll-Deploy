-- PINNED EXCERPT of GOcontroll-Database/schema.sql (controller_series; copied 2026-10-21 at
-- Database commit 239123e). Deploy reads id and controller_type, to name the controller type
-- of a folder. A file of its own so a local database built from 0001 gets it too
-- (scripts/setup-local-db.mjs applies each file once). Never apply it to the remote database.

CREATE TABLE IF NOT EXISTS controller_series (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  controller_type TEXT NOT NULL,
  max_slots       INTEGER NOT NULL DEFAULT 8,
  article_number  TEXT,
  price           REAL
);
