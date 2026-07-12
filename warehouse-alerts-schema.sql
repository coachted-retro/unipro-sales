-- Warehouse Alerts. Added 2026-07-13. Fixes a severe bug: this table's
-- code comments explicitly describe a bidirectional cross-device
-- workflow ("Warehouse portal calls lcWarehouseConfirmPull() when
-- items are staged. Tech portal polls lcGetWarehouseStatus() before
-- departing.") that was entirely broken, since 'warehouse_alerts' was
-- raw localStorage the whole time. Warehouse staff and the tech
-- dispatched to a job are essentially always on different devices, so
-- warehouse confirming items are staged and pulled never actually
-- reached the tech before they left for the job.
--
-- Two alert types share this table (they shared the same raw
-- localStorage array before this fix, so keeping them together here
-- avoids a split-brain where only one type gets fixed):
--   new_job_pull   - warehouse needs to pull/stage parts before a tech
--                    is dispatched to a job (termac-lifecycle.js)
--   van_resupply    - a tech's van inventory fell below par and needs
--                    restocking (van-inventory.html) - the detailed
--                    request already correctly syncs via the existing
--                    transfer_requests table; this is just the
--                    lightweight alert-feed entry for the same event.

CREATE TABLE IF NOT EXISTS warehouse_alerts (
  id TEXT PRIMARY KEY,
  ts INTEGER,
  type TEXT NOT NULL,
  -- pending, ready (job pull) / pending, fulfilled (van resupply)
  status TEXT NOT NULL DEFAULT 'pending',
  confirmed INTEGER DEFAULT 0,
  -- new_job_pull fields
  account TEXT,
  job_id TEXT,
  division TEXT,
  items TEXT DEFAULT '[]',
  note TEXT,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  warehouse_notes TEXT,
  -- van_resupply fields
  company TEXT,
  warehouse TEXT,
  tech TEXT,
  item_count INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_warehouse_alerts_job ON warehouse_alerts(job_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_alerts_status ON warehouse_alerts(status);
