// ════════════════════════════════════════════════════════════════════════
// TERMAC D1 SYNC — shared cross-device persistence layer
// ────────────────────────────────────────────────────────────────────────
// Every portal that touches CRM, job, or scheduling data should load this
// instead of writing its own localStorage-only crmSave/crmLoad. This was
// previously only built into termac-os.html — every other portal
// (Sales, Scheduler, Dispatch, Tech Portal, Warehouse) had zero sync at
// all, meaning the same account or lead looked completely different
// depending which device and which portal you happened to open.
//
// localStorage remains the synchronous, always-available read path (so
// the UI never blocks or breaks offline). D1 is written on every save.
//
// 2026-07-10 FIX: previously, D1 was only ever pulled down into local
// storage the very first time a device loaded with a completely empty
// local cache ("if local.length > 0, skip"). Once a device had ANY data
// cached, it never checked D1 again for that table, so any record
// created somewhere else entirely (a different device, or a different
// worker writing straight to D1, like the Digital Business Card booking
// flow) would sit correctly in the database forever but never actually
// appear anywhere. d1Hydrate/d1HydrateAll now always check D1 and merge
// in anything with an id not already present locally (pure additive
// merge, same proven pattern already used by hydrateJobs/
// hydrateWarehouseInventory below) — existing local records are never
// overwritten by this, only new ones get added. A periodic sweep
// (startCrmSyncSweep) also now exists so records show up during an open
// session, not only on page load.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  var D1_API_URL = 'https://unipro-ai-proxy.termac-one.workers.dev';
  var D1_API_SECRET = 'termac2026';
  var D1_SYNC_TABLES = ['accounts', 'leads', 'contacts', 'opportunities', 'bids',
    'jobs', 'deficiencies', 'collections', 'dms_coldcall',
    'allpro_projects', 'allpro_cost_lines', 'appointments', 'allpro_design_projects',
    'broadcasts', 'dispatch_msgs', 'wh_requisitions', 'wh_ready_handoffs', 'parts_requests',
    'transfer_requests', 'scheduler_queue', 'allpro_spiffs',
    'trade_partners', 'trade_partner_referrals', 'trade_partner_bids',
    'reference_library', 'allpro_rate_tables', 'notifications'];

  async function d1Fetch(method, path, body) {
    try {
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json', 'X-API-Secret': D1_API_SECRET },
      };
      if (body) opts.body = JSON.stringify(body);
      var res = await fetch(D1_API_URL + path.replace('/api/', '/db/'), opts);
      return await res.json();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  var FIELD_MAP = {
    // 2026-07-10 FIX: 'business' was previously remapped to 'business_name',
    // a column that never actually existed on the live D1 leads table (the
    // real column is just 'business'). Any lead save that included a
    // business name — i.e. nearly every real lead — was silently failing
    // to reach D1 entirely because of this single wrong mapping; the local
    // save always looked fine so this went unnoticed. Also same root
    // cause for 'score' -> 'ai_score' previously failing (that column
    // simply didn't exist; it's been added to the table now).
    leads: {
      name: 'contact_name', score: 'ai_score',
      status: 'lifecycle_stage', company: 'division', assignedRep: 'assigned_rep',
      created: 'created_at', followupDate: 'follow_up_date',
      isHot: 'is_hot', isNewLead: 'is_new_lead',
    },
    accounts: {
      // 2026-07-10 FIX: previously mapped name -> 'business_name', a
      // column that never existed on the real accounts table (real
      // columns are 'name' and 'business', both already present, no
      // remapping needed at all). Also added every other real column
      // alias below — annualValue, nextDue, etc. — none of which were
      // mapped before, meaning virtually no account field besides id/
      // status/assigned_rep could ever reach D1.
      assignedRep: 'assigned_rep', created: 'created_at',
      annualValue: 'annual_value', nextDue: 'next_due',
      renewalDate: 'renewal_date', lastService: 'last_service',
      healthScore: 'health_score', openDeficiencies: 'open_deficiencies',
      lastCheckin: 'last_checkin', certStatus: 'cert_status',
      statusFlag: 'status_flag', lastStatusCheckAt: 'last_status_check_at',
      confirmationStatus: 'confirmation_status',
    },
    contacts: {
      // 2026-07-10 FIX: previous VALID list for this table (location_id,
      // company_id, first_name, last_name, is_primary) described a
      // schema that was never actually created — the real table uses
      // name/company/title/email/phone/assigned_rep/status directly, no
      // mapping needed for those, they already match.
      assignedRep: 'assigned_rep', created: 'created_at',
    },
    collections: {
      collectedBy: 'collected_by', accountName: 'account_name',
      checkNum: 'check_num', payableTo: 'payable_to', invoiceNum: 'invoice_num',
      photoData: 'photo_data', collectedAt: 'collected_at',
      collectedDate: 'collected_date',
    },
    dms_coldcall: {
      contactName: 'contact_name', parentCompany: 'parent_company', bizType: 'biz_type',
      pricingMode: 'pricing_mode', ownerName: 'owner_name', ownerPhone: 'owner_phone',
      ownerEmail: 'owner_email', decisionMaker: 'decision_maker', dmPhone: 'dm_phone',
      dmEmail: 'dm_email', landlordPhone: 'landlord_phone', landlordEmail: 'landlord_email',
      contractExp: 'contract_exp', updated: 'updated_at',
    },
    appointments: {
      accountId: 'account_id', recordId: 'record_id', isFlexStop: 'is_flex_stop',
      createdAt: 'created_at', createdBy: 'created_by',
    },
    allpro_design_projects: {
      accountId: 'account_id', projectId: 'project_id', createdAt: 'created_at',
    },
    allpro_spiffs: {
      repName: 'rep_name', accountId: 'account_id', projectId: 'project_id',
      createdAt: 'created_at', paidAt: 'paid_at',
    },
    broadcasts: {
      from: 'from_user',
    },
    dispatch_msgs: {
      to: 'to_user', from: 'from_user',
    },
    wh_requisitions: {
      jobId: 'job_id', accountId: 'account_id', accountName: 'account_name',
      techId: 'tech_id', serviceType: 'service_type', jobDate: 'job_date',
      jobTime: 'job_time', riskFlags: 'risk_flags', estimatedTime: 'estimated_time',
      aiNotes: 'ai_notes', photosAnalyzed: 'photos_analyzed',
      kittedBy: 'kitted_by', kittedAt: 'kitted_at', signedOutBy: 'signed_out_by',
      signedOutAt: 'signed_out_at', signedOutItems: 'signed_out_items',
      returnedItems: 'returned_items', createdAt: 'created_at',
    },
    wh_ready_handoffs: {
      jobId: 'job_id', reqId: 'req_id', techName: 'tech_name',
      pulledBy: 'pulled_by', timeStr: 'time_str', techAcknowledged: 'tech_acknowledged',
    },
    parts_requests: {
      requestedBy: 'requested_by',
    },
    scheduler_queue: {
      acceptedAt: 'accepted_at', assignedRep: 'assigned_rep',
    },
    notifications: {
      readFlag: 'read_flag', relatedId: 'related_id', createdAt: 'created_at',
    },
  };

  var VALID = {
    leads: ['id', 'business', 'address', 'city', 'state', 'zip', 'phone', 'email',
      'contact_name', 'contact_title', 'pricing_tier', 'facility_type', 'division',
      'lifecycle_stage', 'ai_score', 'assigned_rep', 'source', 'notes',
      'follow_up_date', 'last_activity', 'converted_at', 'account_id',
      'is_hot', 'is_new_lead', 'escalated', 'created_at', 'updated_at'],
    accounts: ['id', 'name', 'business', 'status', 'services', 'annual_value',
      'next_due', 'renewal_date', 'last_service', 'health_score',
      'assigned_rep', 'open_deficiencies', 'city', 'zip', 'last_checkin',
      'cert_status', 'onboarding', 'created_at', 'updated_at', 'source',
      'address', 'state', 'phone', 'contact_name', 'contact_email',
      'billing_cycle', 'territory', 'division', 'cust_num', 'attention_status',
      'status_flag', 'last_status_check_at', 'confirmation_status'],
    contacts: ['id', 'name', 'company', 'title', 'email', 'phone',
      'assigned_rep', 'status', 'created_at', 'updated_at'],
    jobs: ['id', 'account_id', 'location_id', 'division', 'service_type', 'tech_id',
      'scheduled_date', 'scheduled_time', 'status', 'notes', 'report_url',
      'square_ref', 'completed_at', 'created_at', 'updated_at',
      'due_date', 'source'],
    deficiencies: ['id', 'account_id', 'location_id', 'job_id', 'division', 'description',
      'equipment_type', 'severity', 'status', 'quoted_amount', 'quote_ref',
      'assigned_to', 'due_date', 'resolved_at', 'notes', 'created_at', 'updated_at'],
    // 2026-07-10: previous entry (invoice_ref/amount_paid/due_date/
    // last_contact) described a hypothetical AR-aging schema that was
    // never actually built anywhere in the app -- the real feature
    // (collections-portal.html) is an on-site cash/check collection log:
    // a rep collects payment, logs who/what/how much/method, office marks
    // it posted. Also fixed the disconnected raw key bug separately (see
    // collections-portal.html, ar-portal.html, etc.) -- this table was
    // never actually written to via crmSave at all before tonight, it was
    // always a completely different key (termac_collections vs the
    // termac_crm_collections crmSave/crmLoad actually read/write).
    collections: ['id', 'collected_by', 'account_name', 'division', 'amount',
      'method', 'check_num', 'payable_to', 'invoice_num', 'notes',
      'photo_data', 'status', 'collected_at', 'collected_date', 'history',
      'created_at', 'updated_at'],
    dms_coldcall: ['id', 'business', 'contact_name', 'phone', 'email', 'parent_company',
      'biz_type', 'pricing_mode', 'address', 'city', 'state', 'zip', 'owner_name',
      'owner_phone', 'owner_email', 'role', 'decision_maker', 'dm_phone', 'dm_email',
      'landlord', 'landlord_phone', 'landlord_email', 'competitor', 'contract_exp',
      'notes', 'status', 'updated_at', 'created_at'],
    rep_cards: ['id', 'rep_slug', 'name', 'title', 'divisions', 'phone', 'email',
      'linkedin', 'bio', 'service_area', 'years_experience', 'photo_url', 'created_at', 'updated_at'],
    appointments: ['id', 'account_id', 'record_id', 'tab', 'title', 'business',
      'date', 'time', 'type', 'notes', 'location', 'is_flex_stop', 'rep',
      'created_by', 'division', 'status', 'guests', 'created_at', 'updated_at'],
    notifications: ['id', 'recipient', 'type', 'title', 'message', 'read_flag',
      'related_id', 'created_at', 'updated_at'],
    // 2026-07-10: previously had no explicit entry here at all, which
    // meant every field on a project record passed through unfiltered
    // (d1NormalizeRecord treats an empty VALID list as "allow everything").
    // That's how a second, incompatible schema (QuickBase-import field
    // names: folder_number, accounting_job_number, project_ntp, etc.)
    // ended up sharing this table with the real 9-stage planner's own
    // fields (project_name, estimated_value, fab_status, etc.) without
    // either side ever erroring — both just silently failed whenever they
    // used a column the other side hadn't created. The table now has
    // every column both schemas need; this list is explicit so a future
    // typo'd field name fails loudly (never reaches D1) instead of
    // quietly colliding with something else again.
    // 2026-07-12 FIX: this list only ever had the original field set from
    // when allpro-project-planner.html first shipped. Every detail-tab
    // field added since then (subs, AHJ submittals, compliance checklist,
    // punch list, commissioning checklist, streets permit, UniPro
    // suppression compliance, duct footage, hood crew, linked scheduler,
    // project contacts, RFIs) was being written locally and silently
    // dropped here before ever reaching D1 - meaning that data only ever
    // existed on whichever single device entered it. Confirmed by cross-
    // referencing every updateProjectField() call in the planner against
    // this list.
    allpro_projects: ['id', 'folder_number', 'location_name', 'account_id',
      'accounting_job_number', 'project_type', 'project_description',
      'lead_generation_type', 'project_ntp', 'project_start', 'project_completed',
      'total_quoted_value', 'job_notes', 'stage', 'project_name',
      'estimated_value', 'sale_price', 'site_address', 'facility_type',
      'scope_summary', 'survey_mode', 'survey_notes', 'fab_status', 'fab_notes',
      'delivery_date', 'crane_required', 'final_inspection_date',
      'final_inspection_result', 'stage_updated_at', 'cross_sell_triggered',
      'actual_duct_ft', 'ahj_submittals_json', 'commissioning_checklist_json',
      'compliance_checklist_json', 'estimated_duct_ft', 'hood_crew_assigned',
      'linked_scheduler_id', 'needs_unipro', 'project_contacts_json',
      'punch_list_json', 'rfis_json', 'submittals_json', 'drawing_register_json', 'streets_dept_permit_date',
      'streets_dept_permit_status', 'subcontractors_json',
      'unipro_balloon_test_date', 'unipro_jurisdiction', 'unipro_signoff_status',
      'created_at', 'updated_at'],
    // 2026-07-10: table didn't exist in D1 at all before tonight -- every
    // GET to it returned a 400, visible repeatedly in console screenshots
    // all night. Created to match exactly what allpro-project-planner.html
    // already sends via addCostLine().
    allpro_cost_lines: ['id', 'project_id', 'line_type', 'description',
      'quantity', 'unit', 'estimated_amount', 'actual_amount',
      'material_status', 'created_at', 'updated_at'],
    // 2026-07-10: part of the AllPro reconciliation -- design-portal.html
    // was localStorage-only before this, with no D1 presence at all.
    // project_id links a design/spec project to its parent allpro_projects
    // row (added when the sales-side forward-to-Dan flow creates the
    // project); account_id is kept too since Design Studio can also be
    // opened standalone, not only from an existing AllPro project.
    allpro_design_projects: ['id', 'account_id', 'project_id', 'client', 'site',
      'contact', 'pm', 'division', 'status', 'spec', 'revisions', 'approval',
      'created_at', 'updated_at'],
    // 2026-07-10: $20 flat referral spiff, per Ted, every time a rep
    // forwards an AllPro lead to Dan -- created in svAPForwardToDan()
    // alongside the actual project record, so the rep gets credit that
    // survives the project moving through the whole lifecycle and
    // eventually getting reassigned to Ted. Rolled into each rep's
    // commission tracker (My Goals overlay) as a visible line item, not
    // silently folded into the percentage-commission number.
    allpro_spiffs: ['id', 'rep_name', 'account_id', 'project_id', 'business',
      'amount', 'status', 'created_at', 'paid_at', 'updated_at'],
    // 2026-07-10: localStorage-only audit -- dispatch-status.html's
    // broadcast/direct-message features were write-only, using a raw
    // disconnected key that never reached D1 at all. Note: fixing storage
    // does not by itself make these reach a tech's screen -- nothing in
    // any tech portal currently reads either table. That's a separate,
    // real feature gap (a display/polling UI), not a sync problem.
    broadcasts: ['id', 'ts', 'msg', 'from_user', 'read', 'created_at', 'updated_at'],
    dispatch_msgs: ['id', 'ts', 'to_user', 'from_user', 'msg', 'read',
      'created_at', 'updated_at'],
    wh_requisitions: ['id', 'job_id', 'account_id', 'account_name', 'tech_id',
      'service_type', 'job_date', 'job_time', 'items', 'risk_flags',
      'estimated_time', 'ai_notes', 'photos_analyzed', 'status', 'kitted_by',
      'kitted_at', 'signed_out_by', 'signed_out_at', 'signed_out_items',
      'returned_items', 'created_at', 'updated_at'],
    wh_ready_handoffs: ['id', 'job_id', 'req_id', 'account', 'tech_name',
      'division', 'items', 'pulled_by', 'ts', 'time_str', 'status',
      'tech_acknowledged', 'created_at', 'updated_at'],
    parts_requests: ['id', 'type', 'requested_by', 'division', 'urgency',
      'items', 'notes', 'status', 'created_at', 'updated_at'],
    transfer_requests: ['id', 'date', 'ts', 'tech', 'company', 'warehouse',
      'items', 'notes', 'status', 'created_at', 'updated_at'],
    // 2026-07-10: was already in unipro-ai-proxy's ALLOWED_TABLES (from the
    // very start of tonight) but never actually in D1_SYNC_TABLES, so
    // crmSave never even attempted to push it. Live table also had a
    // completely different, never-used schema (job_id/tech_id/scheduled_date)
    // vs what sales-portal.html/termac-os.html/scheduler-v2.html actually
    // send (business/contact/phone/address/services/acceptedAt/assignedRep) --
    // added the real columns rather than touch the unused ones.
    scheduler_queue: ['id', 'business', 'contact', 'phone', 'address',
      'services', 'accepted_at', 'assigned_rep', 'status', 'created_at', 'updated_at'],
  };

  function d1NormalizeRecord(table, record) {
    var r = {};
    var map = FIELD_MAP[table] || {};
    var valid = new Set(VALID[table] || []);
    var now = Date.now();
    Object.keys(record).forEach(function (k) {
      var col = map[k] || k;
      if (valid.size === 0 || valid.has(col)) {
        var v = record[k];
        // 2026-07-10 FIX: array/object fields (services, certStatus,
        // onboarding, etc.) used to be silently dropped here entirely —
        // they're stored as JSON text now instead, since their D1
        // columns are plain TEXT and built to hold exactly that.
        if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
          try { r[col] = JSON.stringify(v); } catch (e) {}
          return;
        }
        r[col] = v;
      }
    });
    if (!r.created_at) r.created_at = now;
    r.updated_at = now;
    return r;
  }

  // Inverse of FIELD_MAP — converts a raw D1 record (snake_case columns)
  // back into the shape the portal UI already expects (camelCase
  // aliases like business/name/assignedRep). Keeps the original
  // snake_case keys too, so nothing that already reads raw column names
  // directly breaks. Tables with no FIELD_MAP entry pass through
  // unchanged (their local shape already matches D1 columns directly).
  function d1ReverseMap(table, record) {
    var map = FIELD_MAP[table] || {};
    var inverse = {};
    Object.keys(map).forEach(function (camelKey) { inverse[map[camelKey]] = camelKey; });
    var out = Object.assign({}, record);
    Object.keys(record).forEach(function (col) {
      var v = record[col];
      // 2026-07-10 FIX: fields stored as JSON text (services, cert_status,
      // onboarding, etc.) need to come back as real arrays/objects, not
      // stay as strings, or the UI code that reads them (e.g. array
      // methods on r.services) breaks.
      if (typeof v === 'string' && v.length > 1 &&
          ((v[0] === '[' && v[v.length - 1] === ']') || (v[0] === '{' && v[v.length - 1] === '}'))) {
        try { out[col] = JSON.parse(v); } catch (e) {}
      }
      var camelKey = inverse[col];
      if (camelKey && !(camelKey in out)) out[camelKey] = out[col];
    });
    // 2026-07-13 FIX: FIELD_MAP only supports one camelCase alias per D1
    // column, and 'lifecycle_stage' is aliased to 'status' there -- but
    // nearly every UI function in sales-portal.html actually reads
    // r.lifecycleStage, not r.status. Any record hydrated straight from
    // D1 (never re-saved through the app's own save flow) silently had
    // no r.lifecycleStage at all, so it fell back to default/gray stage
    // badges and generic pre-call prep everywhere, even though the
    // correct stage was sitting right there in r.status. This fills
    // r.lifecycleStage from r.status only when it's not already set, so
    // nothing that already relies on r.lifecycleStage is touched.
    if (out.status !== undefined && out.lifecycleStage === undefined) out.lifecycleStage = out.status;
    return out;
  }

  async function d1Push(table, record) {
    if (!D1_SYNC_TABLES.includes(table)) return;
    if (!record || !record.id) return;
    var r = d1NormalizeRecord(table, record);
    if (Object.keys(r).length < 2) return;
    await d1Fetch('POST', '/api/' + table, r);
  }

  async function d1PushBatch(table, records) {
    if (!D1_SYNC_TABLES.includes(table) || !Array.isArray(records)) return;
    for (var i = 0; i < records.length; i++) { await d1Push(table, records[i]); }
  }

  function crmLoad(key) {
    try { return JSON.parse(localStorage.getItem('termac_crm_' + key) || '[]'); }
    catch (e) { return []; }
  }

  // Removes a single record by id: locally right away, then against D1
  // (both the real row and a tombstone), so the deletion actually
  // reaches every other device instead of only ever un-deleting itself
  // the next time hydration runs. crmSave alone could never do this -
  // it only ever adds/updates, so a locally-deleted record with no
  // tombstone just gets silently re-added by the next hydrate.
  async function crmDelete(table, id) {
    if (!id) return;
    var local = crmLoad(table);
    var next = local.filter(function (r) { return r && r.id !== id; });
    try { localStorage.setItem('termac_crm_' + table, JSON.stringify(next)); } catch (e) {}
    if (!D1_SYNC_TABLES.includes(table)) return next;
    try {
      await d1Fetch('DELETE', '/api/' + table + '/' + id);
      await d1Fetch('POST', '/api/crm_tombstones', {
        table_name: table, record_id: id, deleted_at: Date.now(),
      });
    } catch (e) {}
    return next;
  }

  // Tombstones deleted within the lookback window get purged from local
  // cache here. 30 days is generous - long enough that a device offline
  // for weeks still catches up, short enough the tombstones table itself
  // doesn't grow forever.
  var TOMBSTONE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
  async function d1PurgeTombstoned(table) {
    try {
      var res = await d1Fetch('GET', '/api/crm_tombstones?table_name=' + encodeURIComponent(table) + '&limit=500');
      if (!res.ok || !Array.isArray(res.results) || !res.results.length) return 0;
      var cutoff = Date.now() - TOMBSTONE_LOOKBACK_MS;
      var deadIds = {};
      res.results.forEach(function (t) {
        if (t && t.record_id && (t.deleted_at || 0) >= cutoff) deadIds[t.record_id] = true;
      });
      if (!Object.keys(deadIds).length) return 0;
      var local = crmLoad(table);
      var before = local.length;
      var next = local.filter(function (r) { return !(r && deadIds[r.id]); });
      if (next.length !== before) {
        try { localStorage.setItem('termac_crm_' + table, JSON.stringify(next)); } catch (e) {}
      }
      return before - next.length;
    } catch (e) { return 0; }
  }

  // Patched crmSave — writes local immediately (synchronous, always works),
  // then fires the D1 push in the background. A push failure never blocks
  // or breaks the local save; it just means that one record stays
  // local-only until the next successful save of that record.
  function crmSave(key, val) {
    try { localStorage.setItem('termac_crm_' + key, JSON.stringify(val)); } catch (e) {}
    if (D1_SYNC_TABLES.includes(key)) {
      d1PushBatch(key, val).catch(function () {});
    }
  }

  // Additive merge, not a full replace. Fetches D1's current rows for a
  // table and adds any whose id isn't already in local storage — never
  // overwrites an existing local record, so an active edit on this
  // device can never be clobbered by this call. Returns how many new
  // records were merged in, so callers can decide whether to re-render.
  async function d1Hydrate(table) {
    if (!D1_SYNC_TABLES.includes(table)) return { records: [], added: 0, removed: 0 };
    var removed = await d1PurgeTombstoned(table);
    var local = crmLoad(table);
    var existingIds = {};
    local.forEach(function (r) { if (r && r.id) existingIds[r.id] = true; });
    // The Worker caps each request at 500 rows. Tables like accounts (6,127+
    // rows) need multiple pages, so loop on offset until a page comes back
    // with fewer than PAGE_SIZE rows. Hard cap of 60 pages (30,000 rows) as
    // a safety valve against a runaway loop if the API ever misbehaves.
    var PAGE_SIZE = 500;
    var MAX_PAGES = 60;
    var added = 0;
    try {
      for (var page = 0; page < MAX_PAGES; page++) {
        var offset = page * PAGE_SIZE;
        var res = await d1Fetch('GET', '/api/' + table + '?limit=' + PAGE_SIZE + '&offset=' + offset);
        if (!res.ok || !Array.isArray(res.results) || res.results.length === 0) break;
        res.results.forEach(function (rec) {
          if (!rec || !rec.id || existingIds[rec.id]) return;
          local.push(d1ReverseMap(table, rec));
          existingIds[rec.id] = true;
          added++;
        });
        if (res.results.length < PAGE_SIZE) break;
      }
      if (added > 0) {
        try { localStorage.setItem('termac_crm_' + table, JSON.stringify(local)); } catch (e) {}
      }
      return { records: local, added: added, removed: removed };
    } catch (e) {}
    return { records: local, added: 0, removed: removed };
  }

  async function d1HydrateAll(onEach) {
    var totalAdded = 0;
    for (var i = 0; i < D1_SYNC_TABLES.length; i++) {
      var table = D1_SYNC_TABLES[i];
      var result = await d1Hydrate(table);
      if (result.added > 0 || result.removed > 0) {
        totalAdded += result.added;
        if (typeof onEach === 'function') onEach(table, result.added, result.removed);
      }
    }
    return totalAdded;
  }

  // Periodic sweep so records created elsewhere show up during an
  // already-open session, not only on the next full page load. Same
  // interval/pattern as startJobSyncSweep and startWarehouseSyncSweep
  // below. Safe to call from multiple portals; only starts once per page.
  var _crmSweepStarted = false;
  function startCrmSyncSweep(intervalMs, onHydrate) {
    if (_crmSweepStarted) return;
    _crmSweepStarted = true;
    function sweep() {
      d1HydrateAll(onHydrate).catch(function () {});
    }
    sweep(); // run once immediately, then on the interval
    setInterval(sweep, intervalMs || 30000);
  }

  // ── JOBS — separate from the crmSave path above ──────────────────────
  // Jobs live in per-division localStorage keys (unipro_jobs, gto_jobs,
  // filterman_jobs, allpro_jobs, termac_jobs, quality3_jobs), not under
  // termac_crm_jobs. This pushes a division's job list to the shared D1
  // jobs table, tagging each record with its division so the scheduler,
  // dispatch, and tech portal — which all read/write these keys directly —
  // can gain D1 sync without having to be rewritten internally.
  var PHOTO_UPLOAD_URL = 'https://termac-photo-upload.termac-one.workers.dev';
  var MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB
  var ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.readAsDataURL(file);
    });
  }

  // Uploads a rep's card photo via the existing termac-photo-upload worker
  // (already deployed, backed by the real termac-photos R2 bucket) and
  // returns the resulting public URL. Validates type and size client-side
  // before ever sending the bytes.
  async function uploadRepPhoto(repSlug, file) {
    if (!file) return { ok: false, error: 'No file provided' };
    if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
      return { ok: false, error: 'Please choose a JPG, PNG, or WebP image' };
    }
    if (file.size > MAX_PHOTO_BYTES) {
      return { ok: false, error: 'Photo is too large — please choose one under 5MB' };
    }

    var base64;
    try {
      base64 = await fileToBase64(file);
    } catch (e) {
      return { ok: false, error: 'Could not read the selected file' };
    }

    try {
      var res = await fetch(PHOTO_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: 'rep-cards',
          key: repSlug,
          base64: base64,
          contentType: file.type,
        }),
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error || 'Upload failed' };
      }
      return { ok: true, url: data.url };
    } catch (e) {
      return { ok: false, error: 'Could not reach the upload service' };
    }
  }

  async function upsertRepCard(record) {
    if (!record || !record.rep_slug) return { ok: false, error: 'rep_slug is required' };
    try {
      var existing = await d1Fetch('GET', '/api/rep_cards?rep_slug=' + encodeURIComponent(record.rep_slug));
      if (existing.ok && Array.isArray(existing.results) && existing.results.length > 0) {
        var existingId = existing.results[0].id;
        var updateBody = d1NormalizeRecord('rep_cards', record);
        delete updateBody.id;
        return await d1Fetch('PUT', '/api/rep_cards/' + existingId, updateBody);
      } else {
        var newBody = d1NormalizeRecord('rep_cards', record);
        return await d1Fetch('POST', '/api/rep_cards', newBody);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function getRepCard(repSlug) {
    try {
      var res = await d1Fetch('GET', '/api/rep_cards?rep_slug=' + encodeURIComponent(repSlug));
      if (res.ok && Array.isArray(res.results) && res.results.length > 0) return res.results[0];
      return null;
    } catch (e) {
      return null;
    }
  }

  // ── TOUCHPOINTS ── The actual "living history" mechanism — every call,
  // visit, note, or scheduling action from any role, against any account,
  // lead, or contact, logged here. Uses the real, existing activity_log
  // table (confirmed via direct database access: id, entity_type,
  // entity_id, account_id, user_id, action, detail, created_at) rather
  // than a redundant new table — deliberately not an array field on the
  // record itself, since arrays get silently stripped by d1NormalizeRecord
  // when a record syncs, meaning an activityLog array living only inside
  // a synced record would never actually leave the device it was written on.
  function logTouchpoint(pool, recordId, entry, accountId) {
    if (!pool || !recordId || !entry) return null;
    var now = Date.now();
    var full = {
      id: 'act_' + now + '_' + Math.floor(Math.random() * 10000),
      ts: entry.ts || now,
      type: entry.type || 'note',
      icon: entry.icon || '📝',
      title: entry.title || '',
      note: entry.note || '',
      who: entry.who || '',
    };

    // Write local immediately, matching the exact pattern Sales Portal
    // already uses, so the UI updates instantly regardless of network.
    try {
      var records = crmLoad(pool);
      var rec = records.find(function (r) { return r.id === recordId; });
      if (rec) {
        rec.activityLog = rec.activityLog || [];
        rec.activityLog.unshift(full);
        crmSave(pool, records);
      }
    } catch (e) {}

    // Push a normalized row to the real activity_log table in the
    // background — this is what actually makes it visible to a
    // different role or device.
    d1Fetch('POST', '/api/activity_log', {
      id: full.id,
      entity_type: pool,
      entity_id: recordId,
      account_id: accountId || (pool === 'accounts' ? recordId : null),
      user_id: full.who,
      action: full.icon + ' ' + full.title,
      detail: full.note,
      created_at: full.ts,
    }).catch(function () {});

    return full;
  }

  async function getTouchpointsForRecord(pool, recordId) {
    try {
      var res = await d1Fetch('GET', '/api/activity_log?entity_id=' + encodeURIComponent(recordId) + '&limit=200');
      if (res.ok && Array.isArray(res.results)) {
        return res.results.filter(function (r) { return r.entity_type === pool; })
          .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
      }
    } catch (e) {}
    return [];
  }

  // Pulls in touchpoints logged by other roles/devices and merges them
  // into the record's local activityLog, without duplicating entries
  // that are already there — matched by id where present. Splits the
  // combined "icon title" back into separate fields for local display,
  // matching the shape Sales Portal's activityLog already expects.
  async function hydrateTouchpointsIntoRecord(pool, recordId) {
    var remote = await getTouchpointsForRecord(pool, recordId);
    if (!remote.length) return { added: 0 };

    var records = crmLoad(pool);
    var rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) return { added: 0 };
    rec.activityLog = rec.activityLog || [];
    var existingIds = {};
    rec.activityLog.forEach(function (e) { if (e && e.id) existingIds[e.id] = true; });

    var added = 0;
    remote.forEach(function (r) {
      if (existingIds[r.id]) return;
      var actionText = r.action || '';
      var firstSpace = actionText.indexOf(' ');
      var icon = firstSpace > -1 ? actionText.slice(0, firstSpace) : '📝';
      var title = firstSpace > -1 ? actionText.slice(firstSpace + 1) : actionText;
      rec.activityLog.push({
        id: r.id, ts: r.created_at, type: 'synced', icon: icon,
        title: title, note: r.detail || '', who: r.user_id || '',
      });
      added++;
    });

    if (added) {
      rec.activityLog.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      try { localStorage.setItem('termac_crm_' + pool, JSON.stringify(records)); } catch (e) {}
    }
    return { added: added };
  }

  // ── WAREHOUSE INVENTORY ── Each warehouse's stock (on-hand quantities +
  // transaction history per SKU) is stored as one JSON blob per warehouse,
  // not normalized into individual rows. Unlike jobs, which get created
  // independently by many different processes and genuinely need
  // per-record merging, a warehouse's inventory is realistically managed
  // by one operator at a time — so this always pushes the current local
  // state up (local is the freshest view), and only pulls down from D1
  // when local is completely empty, e.g. a brand new device. It never
  // silently overwrites an operator's in-progress counts.
  async function d1PushWarehouseInventory(warehouseKey) {
    var data;
    try { data = localStorage.getItem(warehouseKey); } catch (e) { return { ok: false, error: 'Could not read local storage' }; }
    if (data === null) return { ok: false, error: 'Nothing to push for ' + warehouseKey };

    try {
      var existing = await d1Fetch('GET', '/api/warehouse_inventory?warehouse_key=' + encodeURIComponent(warehouseKey));
      var body = { warehouse_key: warehouseKey, data_json: data };
      if (existing.ok && Array.isArray(existing.results) && existing.results.length > 0) {
        return await d1Fetch('PUT', '/api/warehouse_inventory/' + existing.results[0].id, { data_json: data });
      } else {
        return await d1Fetch('POST', '/api/warehouse_inventory', body);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function hydrateWarehouseInventory(warehouseKey) {
    var local;
    try { local = localStorage.getItem(warehouseKey); } catch (e) { local = null; }
    if (local !== null) return { hydrated: false }; // local wins if present, even an empty object

    try {
      var res = await d1Fetch('GET', '/api/warehouse_inventory?warehouse_key=' + encodeURIComponent(warehouseKey));
      if (res.ok && Array.isArray(res.results) && res.results.length > 0 && res.results[0].data_json) {
        try { localStorage.setItem(warehouseKey, res.results[0].data_json); } catch (e) {}
        return { hydrated: true };
      }
    } catch (e) {}
    return { hydrated: false };
  }

  var WAREHOUSE_KEYS = ['wh_termac_v1', 'wh_unipro_v1', 'wh_allpro_v1'];

  // ── HR DATA (2026-07-10) ── hr-manager-v3.html and hr-portal.html both
  // use a generic hrLoad(key)/hrSave(key, val) helper for 8+ distinct
  // sub-systems (candidates, certs, conduct, holidays, jobs, reviews,
  // timeoff, users, onboard_*) that were all raw localStorage with zero
  // D1 sync. Rather than design 8 separate relational schemas tonight,
  // this reuses the exact same "one JSON blob per key" pattern already
  // proven above for warehouse inventory -- one row per hr_key, whole
  // array/object serialized into data_json. Same accepted tradeoff as
  // warehouse inventory: last full save wins, hydrate only fills in when
  // local is genuinely empty (new device). Not a per-record merge, but a
  // real improvement over zero sync at all.
  async function d1PushHrData(hrKey, data) {
    try {
      var existing = await d1Fetch('GET', '/api/hr_data?hr_key=' + encodeURIComponent(hrKey));
      var body = { hr_key: hrKey, data_json: JSON.stringify(data) };
      if (existing.ok && Array.isArray(existing.results) && existing.results.length > 0) {
        return await d1Fetch('PUT', '/api/hr_data/' + existing.results[0].id, { data_json: body.data_json });
      } else {
        return await d1Fetch('POST', '/api/hr_data', body);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function d1HydrateHrData(hrKey) {
    try {
      var res = await d1Fetch('GET', '/api/hr_data?hr_key=' + encodeURIComponent(hrKey));
      if (res.ok && Array.isArray(res.results) && res.results.length > 0 && res.results[0].data_json) {
        try { return JSON.parse(res.results[0].data_json); } catch (e) { return null; }
      }
    } catch (e) {}
    return null;
  }

  var _warehouseSweepStarted = false;
  function startWarehouseSyncSweep(intervalMs, onHydrate) {
    if (_warehouseSweepStarted) return;
    _warehouseSweepStarted = true;
    function sweep() {
      WAREHOUSE_KEYS.forEach(function (key) {
        hydrateWarehouseInventory(key).then(function (result) {
          if (result.hydrated && typeof onHydrate === 'function') onHydrate(key);
          // Push after hydrate check so a first-time device pulls before
          // it ever pushes its own (empty) state back up.
          d1PushWarehouseInventory(key).catch(function () {});
        }).catch(function () {});
      });
    }
    sweep();
    setInterval(sweep, intervalMs || 30000);
  }

  var JOB_DIVISION_KEYS = {
    unipro_jobs: 'UniPro', quality3_jobs: 'Quality III', gto_jobs: 'GTO',
    filterman_jobs: 'Filter Man', allpro_jobs: 'AllPro', termac_jobs: 'Termac',
  };

  async function d1PushJobs(localKey) {
    var division = JOB_DIVISION_KEYS[localKey];
    if (!division) return;
    var jobs;
    try { jobs = JSON.parse(localStorage.getItem(localKey) || '[]'); } catch (e) { return; }
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (!j || !j.id) continue;
      var record = Object.assign({}, j, { division: j.division || division });
      await d1Push('jobs', record);
    }
  }

  // Reverse of the field mapping used when pushing jobs to D1 — D1 stores
  // snake_case columns (account_id, tech_id, scheduled_date...), but every
  // portal that actually reads a job locally expects accountId, techId,
  // date, time, serviceType. Confirmed directly against scheduler-v2.html
  // and dispatch-v2.html before building this, rather than assumed.
  function d1JobToLocalShape(d1job, accountName) {
    return {
      id: d1job.id,
      accountId: d1job.account_id || null,
      accountName: accountName || '',
      techId: d1job.tech_id || null,
      date: d1job.scheduled_date || null,
      time: d1job.scheduled_time || null,
      serviceType: d1job.service_type || '',
      status: d1job.status || 'pending_schedule',
      notes: d1job.notes || '',
      reportUrl: d1job.report_url || null,
      squareRef: d1job.square_ref || null,
      completedAt: d1job.completed_at || null,
      created: d1job.created_at || null,
      division: d1job.division || '',
    };
  }

  // Pulls jobs down from D1 and merges any that don't already exist
  // locally into the right per-division key. Local data always wins for
  // anything already present — this only ever adds jobs a rep hasn't seen
  // yet (e.g. created on a different device), never overwrites one
  // someone might be actively working on.
  async function hydrateJobs() {
    var res;
    try {
      res = await d1Fetch('GET', '/api/jobs?limit=500');
    } catch (e) { return { added: 0 }; }
    if (!res.ok || !Array.isArray(res.results) || !res.results.length) return { added: 0 };

    var accounts = crmLoad('accounts');
    function accountNameFor(accountId) {
      var acct = accounts.find(function (a) { return a.id === accountId; });
      return acct ? (acct.business || acct.name || '') : '';
    }

    var byKey = {};
    var initialized = {};
    Object.keys(JOB_DIVISION_KEYS).forEach(function (key) { byKey[key] = []; initialized[key] = false; });

    var added = 0;
    res.results.forEach(function (d1job) {
      var localKey = null;
      Object.keys(JOB_DIVISION_KEYS).forEach(function (key) {
        if (JOB_DIVISION_KEYS[key] === d1job.division) localKey = key;
      });
      if (!localKey) return; // unrecognized division, skip rather than guess

      var existing;
      try { existing = JSON.parse(localStorage.getItem(localKey) || '[]'); } catch (e) { existing = []; }
      var alreadyHave = existing.some(function (j) { return j && j.id === d1job.id; });
      if (alreadyHave) return; // local wins, never overwrite

      if (!initialized[localKey]) { byKey[localKey] = existing; initialized[localKey] = true; }
      byKey[localKey].push(d1JobToLocalShape(d1job, accountNameFor(d1job.account_id)));
      added++;
    });

    Object.keys(byKey).forEach(function (key) {
      if (byKey[key].length) {
        try { localStorage.setItem(key, JSON.stringify(byKey[key])); } catch (e) {}
      }
    });

    return { added: added };
  }

  // Non-invasive periodic sweep — deliberately does NOT touch any existing
  // save function in Scheduler, Dispatch, or the Tech Portal, all of which
  // have several different, scattered ways of writing job data today.
  // Instead this just reads whatever's currently sitting in each known job
  // key on an interval and pushes it. Lower risk than patching each write
  // site individually, at the cost of a short sync delay instead of an
  // instant push. Call once per page; safe to call from multiple portals.
  var _jobSweepStarted = false;
  function startJobSyncSweep(intervalMs, onHydrate) {
    if (_jobSweepStarted) return;
    _jobSweepStarted = true;
    var keys = Object.keys(JOB_DIVISION_KEYS);
    function sweep() {
      keys.forEach(function (k) { d1PushJobs(k).catch(function () {}); });
      hydrateJobs().then(function (result) {
        if (result.added > 0 && typeof onHydrate === 'function') onHydrate(result.added);
      }).catch(function () {});
    }
    sweep(); // run once immediately, then on the interval
    setInterval(sweep, intervalMs || 30000);
  }

  global.TermacD1Sync = {
    d1Fetch: d1Fetch,
    d1Push: d1Push,
    d1PushBatch: d1PushBatch,
    d1Hydrate: d1Hydrate,
    d1HydrateAll: d1HydrateAll,
    startCrmSyncSweep: startCrmSyncSweep,
    d1PushJobs: d1PushJobs,
    hydrateJobs: hydrateJobs,
    d1PushWarehouseInventory: d1PushWarehouseInventory,
    d1PushHrData: d1PushHrData,
    d1HydrateHrData: d1HydrateHrData,
    hydrateWarehouseInventory: hydrateWarehouseInventory,
    startWarehouseSyncSweep: startWarehouseSyncSweep,
    startJobSyncSweep: startJobSyncSweep,
    upsertRepCard: upsertRepCard,
    getRepCard: getRepCard,
    logTouchpoint: logTouchpoint,
    getTouchpointsForRecord: getTouchpointsForRecord,
    hydrateTouchpointsIntoRecord: hydrateTouchpointsIntoRecord,
    uploadRepPhoto: uploadRepPhoto,
    d1NormalizeRecord: d1NormalizeRecord,
    d1ReverseMap: d1ReverseMap,
    crmSave: crmSave,
    crmLoad: crmLoad,
    crmDelete: crmDelete,
    SYNC_TABLES: D1_SYNC_TABLES,
    JOB_DIVISION_KEYS: JOB_DIVISION_KEYS,
  };

  // Also expose crmSave/crmLoad/crmDelete as plain globals if the page
  // doesn't already define its own - most portals call these as bare
  // functions rather than through a namespace.
  if (typeof global.crmSave !== 'function') global.crmSave = crmSave;
  if (typeof global.crmLoad !== 'function') global.crmLoad = crmLoad;
  if (typeof global.crmDelete !== 'function') global.crmDelete = crmDelete;

  // ════════════════════════════════════════════════════════════════════
  // APP-UPDATE CHECK (added 2026-07-12 per Ted)
  // ────────────────────────────────────────────────────────────────────
  // With a lot of people on the platform at once, someone can be sitting
  // on an old cached version of a page for hours and never see a fix that
  // was pushed. This polls a tiny app-version.json (bumped automatically
  // on every deploy) and, if the deployed version is newer than the one
  // this page loaded with, shows a small non-blocking banner offering a
  // refresh. It never force-reloads (that could interrupt someone
  // mid-form) -- it just makes the update visible and one tap away.
  //
  // Self-contained and fail-safe: any network hiccup fetching the version
  // file is ignored silently. Loading this file on any page opts that
  // page in automatically, so all 20 portals that already load
  // termac-d1-sync.js get update prompts with zero per-page changes.
  // ════════════════════════════════════════════════════════════════════
  (function appUpdateCheck() {
    var VERSION_URL = 'app-version.json';
    var POLL_MS = 5 * 60 * 1000; // every 5 minutes
    var loadedVersion = null;
    var bannerShown = false;

    function showUpdateBanner() {
      if (bannerShown || document.getElementById('termacUpdateBanner')) return;
      bannerShown = true;
      var bar = document.createElement('div');
      bar.id = 'termacUpdateBanner';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;'
        + 'background:#1A1D21;color:#fff;padding:12px 16px;display:flex;'
        + 'align-items:center;justify-content:center;gap:14px;'
        + 'font-family:Barlow,-apple-system,sans-serif;font-size:14px;'
        + 'box-shadow:0 -2px 12px rgba(0,0,0,.25)';
      bar.innerHTML = '<span>A new version of Termac One is available.</span>'
        + '<button id="termacUpdateBtn" style="background:#C8102E;color:#fff;'
        + 'border:none;border-radius:7px;padding:8px 18px;font-weight:800;'
        + 'font-family:inherit;font-size:13px;cursor:pointer">Refresh now</button>'
        + '<button id="termacUpdateDismiss" style="background:transparent;'
        + 'color:#B8BEC6;border:none;font-size:13px;cursor:pointer">Later</button>';
      document.body.appendChild(bar);
      document.getElementById('termacUpdateBtn').onclick = function () {
        // location.reload(true) is deprecated/ignored in modern browsers;
        // adding a cache-busting param is the reliable way to force a
        // fresh fetch of the page and its assets.
        var u = new URL(window.location.href);
        u.searchParams.set('_v', Date.now());
        window.location.href = u.toString();
      };
      document.getElementById('termacUpdateDismiss').onclick = function () {
        bar.remove();
      };
    }

    function check() {
      // Cache-bust the version file itself, otherwise the browser may hand
      // back a stale cached copy and defeat the whole point.
      fetch(VERSION_URL + '?_=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.version) return;
          if (loadedVersion === null) {
            loadedVersion = data.version; // first read = the version we loaded on
          } else if (data.version !== loadedVersion) {
            showUpdateBanner();
          }
        })
        .catch(function () { /* offline or file missing -- ignore */ });
    }

    if (typeof window !== 'undefined' && window.fetch) {
      check();                    // establish baseline on load
      setInterval(check, POLL_MS); // then poll
      // Also check when the tab regains focus -- someone coming back to a
      // long-open tab is exactly when a stale version is most likely.
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) check();
      });
    }
  })();
})(window);
