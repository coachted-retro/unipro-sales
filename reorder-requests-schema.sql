-- Reorder Requests, submitted from a rep's inventory-scan camera
-- feature in sales-portal.html, intended for the warehouse pick queue.
-- Added 2026-07-13. Note: this fixes the storage layer only - as of
-- this fix there is still no consumer UI anywhere in the codebase that
-- actually displays this queue to warehouse staff. The data now
-- persists to D1 correctly and is available for that view whenever
-- it gets built, but the feature is not end-to-end functional yet.

CREATE TABLE IF NOT EXISTS reorder_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  account_name TEXT,
  address TEXT,
  rep TEXT,
  -- JSON array of {name, qty}
  items TEXT DEFAULT '[]',
  requested_at INTEGER,
  -- pending, fulfilled, cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reorder_requests_status ON reorder_requests(status);
