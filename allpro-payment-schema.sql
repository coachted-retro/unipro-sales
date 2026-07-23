-- AllPro Payment Milestone Tracking
-- Run against D1 database: termac-one-db

-- Payment milestone fields on existing quotes table
-- (Run these only if columns don't exist yet)
ALTER TABLE allpro_quotes ADD COLUMN deposit_paid REAL DEFAULT 0;
ALTER TABLE allpro_quotes ADD COLUMN deposit_paid_at INTEGER;
ALTER TABLE allpro_quotes ADD COLUMN draw_sent_at INTEGER;
ALTER TABLE allpro_quotes ADD COLUMN draw_paid REAL DEFAULT 0;
ALTER TABLE allpro_quotes ADD COLUMN draw_paid_at INTEGER;
ALTER TABLE allpro_quotes ADD COLUMN final_sent_at INTEGER;
ALTER TABLE allpro_quotes ADD COLUMN final_paid REAL DEFAULT 0;
ALTER TABLE allpro_quotes ADD COLUMN final_paid_at INTEGER;
ALTER TABLE allpro_quotes ADD COLUMN payment_stage TEXT DEFAULT 'pending';
-- payment_stage values: pending | deposit_sent | deposit_paid | draw_sent | draw_paid | final_sent | final_paid | paid_in_full

-- Automated drip reminder queue
-- Worker cron job reads this table every hour and sends overdue reminders
CREATE TABLE IF NOT EXISTS allpro_payment_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id TEXT NOT NULL,
  milestone TEXT NOT NULL,       -- 'deposit', 'draw', 'final'
  reminder_num INTEGER NOT NULL, -- 1 = 48hr, 2 = 5-day final notice
  fire_at INTEGER NOT NULL,      -- Unix ms timestamp when to send
  sent INTEGER DEFAULT 0,        -- 1 = sent, 0 = pending
  cancelled INTEGER DEFAULT 0,   -- 1 = payment received, cancel reminder
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(quote_id, milestone, reminder_num)
);
CREATE INDEX IF NOT EXISTS idx_apr_fire ON allpro_payment_reminders(fire_at, sent, cancelled);

-- Register new table in proxy (add to ALLOWED_TABLES in cms-cors-proxy-worker.js)
-- Prefix: APR → allpro_payment_reminders
