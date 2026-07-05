// ════════════════════════════════════════════════════════════════════════
// TERMAC INVOICES — shared invoice ledger
// ────────────────────────────────────────────────────────────────────────
// This is the real Invoice entity the AR/AP conversation identified as
// missing: AR was previously a computed view derived on the fly from raw
// job records (no invoice number, no document, no status history, nothing
// searchable). This module gives every invoice its own persistent record,
// tied back to the same CRM account object everywhere else in the platform
// already uses (accountId), so a rep, receptionist, or accounting staff can
// all pull up the same invoice from wherever they have account access.
//
// This is intentionally additive. It does NOT touch or replace the
// existing loadAR() computation in accounting-portal.html, which the
// Controller Dashboard relies on today for real DSO/aging metrics. Going
// forward, new deals create a real invoice record here. Whether and how
// to reconcile historical derived-AR data into real invoice records is a
// judgment call on data that was never properly tracked — that's a
// decision for a live session, not something to guess at unsupervised.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  var INVOICE_KEY = 'termac_invoices';
  var COUNTER_KEY = 'termac_invoice_counter';

  function load() {
    try { return JSON.parse(localStorage.getItem(INVOICE_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function save(arr) {
    try { localStorage.setItem(INVOICE_KEY, JSON.stringify(arr)); return true; }
    catch (e) { return false; }
  }

  function money(n) {
    n = Number(n) || 0;
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  // Sequential, human-readable invoice numbers — INV-100001, INV-100002, ...
  // Persisted counter so numbers never repeat even across sessions/tabs.
  function nextInvoiceNumber() {
    var n = 100000;
    try { n = Number(localStorage.getItem(COUNTER_KEY)) || 100000; } catch (e) {}
    n += 1;
    try { localStorage.setItem(COUNTER_KEY, String(n)); } catch (e) {}
    return 'INV-' + n;
  }

  // Due date + initial status, driven off the account's own pricing terms.
  // Per-visit / mom-and-pop customers: card on file, paid same day, no
  // follow-up needed. Contract (annual) customers: due on their own
  // billing cadence, and genuinely need aging/follow-up until paid.
  function computeTermsAndStatus(account, now) {
    var pricingMode = (account && account.pricingMode) || 'per_visit';
    var cadence = (account && account.billingCadence) || null;

    if (pricingMode !== 'annual') {
      // Per-visit: due immediately, auto-paid off card on file same day.
      return {
        pricingMode: 'per_visit',
        billingCadence: null,
        dueDate: now,
        status: 'paid',
        paidDate: now,
        paymentMethod: 'card_on_file',
      };
    }

    var daysOut = cadence === 'quarterly' ? 90 : cadence === 'annually' ? 365 : 30; // default monthly
    return {
      pricingMode: 'annual',
      billingCadence: cadence || 'monthly',
      dueDate: now + daysOut * 86400000,
      status: 'sent',
      paidDate: null,
      paymentMethod: null,
    };
  }

  // Build the line items this invoice will show, from whatever the
  // estimate/job packet actually carried. Falls back to a single line
  // using the job's own revenue figure if no itemized breakdown exists.
  function buildLineItems(jobPacket, est) {
    var srcLines = (est && est.lineItems) || (jobPacket && jobPacket.lineItems) || null;
    if (srcLines && srcLines.length) {
      return srcLines.map(function (li) {
        var qty = Number(li.qty) || 1;
        var unitPrice = Number(li.unitPrice != null ? li.unitPrice : li.price) || 0;
        var lineTotal = li.lineTotal != null ? Number(li.lineTotal) : qty * unitPrice;
        return {
          description: li.desc || li.description || li.name || 'Service',
          qty: qty,
          unitPrice: unitPrice,
          lineTotal: lineTotal,
        };
      });
    }
    var total = (jobPacket && jobPacket.revenue) || (est && est.total) || 0;
    return [{
      description: (jobPacket && jobPacket.serviceType) || 'Service',
      qty: 1,
      unitPrice: total,
      lineTotal: total,
    }];
  }

  // Main entry point — called when a deal closes (lcWonLead) or whenever
  // else a completed job needs a real invoice generated against an
  // account. account and jobPacket are required; est (the raw estimate
  // data) is optional but improves line-item detail when present.
  function create(account, jobPacket, est) {
    if (!account || !account.id) return null;
    var now = Date.now();
    var terms = computeTermsAndStatus(account, now);
    var lineItems = buildLineItems(jobPacket, est);
    var amount = lineItems.reduce(function (s, li) { return s + (Number(li.lineTotal) || 0); }, 0);

    var invoice = {
      id: 'inv_' + now + '_' + Math.floor(Math.random() * 10000),
      invoiceNumber: nextInvoiceNumber(),
      accountId: account.id,
      accountName: account.business || account.name || '',
      division: (jobPacket && jobPacket.division) || (account.services && account.services[0]) || 'UniPro',
      jobId: (jobPacket && jobPacket.id) || null,
      estimateRef: (jobPacket && jobPacket.estimateRef) || (est && est.id) || null,
      lineItems: lineItems,
      amount: amount,
      issuedDate: now,
      dueDate: terms.dueDate,
      status: terms.status,
      pricingMode: terms.pricingMode,
      billingCadence: terms.billingCadence,
      paymentMethod: terms.paymentMethod,
      paidDate: terms.paidDate,
      paidAmount: terms.status === 'paid' ? amount : 0,
      notes: '',
      sentHistory: [{ ts: now, method: 'created', by: 'system' }],
      createdAt: now,
    };

    var all = load();
    all.unshift(invoice);
    save(all);
    return invoice;
  }

  function get(id) {
    return load().find(function (inv) { return inv.id === id; }) || null;
  }

  function getForAccount(accountId) {
    return load()
      .filter(function (inv) { return inv.accountId === accountId; })
      .sort(function (a, b) { return b.issuedDate - a.issuedDate; });
  }

  // Search by invoice number, account name, or division — a plain-text
  // match across the fields a rep or accounting staff would actually
  // search on, not a structured query language.
  function search(query) {
    var q = (query || '').toLowerCase().trim();
    var all = load().sort(function (a, b) { return b.issuedDate - a.issuedDate; });
    if (!q) return all;
    return all.filter(function (inv) {
      return (inv.invoiceNumber || '').toLowerCase().includes(q)
        || (inv.accountName || '').toLowerCase().includes(q)
        || (inv.division || '').toLowerCase().includes(q);
    });
  }

  function markPaid(id, amount, method) {
    var all = load();
    var inv = all.find(function (i) { return i.id === id; });
    if (!inv) return null;
    inv.status = 'paid';
    inv.paidDate = Date.now();
    inv.paidAmount = amount != null ? Number(amount) : inv.amount;
    inv.paymentMethod = method || inv.paymentMethod || 'manual';
    save(all);
    return inv;
  }

  // Logs a resend without changing status — this is the "customer lost
  // it, send it again" action any rep or receptionist with account
  // access can trigger.
  function resend(id, by) {
    var all = load();
    var inv = all.find(function (i) { return i.id === id; });
    if (!inv) return null;
    inv.sentHistory = inv.sentHistory || [];
    inv.sentHistory.push({ ts: Date.now(), method: 'resend', by: by || 'rep' });
    if (inv.status === 'draft') inv.status = 'sent';
    save(all);
    return inv;
  }

  function overdueCheck() {
    var now = Date.now();
    var all = load();
    var changed = false;
    all.forEach(function (inv) {
      if (inv.status === 'sent' && inv.dueDate && inv.dueDate < now) {
        inv.status = 'overdue';
        changed = true;
      }
    });
    if (changed) save(all);
    return all;
  }

  global.TermacInvoices = {
    load: load,
    create: create,
    get: get,
    getForAccount: getForAccount,
    search: search,
    markPaid: markPaid,
    resend: resend,
    overdueCheck: overdueCheck,
    money: money,
  };
})(window);
