CREATE TABLE IF NOT EXISTS warehouse_inventory (
  id TEXT PRIMARY KEY,
  warehouse_key TEXT UNIQUE NOT NULL,
  data_json TEXT,
  updated_at INTEGER
);
