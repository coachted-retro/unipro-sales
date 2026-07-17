var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var ST_API_BASE = "https://app.servicetrade.com/api";
var LOCATIONS_PER_BATCH = 300;
var CRON_BATCHES_PER_RUN = 100;

// Service lines that map to UniPro division
var SERVICE_LINE_MAP = {
  "Emergency/Exit Light Group": "unipro",
  "Emergency/Exit Light": "unipro",
  "Fire Suppression": "unipro",
  "Gas Station Fire Suppression": "unipro",
  "Kitchen Fire Suppression": "unipro",
  "Kitchen Suppression Group": "unipro",
  "Kitchen Suppression Cylinder": "unipro",
  "Fire Extinguisher Group": "unipro",
  "Portable Fire Extinguisher": "unipro",
  // GTO / grease
  "Grease Trap Cleaning": "gto",
  "Grease Trap": "gto",
  "Hood Cleaning": "gto",
  "Filter Exchange": "filterman",
  "Filter Man": "filterman",
};

function mapServiceLines(rawLines) {
  const divisions = new Set();
  const unmapped = [];
  (rawLines || []).forEach((line) => {
    const div = SERVICE_LINE_MAP[line];
    if (div) divisions.add(div);
    else unmapped.push(line);
  });
  return { divisions: Array.from(divisions), unmapped };
}
__name(mapServiceLines, "mapServiceLines");

function sv(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === "object") {
    try { return JSON.stringify(val); } catch (e) { return String(val); }
  }
  return val;
}
__name(sv, "sv");

function normalizeForMatch(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
__name(normalizeForMatch, "normalizeForMatch");

function toDateStr(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "number") return new Date(val * 1000).toISOString().slice(0, 10);
  return String(val);
}
__name(toDateStr, "toDateStr");

// Map ST job status values to our normalized set
function normalizeJobStatus(stStatus) {
  const s = (stStatus || "").toLowerCase();
  if (s === "completed" || s === "complete") return "complete";
  if (s === "scheduled" || s === "dispatched") return "scheduled";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending_schedule";
}
__name(normalizeJobStatus, "normalizeJobStatus");

// Derive interval_days from ST's frequency/interval fields
function resolveIntervalDays(job) {
  // ST uses recurrence.interval + recurrence.unit: day/week/month/year
  const rec = job.recurrence || job.schedule || {};
  const unit = (rec.unit || rec.intervalUnit || "").toLowerCase();
  const count = rec.interval || rec.intervalCount || 1;
  if (!unit) return null;
  if (unit === "day") return count;
  if (unit === "week") return count * 7;
  if (unit === "month") return count * 30;
  if (unit === "year") return count * 365;
  return null;
}
__name(resolveIntervalDays, "resolveIntervalDays");

var ST_OAUTH_ROW_ID = "main";
var PROGRESS_ROW_ID = "main";

async function getServiceTradeAccessToken(env) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM servicetrade_oauth_state WHERE id = ?`
  ).bind(ST_OAUTH_ROW_ID).first();

  if (row && row.access_token && row.expires_at && row.expires_at > now + 60000) {
    return row.access_token;
  }

  let tokenBody;
  if (row && row.refresh_token) {
    tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.SERVICETRADE_CLIENT_ID,
      refresh_token: row.refresh_token,
    });
  } else {
    tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SERVICETRADE_CLIENT_ID,
      client_secret: env.SERVICETRADE_CLIENT_SECRET,
    });
  }

  const res = await fetch(`${ST_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Refresh token may have expired -- fall back to client_credentials
    if (row && row.refresh_token) {
      const fallback = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SERVICETRADE_CLIENT_ID,
        client_secret: env.SERVICETRADE_CLIENT_SECRET,
      });
      const res2 = await fetch(`${ST_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: fallback,
      });
      const body2 = await res2.json().catch(() => ({}));
      if (!res2.ok || !body2.access_token) {
        throw new Error("ServiceTrade OAuth2 token exchange failed (both refresh and client_credentials): " + res2.status + " " + JSON.stringify(body2).slice(0, 300));
      }
      const expiresAt2 = now + (body2.expires_in || 86400) * 1000;
      await env.DB.prepare(
        `INSERT INTO servicetrade_oauth_state (id, access_token, refresh_token, expires_at, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
      ).bind(ST_OAUTH_ROW_ID, sv(body2.access_token), sv(body2.refresh_token || null), expiresAt2, now).run();
      return body2.access_token;
    }
    throw new Error("ServiceTrade OAuth2 token exchange failed: " + res.status + " " + JSON.stringify(body).slice(0, 300));
  }

  const expiresAt = now + (body.expires_in || 86400) * 1000;
  await env.DB.prepare(
    `INSERT INTO servicetrade_oauth_state (id, access_token, refresh_token, expires_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).bind(ST_OAUTH_ROW_ID, sv(body.access_token), sv(body.refresh_token || (row && row.refresh_token) || null), expiresAt, now).run();
  return body.access_token;
}
__name(getServiceTradeAccessToken, "getServiceTradeAccessToken");

async function stGet(env, accessToken, path, params) {
  const url = new URL(ST_API_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`ServiceTrade GET ${path} failed: ${res.status}`);
  return res.json();
}
__name(stGet, "stGet");

async function getProgress(env) {
  const row = await env.DB.prepare(
    `SELECT current_page, offset_in_page, total_synced, total_updated, total_asset_errors, total_location_errors, completed_at, last_error, last_error_at FROM servicetrade_sync_progress WHERE id = ?`
  ).bind(PROGRESS_ROW_ID).first();
  if (row) return row;
  return { current_page: 1, offset_in_page: 0, total_synced: 0, total_updated: 0, total_asset_errors: 0, total_location_errors: 0, completed_at: null, last_error: null, last_error_at: null };
}
__name(getProgress, "getProgress");

async function saveProgress(env, p) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO servicetrade_sync_progress (id, current_page, offset_in_page, total_synced, total_updated, total_asset_errors, total_location_errors, last_run_at, completed_at, last_error, last_error_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET current_page=excluded.current_page, offset_in_page=excluded.offset_in_page,
       total_synced=excluded.total_synced, total_updated=excluded.total_updated,
       total_asset_errors=excluded.total_asset_errors, total_location_errors=excluded.total_location_errors,
       last_run_at=excluded.last_run_at, completed_at=excluded.completed_at,
       last_error=excluded.last_error, last_error_at=excluded.last_error_at`
  ).bind(
    PROGRESS_ROW_ID, p.current_page, p.offset_in_page, p.total_synced, p.total_updated,
    p.total_asset_errors, p.total_location_errors, now, p.completed_at || null,
    p.last_error || null, p.last_error ? now : null
  ).run();
}
__name(saveProgress, "saveProgress");

function findProp(properties, keyword) {
  if (!properties || typeof properties !== "object") return null;
  const key = Object.keys(properties).find((k) => k.toLowerCase().includes(keyword));
  return key ? properties[key] : null;
}
__name(findProp, "findProp");

// Write all job rows for a location into the jobs table, and populate
// st_services with recurring service contract data
async function syncJobsAndServices(env, authToken, acctId, stLocationId, division, log) {
  const now = Date.now();
  let page = 1, totalPages = 1;
  const allJobs = [];

  do {
    const resp = await stGet(env, authToken, "/job", { locationId: stLocationId, status: "all", page });
    const rows = (resp.data && resp.data.jobs) || [];
    totalPages = (resp.data && resp.data.totalPages) || 1;
    allJobs.push(...rows);
    page++;
  } while (page <= totalPages);

  // Write each job into the jobs table
  for (const j of allJobs) {
    const jobId = "STJ-" + j.id;
    const status = normalizeJobStatus(j.status);
    const scheduledDate = j.scheduledOn ? toDateStr(j.scheduledOn) : (j.scheduledDate || null);
    const dueDate = j.dueBy ? toDateStr(j.dueBy) : null;
    const completedAt = j.completedOn ? j.completedOn * 1000 : null;
    const serviceType = (j.type && j.type.name) || j.serviceType || j.name || null;
    const serviceLine = (j.serviceLine && j.serviceLine.name) || (j.serviceLines && j.serviceLines[0] && j.serviceLines[0].name) || null;
    const techId = j.technician ? String(j.technician.id || "") : null;
    const jobNumber = sv(j.number || j.jobNumber || null);
    const intervalDays = resolveIntervalDays(j);
    const frequency = j.recurrence ? ((j.recurrence.interval || "") + " " + (j.recurrence.unit || "")).trim() || null : null;

    try {
      await env.DB.prepare(
        `INSERT INTO jobs (id, account_id, division, service_type, service_line, tech_id, scheduled_date, due_date, status, notes, job_number, frequency, interval_days, completed_at, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           account_id=excluded.account_id, status=excluded.status,
           scheduled_date=excluded.scheduled_date, due_date=excluded.due_date,
           service_type=excluded.service_type, service_line=excluded.service_line,
           tech_id=excluded.tech_id, notes=excluded.notes, job_number=excluded.job_number,
           frequency=excluded.frequency, interval_days=excluded.interval_days,
           completed_at=excluded.completed_at, updated_at=excluded.updated_at`
      ).bind(
        jobId, acctId, sv(division), sv(serviceType), sv(serviceLine), sv(techId),
        sv(scheduledDate), sv(dueDate), status,
        sv(j.notes || j.description || null), sv(jobNumber),
        sv(frequency), intervalDays, completedAt,
        "ServiceTrade Sync", now, now
      ).run();
      log.jobsSynced = (log.jobsSynced || 0) + 1;
    } catch (e) {
      log.jobWriteErrors = (log.jobWriteErrors || 0) + 1;
    }
  }

  // Derive recurring services from jobs that have a recurrence/schedule
  // ServiceTrade doesn't have a separate /service endpoint in all account
  // tiers, but recurring jobs carry frequency info -- group by service line
  // to produce a clean service-contract summary per location
  const recurringByLine = {};
  for (const j of allJobs) {
    const intervalDays = resolveIntervalDays(j);
    if (!intervalDays) continue;
    const serviceLine = (j.serviceLine && j.serviceLine.name) || (j.serviceLines && j.serviceLines[0] && j.serviceLines[0].name) || "General";
    if (!recurringByLine[serviceLine] || (j.dueBy && (!recurringByLine[serviceLine].nextDue || j.dueBy < recurringByLine[serviceLine].nextDue))) {
      recurringByLine[serviceLine] = {
        intervalDays,
        frequency: j.recurrence ? ((j.recurrence.interval || "") + " " + (j.recurrence.unit || "")).trim() : null,
        nextDue: j.dueBy || null,
        lastCompleted: null,
        status: normalizeJobStatus(j.status),
      };
    }
    if (j.status === "completed" && j.completedOn) {
      const existing = recurringByLine[serviceLine];
      if (!existing.lastCompleted || j.completedOn > existing.lastCompleted) {
        existing.lastCompleted = j.completedOn;
      }
    }
  }

  for (const [line, data] of Object.entries(recurringByLine)) {
    const svcId = "STS-" + stLocationId + "-" + line.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30);
    try {
      await env.DB.prepare(
        `INSERT INTO st_services (id, account_id, st_location_id, service_line, frequency, interval_days, next_due, last_completed, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           frequency=excluded.frequency, interval_days=excluded.interval_days,
           next_due=excluded.next_due, last_completed=excluded.last_completed,
           status=excluded.status, updated_at=excluded.updated_at`
      ).bind(
        svcId, acctId, stLocationId, sv(line),
        sv(data.frequency), data.intervalDays,
        sv(data.nextDue ? toDateStr(data.nextDue) : null),
        sv(data.lastCompleted ? toDateStr(data.lastCompleted) : null),
        data.status, now, now
      ).run();
      log.servicesSynced = (log.servicesSynced || 0) + 1;
    } catch (e) {
      log.serviceWriteErrors = (log.serviceWriteErrors || 0) + 1;
    }
  }

  // Also update last_service and next_due on the account from the most
  // authoritative job data (same as before, kept for backward compat
  // with anything already reading those fields directly off accounts)
  const completed = allJobs.filter((j) => (j.status === "completed" || j.status === "complete") && j.completedOn);
  const upcoming = allJobs.filter((j) => !["completed","complete","cancelled","canceled"].includes(j.status) && j.dueBy);
  const lastService = completed.sort((a, b) => b.completedOn - a.completedOn)[0];
  const nextDue = upcoming.sort((a, b) => a.dueBy - b.dueBy)[0];

  if (lastService || nextDue) {
    await env.DB.prepare(
      `UPDATE accounts SET last_service=?, next_due=?, updated_at=? WHERE id=?`
    ).bind(
      sv(lastService ? toDateStr(lastService.completedOn) : null),
      sv(nextDue ? toDateStr(nextDue.dueBy) : null),
      now, acctId
    ).run();
  }
}
__name(syncJobsAndServices, "syncJobsAndServices");

async function syncAssetsAndHistory(env, authToken, acctId, stLocationId, log) {
  let page = 1, totalPages = 1;
  const assets = [];

  do {
    const resp = await stGet(env, authToken, "/asset", { locationId: stLocationId, page });
    const rows = (resp.data && resp.data.assets) || [];
    totalPages = (resp.data && resp.data.totalPages) || 1;
    assets.push(...rows);
    page++;
  } while (page <= totalPages);

  const now = Date.now();
  for (const a of assets) {
    const assetId = "STA-" + a.id;
    const props = a.properties || {};
    const locationInSite = findProp(props, "location_in_site") || a.locationInSite || "";
    const manufacturer = findProp(props, "manufacturer");
    const model = findProp(props, "model");
    const size = findProp(props, "size");
    const installDate = findProp(props, "install");
    const maintenanceDue = findProp(props, "maintenance");
    const hydroDue = findProp(props, "hydro");

    try {
      await env.DB.prepare(
        `INSERT INTO account_assets (id, account_id, external_asset_id, asset_type, description, location_in_site, service_line, manufacturer, model, size, install_date, maintenance_due_date, hydrostatic_test_due_date, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET description=excluded.description, location_in_site=excluded.location_in_site, service_line=excluded.service_line, manufacturer=excluded.manufacturer, model=excluded.model, size=excluded.size, install_date=excluded.install_date, maintenance_due_date=excluded.maintenance_due_date, hydrostatic_test_due_date=excluded.hydrostatic_test_due_date, updated_at=excluded.updated_at`
      ).bind(
        assetId, acctId, sv(String(a.id)), sv(a.type) || "", sv(a.description || a.name) || "",
        sv(locationInSite) || "", sv(a.serviceLine && a.serviceLine.name) || "",
        sv(manufacturer) || "", sv(model) || "", sv(size) || "",
        sv(toDateStr(installDate)) || "", sv(toDateStr(maintenanceDue)) || "", sv(toDateStr(hydroDue)) || "",
        now, now
      ).run();
    } catch (e) {
      log.assetWriteErrors = (log.assetWriteErrors || 0) + 1;
    }
  }
  log.assetsSynced = (log.assetsSynced || 0) + assets.length;
}
__name(syncAssetsAndHistory, "syncAssetsAndHistory");

async function syncOneLocation(env, authToken, loc, log) {
  const rawServiceLines = (loc.serviceLines || []).map((s) => s.name || s);
  const { divisions, unmapped } = mapServiceLines(rawServiceLines);
  unmapped.forEach((u) => (log.unmappedLinesSeen = log.unmappedLinesSeen || new Set()).add(u));

  const stId = String(loc.id);
  const acctId = "ST-" + stId;
  const locName = sv(loc.name) || "";
  const addr = (loc.address && typeof loc.address === "object") ? loc.address : {};
  const locStreet = sv(addr.street) || "";
  const locCity = sv(addr.city) || "";
  const locState = sv(addr.state) || "";
  const locZip = sv(addr.postalCode) || "";
  const normName = normalizeForMatch(locName);

  let existing = null;
  if (locZip) {
    const candidates = await env.DB.prepare(
      `SELECT id, name FROM accounts WHERE zip=? AND id!=?`
    ).bind(locZip, acctId).all();
    const rows = (candidates && candidates.results) || [];
    const match = rows.find((r) => normalizeForMatch(r.name) === normName);
    if (match) existing = { id: match.id };
  }
  if (!existing) {
    existing = await env.DB.prepare(`SELECT id FROM accounts WHERE id=?`).bind(acctId).first();
  }

  const now = Date.now();
  const division = divisions.length ? divisions[0] : "unipro";
  const servicesJson = JSON.stringify(divisions.length ? divisions : ["unipro"]);
  const noteLines = "ServiceTrade service lines on file: " + (rawServiceLines.join(", ") || "none listed");
  const finalAcctId = existing ? existing.id : acctId;

  if (existing) {
    await env.DB.prepare(
      `UPDATE accounts SET business=?, name=?, address=?, city=?, state=?, zip=?, phone=?, services=?, st_location_id=?, updated_at=? WHERE id=?`
    ).bind(locName, locName, locStreet, locCity, locState, locZip, sv(loc.phone) || "", servicesJson, stId, now, existing.id).run();
    log.updated = (log.updated || 0) + 1;
  } else {
    await env.DB.prepare(
      `INSERT INTO accounts (id, name, business, status, services, address, city, state, zip, phone, division, cust_num, st_location_id, source, activity_log, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      acctId, locName, locName, "active", servicesJson,
      locStreet, locCity, locState, locZip, sv(loc.phone) || "",
      division.toUpperCase() === "GTO" ? "GTO" : division.toUpperCase() === "FILTERMAN" ? "Filter Man" : "UniPro",
      stId, stId, "ServiceTrade Sync",
      JSON.stringify([{ ts: now, type: "system", icon: "\u{1F504}", title: "Synced from ServiceTrade", note: noteLines, who: "ServiceTrade Sync" }]),
      now, now
    ).run();
    log.synced = (log.synced || 0) + 1;
  }

  if (loc.primaryContact && loc.primaryContact.name) {
    const contactId = "ST-C-" + stId;
    const c = loc.primaryContact;
    await env.DB.prepare(
      `INSERT INTO contacts (id, name, company, title, email, phone, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, phone=excluded.phone, updated_at=excluded.updated_at`
    ).bind(contactId, sv(c.name) || "", locName, sv(c.title) || "", sv(c.email) || "", sv(c.phone) || "", finalAcctId, now, now).run();
  }

  try {
    await syncJobsAndServices(env, authToken, finalAcctId, stId, division, log);
  } catch (e) {
    log.jobSyncErrors = (log.jobSyncErrors || 0) + 1;
    if (log.jobSyncErrorSamples && log.jobSyncErrorSamples.length < 3) {
      log.jobSyncErrorSamples.push({ locationId: stId, error: e.message });
    }
    log.jobSyncErrorSamples = log.jobSyncErrorSamples || [];
  }

  try {
    await syncAssetsAndHistory(env, authToken, finalAcctId, stId, log);
  } catch (e) {
    log.assetSyncErrors = (log.assetSyncErrors || 0) + 1;
  }
}
__name(syncOneLocation, "syncOneLocation");

async function runOneBatch(env) {
  const authToken = await getServiceTradeAccessToken(env);
  const progress = await getProgress(env);
  let { current_page: page, offset_in_page: offset } = progress;

  const batchLog = {
    synced: 0, updated: 0,
    assetsSynced: 0, assetWriteErrors: 0, assetSyncErrors: 0,
    jobsSynced: 0, jobWriteErrors: 0, jobSyncErrors: 0, jobSyncErrorSamples: [],
    servicesSynced: 0, serviceWriteErrors: 0,
    locationSyncErrors: 0, locationSyncErrorSamples: [],
  };

  const resp = await stGet(env, authToken, "/location", { page });
  const locations = (resp.data && resp.data.locations) || [];
  const totalPages = (resp.data && resp.data.totalPages) || 1;

  if (locations.length === 0 && page > totalPages) {
    progress.completed_at = Date.now();
    await saveProgress(env, progress);
    return { done: true, batchLog, progress };
  }

  const slice = locations.slice(offset, offset + LOCATIONS_PER_BATCH);
  for (const loc of slice) {
    try {
      await syncOneLocation(env, authToken, loc, batchLog);
    } catch (e) {
      batchLog.locationSyncErrors++;
      if (batchLog.locationSyncErrorSamples.length < 5) {
        batchLog.locationSyncErrorSamples.push({ locationId: loc.id, error: e.message });
      }
    }
  }

  let nextOffset = offset + slice.length;
  let nextPage = page;
  let done = false;
  if (nextOffset >= locations.length) {
    if (page >= totalPages) { done = true; }
    else { nextPage = page + 1; nextOffset = 0; }
  }

  progress.current_page = nextPage;
  progress.offset_in_page = nextOffset;
  progress.total_synced = (progress.total_synced || 0) + (batchLog.synced || 0);
  progress.total_updated = (progress.total_updated || 0) + (batchLog.updated || 0);
  progress.total_asset_errors = (progress.total_asset_errors || 0) + (batchLog.assetSyncErrors || 0) + (batchLog.assetWriteErrors || 0);
  progress.total_location_errors = (progress.total_location_errors || 0) + (batchLog.locationSyncErrors || 0);
  progress.completed_at = done ? Date.now() : null;
  await saveProgress(env, progress);
  return { done, batchLog, progress };
}
__name(runOneBatch, "runOneBatch");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, hasCredentials: !!(env.SERVICETRADE_CLIENT_ID && env.SERVICETRADE_CLIENT_SECRET) });
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const result = await runOneBatch(env);
        return Response.json({
          ok: true, done: result.done, thisBatch: result.batchLog,
          cumulative: {
            totalSynced: result.progress.total_synced, totalUpdated: result.progress.total_updated,
            totalAssetErrors: result.progress.total_asset_errors, totalLocationErrors: result.progress.total_location_errors,
          },
          resumePosition: { page: result.progress.current_page, offsetInPage: result.progress.offset_in_page },
          message: result.done ? "Sync fully complete." : "Batch complete. Call /sync again to continue.",
        });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/sync-many" && request.method === "POST") {
      const requested = parseInt(url.searchParams.get("batches") || "20", 10);
      const batches = Math.max(1, Math.min(100, isNaN(requested) ? 20 : requested));
      const runLog = { batchesRun: 0, done: false };
      try {
        for (let i = 0; i < batches; i++) {
          const result = await runOneBatch(env);
          runLog.batchesRun++;
          runLog.progress = result.progress;
          if (result.done) { runLog.done = true; break; }
        }
        return Response.json({
          ok: true, ...runLog,
          message: runLog.done ? "Sync fully complete." : `Ran ${runLog.batchesRun} batch(es). Call /sync-many again or wait for the nightly cron.`,
        });
      } catch (e) {
        try {
          const progress = await getProgress(env);
          progress.last_error = String(e && e.message || e);
          await saveProgress(env, progress);
        } catch (_) {}
        return Response.json({ ok: false, error: e.message, ...runLog }, { status: 500 });
      }
    }

    if (url.pathname === "/sync-status") {
      const progress = await getProgress(env);
      return Response.json({ ok: true, progress });
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      // Reset the progress cursor so a full re-sync starts from page 1.
      // Existing D1 rows are preserved -- the ON CONFLICT DO UPDATE in
      // every INSERT means a full re-sync is safe to run at any time.
      await env.DB.prepare(
        `UPDATE servicetrade_sync_progress SET current_page=1, offset_in_page=0, completed_at=NULL, last_error=NULL, last_error_at=NULL WHERE id=?`
      ).bind(PROGRESS_ROW_ID).run();
      return Response.json({ ok: true, message: "Sync cursor reset to page 1. POST /sync-many to start." });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const bodyText = await request.text();
        const headersObj = {};
        request.headers.forEach((v, k) => { headersObj[k] = v; });
        await env.DB.prepare(
          `INSERT INTO servicetrade_webhook_log (id, headers, body, received_at) VALUES (?,?,?,?)`
        ).bind("WH-" + Date.now() + "-" + Math.floor(Math.random() * 10000), JSON.stringify(headersObj), bodyText, Date.now()).run();
      } catch (_) {}
      return Response.json({ ok: true });
    }

    if (url.pathname === "/webhook-peek") {
      const rows = await env.DB.prepare(
        `SELECT id, headers, body, received_at FROM servicetrade_webhook_log ORDER BY received_at DESC LIMIT 5`
      ).all();
      return Response.json({ ok: true, count: (rows.results || []).length, recent: rows.results || [] });
    }

    if (url.pathname === "/debug-job") {
      const locationId = url.searchParams.get("locationId");
      if (!locationId) return Response.json({ ok: false, error: "pass ?locationId=<ST location id>" }, { status: 400 });
      try {
        const authToken = await getServiceTradeAccessToken(env);
        const raw = await stGet(env, authToken, "/job", { locationId, status: "all", page: 1 });
        return Response.json({ ok: true, raw });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/debug-location") {
      const locationId = url.searchParams.get("locationId");
      if (!locationId) return Response.json({ ok: false, error: "pass ?locationId=<ST location id>" }, { status: 400 });
      try {
        const authToken = await getServiceTradeAccessToken(env);
        const raw = await stGet(env, authToken, "/location/" + locationId, {});
        return Response.json({ ok: true, raw });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (url.pathname === "/debug-asset") {
      const locationId = url.searchParams.get("locationId");
      if (!locationId) return Response.json({ ok: false, error: "pass ?locationId=<ST location id>" }, { status: 400 });
      try {
        const authToken = await getServiceTradeAccessToken(env);
        const raw = await stGet(env, authToken, "/asset", { locationId, page: 1 });
        return Response.json({ ok: true, raw });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    return Response.json({ ok: true, message: "servicetrade-sync -- POST /sync-many?batches=100 to run a full batch, POST /reset to restart from page 1, GET /sync-status to see progress, GET /health to verify credentials." });
  },

  async scheduled(event, env) {
    try {
      for (let i = 0; i < CRON_BATCHES_PER_RUN; i++) {
        const result = await runOneBatch(env);
        if (result.done) break;
      }
    } catch (e) {
      try {
        const progress = await getProgress(env);
        progress.last_error = String(e && e.message || e);
        await saveProgress(env, progress);
      } catch (_) {}
    }
  },
};
