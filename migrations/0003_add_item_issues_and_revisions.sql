-- 0003_add_item_issues_and_revisions.sql
-- Create issue reporting & revision history tables

PRAGMA foreign_keys=ON;

BEGIN TRANSACTION;

-- --- issues reported on items ---
CREATE TABLE IF NOT EXISTS item_issues (
  issue_id        TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL,
  user_id         TEXT,                           -- reporter (optional)
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  reason          TEXT NOT NULL,                  -- e.g. typo in stem / wrong official answer
  severity        INTEGER NOT NULL DEFAULT 2,     -- 1=minor, 2=normal, 3=major
  status          TEXT NOT NULL DEFAULT 'open',   -- open | resolved | hidden
  resolution_note TEXT,                           -- admin comment
  resolved_by     TEXT,                           -- admin id
  resolved_ts     TEXT,                           -- resolution time
  meta            TEXT,                           -- JSON string for extra info
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_issues_item_ts
  ON item_issues(item_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_item_issues_status
  ON item_issues(status);

-- --- immutable revision history for items ---
CREATE TABLE IF NOT EXISTS item_revisions (
  rev_id    TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL,
  editor_id TEXT,                                  -- who edited
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  note      TEXT,                                  -- short message: what changed / why
  old_json  TEXT,                                  -- full item before (JSON)
  new_json  TEXT,                                  -- full item after (JSON)
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_revisions_item_ts
  ON item_revisions(item_id, ts DESC);

COMMIT;
