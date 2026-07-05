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
    'jobs', 'deficiencies', 'collections'];

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

  // Non-invasive periodic sweep — deliberately does NOT touch any existing
  // save function in Scheduler, Dispatch, or the Tech Portal, all of which
  // have several different, scattered ways of writing job data today.
  // Instead this just reads whatever's currently sitting in each known job
  // key on an interval and pushes it. Lower risk than patching each write
  // site individually, at the cost of a short sync delay instead of an
  // instant push. Call once per page; safe to call from multiple portals.
  var _jobSweepStarted = false;
  function startJobSyncSweep(intervalMs) {
    if (_jobSweepStarted) return;
    _jobSweepStarted = true;
    var keys = Object.keys(JOB_DIVISION_KEYS);
    function sweep() {
      keys.forEach(function (k) { d1PushJobs(k).catch(function () {}); });
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
    startJobSyncSweep: startJobSyncSweep,
    upsertRepCard: upsertRepCard,
    getRepCard: getRepCard,
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
