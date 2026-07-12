-- Expense Reports. Added 2026-07-13, same class of bug as
-- accounts_payable: 'termac_expense_reports' was raw localStorage with
-- zero D1 sync across expense-portal.html (where employees submit),
-- accounting-portal.html, and ap-portal.html (where they get approved).
-- An expense report submitted by an employee never reached the manager
-- or accounting approval queue on a different device.

CREATE TABLE IF NOT EXISTS expense_reports (
  id TEXT PRIMARY KEY,
  employee TEXT,
  division TEXT,
  title TEXT,
  period_from TEXT,
  period_to TEXT,
  notes TEXT,
  -- JSON array of {desc, amount, category, ...}
  line_items TEXT DEFAULT '[]',
  total REAL,
  -- JSON array of receipt references/URLs
  receipts TEXT DEFAULT '[]',
  -- pending, approved, rejected, paid
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at INTEGER,
  submitted_date TEXT,
  -- JSON array of {ts, action, by} audit trail entries
  history TEXT DEFAULT '[]',
  auto_close_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_expense_reports_status ON expense_reports(status);
CREATE INDEX IF NOT EXISTS idx_expense_reports_division ON expense_reports(division);
