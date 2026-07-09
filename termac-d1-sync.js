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
// the UI never blocks or breaks offline). D1 is written on every save and
// hydrated on load if localStorage is empty, exactly the pattern already
// proven in termac-os.html — this file just makes it reusable everywhere.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  var D1_API_URL = 'https://unipro-ai-proxy.termac-one.workers.dev';
  var D1_API_SECRET = 'termac2026';
  var D1_SYNC_TABLES = ['accounts', 'leads', 'contacts', 'opportunities', 'bids',
    'jobs', 'deficiencies', 'collections', 'dms_coldcall',
    'allpro_projects', 'allpro_cost_lines'];

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
    leads: {
      business: 'business_name', name: 'contact_name', score: 'ai_score',
      status: 'lifecycle_stage', company: 'division', assignedRep: 'assigned_rep',
      created: 'created_at', followupDate: 'follow_up_date',
    },
    accounts: {
      name: 'business_name', assignedRep: 'assigned_rep', created: 'created_at',
    },
    contacts: {
      assignedRep: 'assigned_rep', created: 'created_at',
    },
    dms_coldcall: {
      contactName: 'contact_name', parentCompany: 'parent_company', bizType: 'biz_type',
      pricingMode: 'pricing_mode', ownerName: 'owner_name', ownerPhone: 'owner_phone',
      ownerEmail: 'owner_email', decisionMaker: 'decision_maker', dmPhone: 'dm_phone',
      dmEmail: 'dm_email', landlordPhone: 'landlord_phone', landlordEmail: 'landlord_email',
      contractExp: 'contract_exp', updated: 'updated_at',
    },
  };

  var VALID = {
    leads: ['id', 'business_name', 'address', 'city', 'state', 'zip', 'phone', 'email',
      'contact_name', 'contact_title', 'pricing_tier', 'facility_type', 'division',
      'lifecycle_stage', 'ai_score', 'assigned_rep', 'source', 'notes',
      'follow_up_date', 'last_activity', 'converted_at', 'account_id',
      'created_at', 'updated_at'],
    accounts: ['id', 'location_id', 'company_id', 'uni_acct_id', 'q3_acct_id',
      'alp_acct_id', 'flm_acct_id', 'gto_acct_id', 'trm_acct_id',
      'billing_cadence', 'card_on_file', 'square_ref', 'msa_signed',
      'msa_signed_at', 'status', 'assigned_rep', 'created_at', 'updated_at'],
    contacts: ['id', 'location_id', 'company_id', 'first_name', 'last_name',
      'title', 'email', 'phone', 'is_primary', 'created_at', 'updated_at'],
    jobs: ['id', 'account_id', 'location_id', 'division', 'service_type', 'tech_id',
      'scheduled_date', 'scheduled_time', 'status', 'notes', 'report_url',
      'square_ref', 'completed_at', 'created_at', 'updated_at'],
    deficiencies: ['id', 'account_id', 'location_id', 'job_id', 'division', 'description',
      'equipment_type', 'severity', 'status', 'quoted_amount', 'quote_ref',
      'assigned_to', 'due_date', 'resolved_at', 'notes', 'created_at', 'updated_at'],
    collections: ['id', 'account_id', 'invoice_ref', 'amount_due', 'amount_paid',
      'due_date', 'status', 'last_contact', 'notes', 'created_at', 'updated_at'],
    dms_coldcall: ['id', 'business', 'contact_name', 'phone', 'email', 'parent_company',
      'biz_type', 'pricing_mode', 'address', 'city', 'state', 'zip', 'owner_name',
      'owner_phone', 'owner_email', 'role', 'decision_maker', 'dm_phone', 'dm_email',
      'landlord', 'landlord_phone', 'landlord_email', 'competitor', 'contract_exp',
      'notes', 'status', 'updated_at', 'created_at'],
    rep_cards: ['id', 'rep_slug', 'name', 'title', 'divisions', 'phone', 'email',
      'linkedin', 'bio', 'service_area', 'years_experience', 'photo_url', 'created_at', 'updated_at'],
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
        if (Array.isArray(v) || (v !== null && typeof v === 'object')) return;
        r[col] = v;
      }
    });
    if (!r.created_at) r.created_at = now;
    r.updated_at = now;
    return r;
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

  async function d1Hydrate(table) {
    if (!D1_SYNC_TABLES.includes(table)) return;
    var local = crmLoad(table);
    if (local.length > 0) return; // local data wins if present
    try {
      var res = await d1Fetch('GET', '/api/' + table + '?limit=500');
      if (res.ok && Array.isArray(res.results) && res.results.length > 0) {
        try { localStorage.setItem('termac_crm_' + table, JSON.stringify(res.results)); } catch (e) {}
        return res.results;
      }
    } catch (e) {}
    return null;
  }

  async function d1HydrateAll(onEach) {
    for (var i = 0; i < D1_SYNC_TABLES.length; i++) {
      var result = await d1Hydrate(D1_SYNC_TABLES[i]);
      if (result && typeof onEach === 'function') onEach(D1_SYNC_TABLES[i], result);
    }
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
    d1PushJobs: d1PushJobs,
    hydrateJobs: hydrateJobs,
    d1PushWarehouseInventory: d1PushWarehouseInventory,
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
    crmSave: crmSave,
    crmLoad: crmLoad,
    SYNC_TABLES: D1_SYNC_TABLES,
    JOB_DIVISION_KEYS: JOB_DIVISION_KEYS,
  };

  // Also expose crmSave/crmLoad as plain globals if the page doesn't
  // already define its own — most portals call crmSave()/crmLoad() as
  // bare functions rather than through a namespace.
  if (typeof global.crmSave !== 'function') global.crmSave = crmSave;
  if (typeof global.crmLoad !== 'function') global.crmLoad = crmLoad;
})(window);
