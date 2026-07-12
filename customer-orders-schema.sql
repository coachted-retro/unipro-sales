-- Customer Orders (product orders placed from the field via the sales
-- portal's Customer Visit wizard). Added 2026-07-13, same class of bug
-- as accounts_payable/expense_reports: 'termac_orders' was raw
-- localStorage with zero D1 sync between sales-portal.html (where reps
-- submit orders) and termac-os.html (the warehouse pick queue). A
-- cross-device notification already fired when an order was placed,
-- but the order record itself - line items, quantities, delivery
-- address, payment info - never actually reached warehouse staff
-- unless they happened to be on the same browser the rep used.

CREATE TABLE IF NOT EXISTS customer_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  account_name TEXT,
  address TEXT,
  site_notes TEXT,
  rep TEXT,
  visit_type TEXT,
  type TEXT,
  -- JSON array of {productId, qty, lineTotal, ...}
  lines TEXT DEFAULT '[]',
  total REAL,
  -- JSON array - inventory snapshot at time of order
  inventory_snapshot TEXT DEFAULT '[]',
  payment_method TEXT,
  payment_ref TEXT,
  customer_signature INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_ts INTEGER,
  scheduled_delivery TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_customer_orders_account ON customer_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_status ON customer_orders(status);
