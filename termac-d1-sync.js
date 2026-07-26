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
  var D1_API_SECRET = '5595f2f81254fb603ccb9a57854775c8c91a6410b4adbaccb1f73b4a24282582';
  // 2026-07-16 FIX: service_pricing_catalog and rep_comp_profiles used to
  // sit at the very end of this list. d1HydrateAll works through it
  // sequentially, one table at a time, so anything at the end only
  // finishes loading after every other table ahead of it -- on a cold
  // cache that can take a while. The Create Opportunity modal reads
  // service_pricing_catalog synchronously the moment it's opened, so if
  // someone opened it early in a session, before that far-down table had
  // its turn, every dropdown looked completely dead: not a broken click
  // handler, just genuinely zero data loaded yet. Moved to the front
  // since this reference data is needed immediately for a core feature,
  // not a nice-to-have that can wait its turn.
  var D1_SYNC_TABLES = ['service_pricing_catalog', 'rep_comp_profiles',
    'accounts', 'leads', 'contacts', 'locations', 'opportunities', 'bids',
    'jobs', 'deficiencies', 'collections', 'dms_coldcall',
    'allpro_projects', 'allpro_cost_lines', 'appointments', 'allpro_design_projects',
    'broadcasts', 'dispatch_msgs', 'wh_requisitions', 'wh_ready_handoffs', 'parts_requests',
    'transfer_requests', 'scheduler_queue', 'allpro_spiffs',
    'trade_partners', 'trade_partner_referrals', 'trade_partner_bids',
    'reference_library', 'allpro_rate_tables', 'notifications',
    'accounts_payable', 'expense_reports', 'customer_orders', 'reorder_requests',
    'warehouse_alerts', 'debriefs', 'rcp_calls', 'account_assets', 'tasks', 'st_services', 'st_deficiencies',
    // 2026-07-24 localStorage-to-D1 migration -- full platform audit
    'unipro_jobs', 'route_debriefs', 'office_queue', 'callback_queue',
    'reception_calls', 'tech_referrals', 'hot_lead_notifs', 'payables', 'hr_announcements'];

  // 2026-07-20 per Ted: accounts grew past 23,000 rows -- full-table
  // hydration into one localStorage blob was silently failing every
  // single 30-second sync sweep (localStorage has a hard per-origin
  // size cap browsers enforce, no partial credit) AND burning
  // bandwidth re-fetching up to 30,000 rows each time for nothing, all
  // silently, with zero error surfaced anywhere. Tables this large
  // should never be bulk-synced into the browser at all -- they get
  // queried live from D1 instead (see spAccountsQuery / the rebuilt
  // Accounts tab). This does NOT touch the ability to create or edit a
  // single account -- crmSave still pushes those through normally
  // since 'accounts' stays in D1_SYNC_TABLES above; this only skips
  // the bulk "pull the whole table down" step.


  var D1_NO_BULK_HYDRATE = ['accounts', 'account_assets'];

  async function d1Fetch(method, path, body, opts2) {
    try {
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json', 'X-API-Secret': D1_API_SECRET },
      };
      // keepalive lets this request actually finish even when the tab
      // navigates away immediately after firing it (e.g. usage-logging
      // beacons sent from an <a> click that also leaves the page) --
      // without it, the browser can silently cancel the in-flight fetch.
      if (opts2 && opts2.keepalive) opts.keepalive = true;
      if (body) opts.body = JSON.stringify(body);
      var res = await fetch(D1_API_URL + path.replace('/api/', '/db/'), opts);
      return await res.json();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 2026-07-20 per Ted: send email as whoever's actually signed in --
  // sales, management, DMS, reception, scheduler, tech, every portal --
  // instead of a shared system address, so replies land in their real
  // mailbox. Reads the sender from the same termac_staff_session every
  // portal's auth gate already relies on, so callers just pass to/
  // subject/html. Returns {ok:false, error:'no_graph_token', ...} for
  // anyone who hasn't logged in since Mail.Send was added yet -- callers
  // should fall back to the existing system-send path on any non-ok
  // response rather than just failing silently.
  var STAFF_AUTH_URL = 'https://termac-staff-auth.termac-one.workers.dev';
  async function sendMailAsMe(to, subject, html) {
    var session;
    try { session = JSON.parse(localStorage.getItem('termac_staff_session') || 'null'); } catch (e) {}
    if (!session || !session.email) return { ok: false, error: 'not_signed_in' };
    try {
      var res = await fetch(STAFF_AUTH_URL + '/send-mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_email: session.email, to: to, subject: subject, html: html }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'network_error', message: e.message };
    }
  }

  // 2026-07-20 per Ted: drop-in replacement for the window.open('mailto:...')
  // pattern used everywhere -- tries a real, silent, one-click send as the
  // signed-in person first (no switching to Outlook, no manual Send click).
  // Falls back to the exact original mailto: behavior on ANY failure (no
  // token yet, expired refresh, network error, whatever) so nothing ever
  // just silently fails to reach the recipient -- worst case it behaves
  // exactly like it did before this shipped. subject/body are plain,
  // unencoded strings; this handles both the send and the mailto: encoding.
  function sendOrMailto(to, subject, body, opts) {
    opts = opts || {};
    var toList = Array.isArray(to) ? to.filter(Boolean) : String(to || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    function fallbackMailto() {
      var mailto = 'mailto:' + toList.join(',') + '?subject=' + encodeURIComponent(subject) +
        (opts.cc ? '&cc=' + encodeURIComponent(opts.cc) : '') +
        '&body=' + encodeURIComponent(body);
      window.open(mailto, opts.target || '_blank');
    }
    if (!toList.length) { fallbackMailto(); return; }
    var htmlBody = String(body || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g, '<br>');
    var allRecipients = opts.cc ? toList.concat(String(opts.cc).split(',').map(function(s){ return s.trim(); }).filter(Boolean)) : toList;
    sendMailAsMe(allRecipients, subject, htmlBody).then(function(result) {
      if (result && result.ok) {
        var toastFn = global.spToast || global.toast || global.showToast;
        if (typeof toastFn === 'function') toastFn('\u2709\ufe0f Email sent to ' + toList.join(', '));
      } else {
        fallbackMailto();
      }
    }).catch(function() {
      fallbackMailto();
    });
  }


  // ══════════════════════════════════════════════════════════════════════
  //  OUTLOOK CALENDAR SYNC (Graph API)
  //  Bidirectional, per-rep, using each person's own Graph token.
  //  Push: Termac appointment → Outlook calendar event
  //  Pull: Outlook events → shown in Termac calendar view
  //  Each rep only ever sees/touches their own calendar.
  // ══════════════════════════════════════════════════════════════════════

  // Push a Termac appointment to the signed-in rep's Outlook calendar.
  // Called automatically when an appointment is saved.
  // Returns {ok:true, eventId} on success, {ok:false, error} on failure.
  async function pushApptToOutlook(appt) {
    var session;
    try { session = JSON.parse(localStorage.getItem('termac_staff_session') || 'null'); } catch(e) {}
    if (!session || !session.email) return { ok: false, error: 'not_signed_in' };

    try {
      var startDt = appt.date + 'T' + (appt.time || '09:00') + ':00';
      var endDt   = appt.date + 'T' + (appt.timeEnd || (appt.time ? addHour(appt.time) : '10:00')) + ':00';

      var body = [
        appt.notes || '',
        appt.location ? ('📍 ' + appt.location) : '',
        appt.phone    ? ('📞 ' + appt.phone)    : '',
        '',
        'Created in Termac One — ' + (appt.id || '')
      ].filter(Boolean).join('\n');

      var event = {
        subject: appt.title || appt.business || 'Termac Stop',
        body: { contentType: 'text', content: body },
        start: { dateTime: startDt, timeZone: 'America/New_York' },
        end:   { dateTime: endDt,   timeZone: 'America/New_York' },
        location: appt.location ? { displayName: appt.location } : undefined,
        categories: ['Termac One'],
      };

      var res = await fetch(STAFF_AUTH_URL + '/calendar-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_email: session.email, event: event, termac_appt_id: appt.id })
      });
      var data = await res.json();
      return data;
    } catch(e) {
      return { ok: false, error: e.message };
    }
  }

  // Pull Outlook calendar events for the signed-in rep for a given date range.
  // Returns array of {id, title, start, end, location, isOutlook:true}
  async function pullOutlookEvents(startDate, endDate) {
    var session;
    try { session = JSON.parse(localStorage.getItem('termac_staff_session') || 'null'); } catch(e) {}
    if (!session || !session.email) return [];

    try {
      var res = await fetch(STAFF_AUTH_URL + '/calendar-pull?email=' + encodeURIComponent(session.email)
        + '&start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate));
      var data = await res.json();
      if (!data.ok || !Array.isArray(data.events)) return [];
      return data.events.map(function(ev) {
        return {
          id: 'outlook_' + (ev.id || Math.random()),
          title: ev.subject || 'Outlook Event',
          date: (ev.start && ev.start.dateTime) ? ev.start.dateTime.slice(0, 10) : startDate,
          time: (ev.start && ev.start.dateTime) ? ev.start.dateTime.slice(11, 16) : '',
          timeEnd: (ev.end && ev.end.dateTime) ? ev.end.dateTime.slice(11, 16) : '',
          location: (ev.location && ev.location.displayName) || '',
          notes: (ev.body && ev.body.content) || '',
          isOutlook: true,
          outlookId: ev.id,
          color: '#0078D4',
          bg: '#EBF5FB',
          label: '📅 Outlook',
          type: 'outlook',
        };
      });
    } catch(e) {
      return [];
    }
  }

  // Helper: add 1 hour to a HH:MM string
  function addHour(timeStr) {
    var parts = (timeStr || '09:00').split(':');
    var h = parseInt(parts[0], 10) + 1;
    return (h < 10 ? '0' : '') + h + ':' + (parts[1] || '00');
  }


  // 2026-07-20 per Ted: accounts is too large to ever hold client-side
  // (see D1_NO_BULK_HYDRATE above) -- these query D1 live instead,
  // the actual right way to do this at this scale, same pattern
  // Salesforce/ServiceTrade/ServiceTitan use (ask the server for
  // exactly the view you want, don't sync the whole database to the
  // browser first). Uses the raw SQL query endpoint for the OR/LIKE
  // logic the simple ?column=value filter API can't express.
  async function d1RawQuery(sql, params) {
    try {
      var res = await d1Fetch('POST', '/api/query', { sql: sql, params: params || [] });
      return (res && res.ok && Array.isArray(res.results)) ? res.results : [];
    } catch (e) { return []; }
  }

  // "My Accounts": assigned to me by name, or genuinely unassigned --
  // matches the same ownership rule the rest of the app already uses
  // for leads/contacts/locations, just asked of D1 directly instead of
  // filtering a giant local array that can no longer exist.
  async function d1MyAccounts(repName, limit) {
    return d1RawQuery(
      "SELECT * FROM accounts WHERE assigned_rep = ? AND (status IS NULL OR status != 'archived') ORDER BY updated_at DESC LIMIT ?",
            [repName, limit || 100]
    );
  }

  // Live search across name/business/phone/address -- the actual
  // replacement for scanning a local copy of the whole table. Caller
  // is responsible for debouncing (same reasoning as the top search
  // bar fix -- this shouldn't fire on every keystroke either).
  async function d1SearchAccounts(term, limit) {
    var like = '%' + String(term || '').trim() + '%';
    return d1RawQuery(
      'SELECT * FROM accounts WHERE name LIKE ? OR business LIKE ? OR phone LIKE ? OR address LIKE ? OR zip LIKE ? ORDER BY updated_at DESC LIMIT ?',
      [like, like, like, like, like, limit || 50]
    );
  }

  // Live phone-duplicate check against accounts specifically (leads/
  // contacts/locations still check fine against their own small local
  // pools -- only accounts needed to move off the local cache).
  async function d1CheckAccountPhoneDuplicate(phone) {
    var norm = String(phone || '').replace(/[^\d]/g, '');
    if (norm.length < 7) return null;
    var rows = await d1RawQuery('SELECT id, name, business, phone FROM accounts WHERE phone LIKE ? LIMIT 5', ['%' + norm.slice(-7) + '%']);
    var match = rows.find(function(r) { return String(r.phone || '').replace(/[^\d]/g, '') === norm; });
    return match ? { type: 'account', label: 'Account', id: match.id, name: match.business || match.name || 'Unnamed' } : null;
  }

  // account_assets is even bigger than accounts was when it broke
  // (27,000+ rows) -- same fix, scoped live query for exactly the one
  // location/account being viewed instead of ever syncing the whole
  // table. Checks location_id first (assets added directly via + Add
  // Asset), falls back to account_id (everything ServiceTrade synced,
  // which predates location_id existing at all) -- same fallback
  // pattern the Equipment/Assets panel already used against local data.
  async function d1LocationAssets(locationId, accountId) {
    if (!locationId && !accountId) return [];
    return d1RawQuery(
      'SELECT * FROM account_assets WHERE location_id = ? OR (location_id IS NULL AND account_id = ?) LIMIT 100',
      [locationId || '', accountId || '']
    );
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
      // 2026-07-13 FIX (root cause of the Lead->Contact->Opportunity
      // pipeline data corruption): this previously mapped status ->
      // lifecycle_stage and had NO mapping for lifecycleStage itself.
      // Since d1NormalizeRecord only writes a field to D1 if its mapped
      // column name is in VALID, and VALID only lists the snake_case
      // 'lifecycle_stage' (not camelCase 'lifecycleStage'), the actual
      // pipeline stage set by advanceStage() when a user changes the
      // dropdown was silently dropped before ever reaching D1 - while
      // status (lead temperature: new/hot/warm/cold, a completely
      // different concept) got written into the lifecycle_stage column
      // instead. Every stage change via the dropdown updated the local
      // browser cache correctly but never propagated to any other
      // device; any record hydrated fresh from D1 showed whatever
      // temperature value happened to be set (or nothing) as its stage,
      // not the real pipeline position. This is exactly what happened
      // to the "Test Cafe" record from sales-portal.html, which set
      // status='new' and had no lifecycleStage of its own - it landed
      // in D1 as lifecycle_stage='new', a value matching no pipeline
      // bucket at all, so no view could ever place it anywhere.
      lifecycleStage: 'lifecycle_stage',
      name: 'contact_name', score: 'ai_score',
      company: 'division', assignedRep: 'assigned_rep',
      created: 'created_at', followupDate: 'follow_up_date',
      isHot: 'is_hot', isNewLead: 'is_new_lead',
      // 2026-07-13 per Ted: touch points/notes need to actually reach D1
      // so a second person logging in sees the same conversation history
      // -- activityLog had no mapping and no column existed at all,
      // meaning every touch point ever logged (calls, visits, notes) has
      // been 100% local to whichever device logged it, across the whole
      // platform (leads, contacts, accounts, opportunities alike).
      activityLog: 'activity_log',
      // 2026-07-16 per Ted: a lead stays standalone until it's connected
      // to a location as a contact -- locationId records what location
      // it converted into, once it does.
      locationId: 'location_id',
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
      activityLog: 'activity_log',
    },
    contacts: {
      // 2026-07-10 FIX: previous VALID list for this table (location_id,
      // company_id, first_name, last_name, is_primary) described a
      // schema that was never actually created — the real table uses
      // name/company/title/email/phone/assigned_rep/status directly, no
      // mapping needed for those, they already match.
      assignedRep: 'assigned_rep', created: 'created_at',
      // 2026-07-13 FIX: accountId was never in VALID at all, and the
      // contacts table had no account_id column - so a contact created
      // with a link to an account had that link silently stripped
      // before ever reaching D1. This is a large part of why AllPro's
      // Contacts tab, which filters contacts by account_id, looked
      // empty even when contacts existed.
      accountId: 'account_id',
      // 2026-07-16 per Ted: a contact is a person tied to a location,
      // never a stage or a deal -- this is the new primary parent link.
      locationId: 'location_id',
      activityLog: 'activity_log',
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
      activityLog: 'activity_log',
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
    // The AP record shape already used across accounting-portal.html,
    // ap-portal.html, procurement-portal.html, and warehouse-portal.html
    // - camelCase fields, mapped straight through to the D1 columns.
    accounts_payable: {
      dueDate: 'due_date', invoiceNum: 'invoice_num', loggedAt: 'logged_at',
      paidAt: 'paid_at',
    },
    expense_reports: {
      periodFrom: 'period_from', periodTo: 'period_to', lineItems: 'line_items',
      submittedAt: 'submitted_at', submittedDate: 'submitted_date',
      autoCloseAt: 'auto_close_at',
    },
    customer_orders: {
      accountId: 'account_id', accountName: 'account_name', siteNotes: 'site_notes',
      visitType: 'visit_type', inventorySnapshot: 'inventory_snapshot',
      paymentMethod: 'payment_method', paymentRef: 'payment_ref',
      customerSignature: 'customer_signature', createdTs: 'created_ts',
      scheduledDelivery: 'scheduled_delivery',
      locationId: 'location_id',
    },
    // account_assets, added 2026-07-16 -- existed since ServiceTrade
    // sync (hood systems, fire extinguishers, emergency lights, etc.)
    // but was written only by the servicetrade-sync Worker directly
    // against D1, never read or written from any client. locationId is
    // the only client-writable field for now; every other column is
    // ServiceTrade-owned data, surfaced read-only on the Location page.
    account_assets: {
      accountId: 'account_id', externalAssetId: 'external_asset_id',
      assetType: 'asset_type', locationInSite: 'location_in_site',
      serviceLine: 'service_line', installDate: 'install_date',
      maintenanceDueDate: 'maintenance_due_date',
      hydrostaticTestDueDate: 'hydrostatic_test_due_date',
      locationId: 'location_id',
      createdAt: 'created_at', updatedAt: 'updated_at',
    },
    // tasks, added 2026-07-17 per Ted: self-assigned to-dos, standalone
    // or attached to a lead/location/contact/opportunity/account via
    // recordType+recordId. recordLabel is a cached display name so the
    // Home dashboard task list doesn't need a lookup per record.
    tasks: {
      dueDate: 'due_date', assignedRep: 'assigned_rep',
      recordType: 'record_type', recordId: 'record_id', recordLabel: 'record_label',
      createdAt: 'created_at', updatedAt: 'updated_at', completedAt: 'completed_at',
    },
    reorder_requests: {
      accountId: 'account_id', accountName: 'account_name', requestedAt: 'requested_at',
    },
    warehouse_alerts: {
      jobId: 'job_id', confirmedBy: 'confirmed_by', confirmedAt: 'confirmed_at',
      warehouseNotes: 'warehouse_notes', itemCount: 'item_count',
    },
    // Opportunities as real child records of an account, added
    // 2026-07-13 - this table (and D1_SYNC_TABLES entry) already
    // existed with no FIELD_MAP or VALID entry at all, which worked by
    // accident (no VALID list means every field passes through
    // unfiltered) but wasn't robust - explicit now, matching the real
    // D1 columns.
    opportunities: {
      accountId: 'account_id', contactId: 'contact_id',
      // 2026-07-16 per Ted: an opportunity attaches to a location, not
      // to the contact or the account directly. Account only gets
      // created/matched once an opportunity at a location wins.
      locationId: 'location_id',
      expectedClose: 'expected_close',
      closedAt: 'closed_at', assignedRep: 'assigned_rep',
      activityLog: 'activity_log',
      slaDays: 'sla_days', serviceType: 'service_type',
      monthlyValue: 'monthly_value', termMonths: 'term_months',
      resolutionStatus: 'resolution_status', resolutionDate: 'resolution_date',
      lostReasonCode: 'lost_reason_code', pendingReasonCode: 'pending_reason_code',
      resolutionNotes: 'resolution_notes', flaggedAt: 'flagged_at',
      lostPriceDivision: 'lost_price_division',
      // 2026-07-17 per Ted: digital signature on the attached proposal PDF.
      signToken: 'sign_token', proposalPdfUrl: 'proposal_pdf_url',
      proposalSentAt: 'proposal_sent_at', proposalViewedAt: 'proposal_viewed_at',
      customerSignedName: 'customer_signed_name', customerSignatureImg: 'customer_signature_img',
      acceptedAt: 'accepted_at',
    },
    // Location entity, added 2026-07-16 per Ted. A lead becomes a real
    // physical site when it converts; contacts and opportunities attach
    // here, not directly to an account. accountId stays null until an
    // opportunity at this location wins, then gets set (matching an
    // existing account for the same parent company, or creating a new
    // one) -- one account can hold many locations, e.g. Cintas as a
    // single billed account with several job-site locations under it.
    locations: {
      parentCompany: 'parent_company', companyId: 'company_id',
      accountId: 'account_id',
      leadId: 'lead_id', assignedRep: 'assigned_rep',
      createdAt: 'created_at', updatedAt: 'updated_at',
      activityLog: 'activity_log',
    },
    // Route Debriefs, added 2026-07-13 per Ted - was 100% localStorage-
    // only on whichever device a tech submitted from (route-debrief.html),
    // capped at 60 records and silently truncated, invisible to any GM
    // on a different device. See gm-dashboard.html for the per-division
    // routing this enables.
    debriefs: {
      submittedAt: 'submitted_at', shiftStart: 'shift_start', shiftEnd: 'shift_end',
      vanCondition: 'van_condition', fuelLevel: 'fuel_level',
      suppliesNeeded: 'supplies_needed', vanNotes: 'van_notes',
      salesLeadsDiscovered: 'sales_leads_discovered', customerComplaints: 'customer_complaints',
      siteNotes: 'site_notes', shiftRating: 'shift_rating', extraStops: 'extra_stops',
    },
    // Reception call log, added 2026-07-13 per Ted -- previously 100%
    // localStorage-only, no D1 path at all. callerName/callType/routeTo
    // are camelCase in the JS object; matchedRecordId/matchedPool are
    // new fields this fix adds so a call that DID match an existing
    // lead/contact still shows which one, even though the touchpoint
    // itself is logged separately onto that record via logTouchpoint.
    rcp_calls: {
      callerName: 'caller_name', callType: 'call_type', routeTo: 'route_to',
      loggedBy: 'logged_by', matchedRecordId: 'matched_record_id',
      matchedPool: 'matched_pool',
    },
    // 2026-07-13 FIX: matching the same fix made the same day in
    // termac-os.html's own copy of this map -- bids had no entry here
    // either, meaning every camelCase Bid Pipeline field was silently
    // dropped by the Worker's column-name filter before ever reaching
    // D1. See that file's copy of this comment for the full explanation.
    bids: {
      scopeRaw: 'scope_raw', estValue: 'amount', dueDate: 'due_date',
      refNo: 'ref_no', aiDraft: 'ai_draft', aiDraftedAt: 'ai_drafted_at',
      aiScope: 'ai_scope', crossSellDetected: 'cross_sell_detected',
      docChecklist: 'doc_checklist', priceAnalysis: 'price_analysis',
      outcomeDate: 'outcome_date', scrapedAt: 'scraped_at',
      submittedDate: 'submitted_date',
    },
  };

  var VALID = {
    // 2026-07-15 per Ted: opportunity is now a real object attachable to
    // either a Contact (contact_id) or an Account (account_id), with a
    // full resolution lifecycle -- SLA aging, won/lost/pending outcome,
    // reason, and the lease/tiered/per-diem pricing model. See
    // opportunity_churn_commission_schema_v2.sql for the D1 side.
    opportunities: ['id', 'account_id', 'contact_id', 'location_id', 'name', 'division', 'stage', 'value',
      'assigned_rep', 'expected_close', 'notes', 'closed_at',
      'sla_days', 'service_type', 'monthly_value', 'term_months',
      'resolution_status', 'resolution_date', 'lost_reason_code',
      'pending_reason_code', 'resolution_notes', 'flagged_at',
      'lost_price_division',
      'created_at', 'updated_at', 'activity_log'],
    locations: ['id', 'name', 'parent_company', 'company_id', 'account_id', 'lead_id',
      'address', 'city', 'state', 'zip', 'division', 'phone', 'assigned_rep', 'source',
      'status', 'notes', 'activity_log', 'created_at', 'updated_at'],
    accounts_payable: ['id', 'vendor', 'amount', 'division', 'category',
      'due_date', 'invoice_num', 'notes', 'status', 'logged_at', 'paid_at',
      'source', 'created_at', 'updated_at'],
    expense_reports: ['id', 'employee', 'division', 'title', 'period_from',
      'period_to', 'notes', 'line_items', 'total', 'receipts', 'status',
      'submitted_at', 'submitted_date', 'history', 'auto_close_at',
      'created_at', 'updated_at'],
    customer_orders: ['id', 'account_id', 'account_name', 'address',
      'site_notes', 'rep', 'visit_type', 'type', 'lines', 'total',
      'inventory_snapshot', 'payment_method', 'payment_ref',
      'customer_signature', 'status', 'created_ts', 'scheduled_delivery',
      'location_id', 'created_at', 'updated_at'],
    account_assets: ['id', 'account_id', 'external_asset_id', 'asset_type',
      'description', 'location_in_site', 'service_line', 'manufacturer',
      'model', 'size', 'install_date', 'maintenance_due_date',
      'hydrostatic_test_due_date', 'source', 'location_id',
      'created_at', 'updated_at'],
    tasks: ['id', 'title', 'notes', 'due_date', 'status', 'assigned_rep',
      'record_type', 'record_id', 'record_label',
      'created_at', 'updated_at', 'completed_at'],
    reorder_requests: ['id', 'account_id', 'account_name', 'address', 'rep',
      'items', 'requested_at', 'status', 'created_at', 'updated_at'],
    warehouse_alerts: ['id', 'ts', 'type', 'status', 'confirmed', 'account',
      'job_id', 'division', 'items', 'note', 'confirmed_by', 'confirmed_at',
      'warehouse_notes', 'company', 'warehouse', 'tech', 'item_count',
      'created_at', 'updated_at'],
    debriefs: ['id', 'date', 'submitted_at', 'tech', 'division', 'shift_start',
      'shift_end', 'truck', 'odometer', 'van_condition', 'fuel_level',
      'supplies_needed', 'van_notes', 'sales_leads_discovered',
      'customer_complaints', 'site_notes', 'blockers', 'shift_rating',
      'extra_stops', 'created_at', 'updated_at'],
    rcp_calls: ['id', 'ts', 'caller_name', 'company', 'phone', 'address', 'zip',
      'call_type', 'route_to', 'urgency', 'notes', 'logged_by',
      'matched_record_id', 'matched_pool', 'created_at', 'updated_at'],
    leads: ['id', 'business', 'address', 'city', 'state', 'zip', 'phone', 'email',
      'contact_name', 'contact_title', 'pricing_tier', 'facility_type', 'division',
      'lifecycle_stage', 'ai_score', 'assigned_rep', 'source', 'notes',
      'follow_up_date', 'last_activity', 'converted_at', 'account_id', 'location_id',
      'is_hot', 'is_new_lead', 'escalated', 'created_at', 'updated_at', 'activity_log'],
    accounts: ['id', 'name', 'business', 'status', 'services', 'annual_value',
      'next_due', 'renewal_date', 'last_service', 'health_score',
      'assigned_rep', 'open_deficiencies', 'city', 'zip', 'last_checkin',
      'cert_status', 'onboarding', 'created_at', 'updated_at', 'source',
      'address', 'state', 'phone', 'contact_name', 'contact_email',
      'billing_cycle', 'territory', 'division', 'cust_num', 'attention_status',
      'status_flag', 'last_status_check_at', 'confirmation_status', 'activity_log'],
    contacts: ['id', 'name', 'company', 'title', 'email', 'phone',
      'assigned_rep', 'status', 'account_id', 'location_id', 'created_at', 'updated_at', 'activity_log'],
    jobs: ['id', 'account_id', 'location_id', 'division', 'service_type', 'service_line',
      'tech_id', 'scheduled_date', 'scheduled_time', 'due_date', 'status', 'notes',
      'report_url', 'square_ref', 'job_number', 'frequency', 'interval_days',
      'completed_at', 'source', 'created_at', 'updated_at'],
    st_services: ['id', 'account_id', 'st_location_id', 'service_line', 'description',
      'frequency', 'interval_days', 'next_due', 'last_completed', 'status',
      'tech_id', 'created_at', 'updated_at'],
    st_deficiencies: ['id', 'account_id', 'st_location_id', 'job_id', 'description',
      'asset_type', 'severity', 'status', 'identified_date', 'resolved_date',
      'tech_id', 'notes', 'created_at', 'updated_at'],
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
      'notes', 'status', 'updated_at', 'created_at', 'activity_log'],
    rep_cards: ['id', 'rep_slug', 'name', 'title', 'divisions', 'phone', 'email',
      'linkedin', 'bio', 'service_area', 'years_experience', 'photo_url', 'created_at', 'updated_at'],
    appointments: ['id', 'account_id', 'record_id', 'tab', 'title', 'business',
      'date', 'time', 'type', 'notes', 'location', 'is_flex_stop', 'rep',
      'created_by', 'division', 'status', 'guests', 'created_at', 'updated_at'],
    bids: ['id', 'opportunity_id', 'account_id', 'division', 'bid_number', 'amount',
      'status', 'submitted_date', 'expiration_date', 'title', 'agency', 'source',
      'url', 'scope_raw', 'due_date', 'ref_no', 'ai_draft', 'ai_drafted_at',
      'ai_scope', 'cross_sell_detected', 'doc_checklist', 'price_analysis',
      'outcome_date', 'scraped_at', 'created_at', 'updated_at'],
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
    // 2026-07-16 FIX per Ted: opportunity_id was referenced by the New
    // Project modal's "Opportunity (optional)" picker since the planner
    // first shipped, but was never in this list -- meaning every attempt
    // to link a project to an Opportunity was silently dropped before
    // ever reaching D1 (and the column didn't even exist in the D1 table
    // until today's migration). intake_business_name is new today, for
    // proposal-stage projects that don't have an Account yet.
    allpro_projects: ['id', 'folder_number', 'location_name', 'account_id',
      'opportunity_id', 'intake_business_name',
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
    // 2026-07-21 FIX per Ted: a raw D1 row where services didn't parse
    // as JSON (null, empty string, a stray non-array value from an
    // older import pass) left out.services as something other than a
    // real array -- and there are many .services.map() call sites
    // across the app that all assume it always is one, crashing the
    // whole page the moment a rep clicked into an affected record.
    // Fixing it once here, the one place every live-query fallback
    // already routes through, protects all of them at once.
    if (table === 'accounts' || table === 'leads' || table === 'contacts' || table === 'locations') {
      if (!Array.isArray(out.services)) out.services = out.services ? [out.services] : [];
    }
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

  // ── IN-MEMORY CACHE (replaces localStorage as the read source) ───────────
  // Keys: table name → array of records fetched from D1.
  // All reads go here first. D1 is the source of truth.
  // localStorage is used ONLY as a fallback when D1 is unreachable.
  var _crmCache = {};
  var _crmCacheTs = {};    // timestamp of last D1 fetch per table
  var _crmCacheTTL = 30000; // 30 seconds -- re-fetch from D1 if stale

  // Synchronous read -- returns cache if warm, falls back to localStorage.
  // Async callers should use crmLoadAsync() for a guaranteed-fresh D1 read.
  function crmLoad(key) {
    if (_crmCache[key] !== undefined) return _crmCache[key];
    // Fallback: localStorage (stale data, acceptable for immediate render)
    try {
      var ls = JSON.parse(localStorage.getItem('termac_crm_' + key) || '[]');
      _crmCache[key] = ls;
      // Kick off a background D1 refresh
      crmLoadAsync(key).catch(function(){});
      return ls;
    } catch (e) { return []; }
  }

  // Async read -- always fetches fresh from D1, updates cache + localStorage fallback.
  async function crmLoadAsync(key) {
    if (!D1_SYNC_TABLES.includes(key)) return crmLoad(key);
    var now = Date.now();
    if (_crmCache[key] !== undefined && (now - (_crmCacheTs[key]||0)) < _crmCacheTTL) {
      return _crmCache[key]; // cache is fresh
    }
    try {
      var PAGE_SIZE = 500, MAX_PAGES = 60, all = [], page = 0;
      for (; page < MAX_PAGES; page++) {
        var res = await d1Fetch('GET', '/api/' + key + '?limit=' + PAGE_SIZE + '&offset=' + (page * PAGE_SIZE));
        if (!res.ok || !Array.isArray(res.results) || !res.results.length) break;
        res.results.forEach(function(r) {
          if (r && r.id && (r.status !== 'deleted')) all.push(d1ReverseMap(key, r));
        });
        if (res.results.length < PAGE_SIZE) break;
      }
      _crmCache[key] = all;
      _crmCacheTs[key] = Date.now();
      // Keep localStorage as fallback for offline scenarios
      try { localStorage.setItem('termac_crm_' + key, JSON.stringify(all)); } catch(e) {}
      return all;
    } catch(e) {
      // D1 unreachable -- return cache or localStorage fallback
      if (_crmCache[key] !== undefined) return _crmCache[key];
      try { return JSON.parse(localStorage.getItem('termac_crm_' + key) || '[]'); } catch(e2) { return []; }
    }
  }

  // Write: push to D1 immediately, update cache, update localStorage fallback.
  function crmSave(key, val) {
    // Update in-memory cache immediately so reads are consistent
    _crmCache[key] = Array.isArray(val) ? val : [];
    _crmCacheTs[key] = Date.now();
    // Update localStorage as offline fallback
    try { localStorage.setItem('termac_crm_' + key, JSON.stringify(val)); } catch (e) {}
    // Push to D1 (source of truth)
    if (D1_SYNC_TABLES.includes(key)) {
      d1PushBatch(key, val).catch(function () {});
    }
  }

  // Invalidate cache for a table -- forces next crmLoad to re-fetch from D1.
  function crmInvalidate(key) {
    delete _crmCache[key];
    delete _crmCacheTs[key];
  }

  // Remove a single record by id -- deletes from D1 and removes from cache.
  function crmDelete(key, id) {
    // Remove from cache immediately
    if (_crmCache[key]) {
      _crmCache[key] = _crmCache[key].filter(function(r) { return r && r.id !== id; });
    }
    // Remove from localStorage fallback
    try {
      var pool = JSON.parse(localStorage.getItem('termac_crm_' + key) || '[]');
      pool = pool.filter(function(r) { return r && r.id !== id; });
      localStorage.setItem('termac_crm_' + key, JSON.stringify(pool));
    } catch (e) {}
    // Mark deleted in D1 (source of truth)
    if (D1_SYNC_TABLES.includes(key)) {
      fetch('https://unipro-ai-proxy.termac-one.workers.dev/db/' + key + '/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-API-Secret': D1_API_SECRET },
        body: JSON.stringify({ status: 'deleted', updated_at: Date.now() })
      }).catch(function() {});
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
        // Update in-memory cache (D1 is source of truth)
        _crmCache[table] = local;
        _crmCacheTs[table] = Date.now();
        // Keep localStorage as offline fallback only
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
      if (D1_NO_BULK_HYDRATE.indexOf(table) !== -1) continue;
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

  // ── ONE-TIME REPAIR (2026-07-13) ────────────────────────────────────
  // 310 lead records had a temperature value (new/hot/warm/cold) sitting
  // in lifecycle_stage instead of a real pipeline stage, due to the
  // status->lifecycle_stage FIELD_MAP bug fixed above (and independently
  // in termac-os.html's own duplicated copy of this same mapping).
  // Repaired directly in D1 (reset to 'lead'), but normal hydration only
  // ever adds records missing locally - it never overwrites a record
  // already cached on this device. Every file that loads this shared
  // module (sales-portal, ap-portal, tech-portal-standalone, and others)
  // gets this fix automatically, once per device, gated by the same
  // flag termac-os.html's own copy of this repair uses so it only runs
  // once total regardless of which page a person opens first.
  async function repairLeadStageCache() {
    var FLAG = 'termac_lifecycle_stage_repair_20260713';
    if (localStorage.getItem(FLAG)) return;
    try {
      var local = crmLoad('leads');
      var byId = {};
      local.forEach(function (r, i) { if (r && r.id) byId[r.id] = i; });
      var PAGE_SIZE = 500, MAX_PAGES = 60, fixed = 0;
      for (var page = 0; page < MAX_PAGES; page++) {
        var offset = page * PAGE_SIZE;
        var res = await d1Fetch('GET', '/api/leads?limit=' + PAGE_SIZE + '&offset=' + offset);
        if (!res.ok || !Array.isArray(res.results) || res.results.length === 0) break;
        res.results.forEach(function (rec) {
          if (!rec || !rec.id) return;
          var fresh = d1ReverseMap('leads', rec);
          if (byId.hasOwnProperty(rec.id)) { local[byId[rec.id]] = fresh; }
          else { local.push(fresh); byId[rec.id] = local.length - 1; }
          fixed++;
        });
        if (res.results.length < PAGE_SIZE) break;
      }
      try { localStorage.setItem('termac_crm_leads', JSON.stringify(local)); } catch (e) {}
      localStorage.setItem(FLAG, String(Date.now()));
      if (typeof global.renderCRMView === 'function') global.renderCRMView();
    } catch (e) {}
  }
  repairLeadStageCache();

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
    crmLoadAsync: crmLoadAsync,
    crmInvalidate: crmInvalidate,
    crmDelete: crmDelete,
    SYNC_TABLES: D1_SYNC_TABLES,
    JOB_DIVISION_KEYS: JOB_DIVISION_KEYS,
    sendMailAsMe: sendMailAsMe,
    pushApptToOutlook: pushApptToOutlook,
    pullOutlookEvents: pullOutlookEvents,
    sendOrMailto: sendOrMailto,
    d1RawQuery: d1RawQuery,
    d1MyAccounts: d1MyAccounts,
    d1SearchAccounts: d1SearchAccounts,
    d1CheckAccountPhoneDuplicate: d1CheckAccountPhoneDuplicate,
    d1LocationAssets: d1LocationAssets,
  };

  // Also expose crmSave/crmLoad/crmDelete as plain globals if the page
  // doesn't already define its own - most portals call these as bare
  // functions rather than through a namespace.
  if (typeof global.crmSave !== 'function') global.crmSave = crmSave;
  if (typeof global.crmLoad !== 'function') global.crmLoad = crmLoad;
  if (typeof global.crmLoadAsync !== 'function') global.crmLoadAsync = crmLoadAsync;
  if (typeof global.crmInvalidate !== 'function') global.crmInvalidate = crmInvalidate;
  if (typeof global.crmDelete !== 'function') global.crmDelete = crmDelete;
  if (typeof global.sendMailAsMe !== 'function') global.sendMailAsMe = sendMailAsMe;
  if (typeof global.pushApptToOutlook !== 'function') global.pushApptToOutlook = pushApptToOutlook;
  if (typeof global.pullOutlookEvents !== 'function') global.pullOutlookEvents = pullOutlookEvents;
  if (typeof global.sendOrMailto !== 'function') global.sendOrMailto = sendOrMailto;
  if (typeof global.d1RawQuery !== 'function') global.d1RawQuery = d1RawQuery;
  if (typeof global.d1MyAccounts !== 'function') global.d1MyAccounts = d1MyAccounts;
  if (typeof global.d1SearchAccounts !== 'function') global.d1SearchAccounts = d1SearchAccounts;
  if (typeof global.d1CheckAccountPhoneDuplicate !== 'function') global.d1CheckAccountPhoneDuplicate = d1CheckAccountPhoneDuplicate;
  if (typeof global.d1LocationAssets !== 'function') global.d1LocationAssets = d1LocationAssets;

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
