/**
 * servicetrade-sync
 *
 * Pulls real account/location data out of ServiceTrade (the "Ter-pro LLC"
 * account, which per Ted's screenshots covers the UniPro family: Uni Pro,
 * Capital Fire, Quality III, GBD, GNY) and syncs it into Termac One's
 * accounts + contacts tables in D1. This is the single biggest unblock
 * for the sales-side data gap discussed all night -- reps currently have
 * zero UniPro accounts to work with in Termac One even though ~6,000+
 * real customer locations already exist in ServiceTrade.
 *
 * AUTH STATUS, 2026-07-15 (resolved and confirmed live): OAuth2
 * client_credentials against /oauth2/token, using the External System
 * Client ID/Secret pair Cathy originally set up, works -- the first real
 * token exchange succeeded on the first live /sync call tonight
 * (confirmed via a populated servicetrade_oauth_state row). The sync
 * then failed one step later, writing an account/asset row to D1, with
 * "D1_TYPE_ERROR: Type 'object' not supported for value '[object
 * Object]'". Root cause: every field pulled from ServiceTrade's real
 * response (a.type, a.manufacturer, loc.phone, etc.) was written to D1
 * with a bare `|| ''` fallback, which only catches falsy values -- an
 * object is truthy, so if ServiceTrade returns a field as a nested
 * object (e.g. {id, name}) instead of the flat string this code assumed
 * from the docs, `|| ''` does nothing and D1 rejects the raw object.
 * Since this was the very first live response ever received, there was
 * no way to know in advance which field this actually was. Fixed with
 * sv() below, which JSON-stringifies any object/array value instead of
 * crashing, applied to every field derived from ServiceTrade's response.
 * Also isolated per-location errors (try/catch around the account+
 * contact write, same pattern already used for the asset sync below it)
 * so one bad location can no longer 500 the entire sync -- it's logged
 * and skipped, and every other location still gets synced.
 *
 * ACCOUNT MAPPING PHILOSOPHY, per Ted 2026-07-14: keep ServiceTrade's
 * own service-line language visible and intact (Lexi is comfortable
 * with ServiceTrade's structure and this should not force her into an
 * unfamiliar system), while still mapping cleanly into Termac's own
 * division taxonomy underneath. Every synced account keeps the real
 * ServiceTrade service line names in its activity log for full
 * traceability back to source, not just a silently remapped category.
 */

// 2026-07-14, confirmed from ServiceTrade's own API reference (the real
// webhook creation endpoint doc Ted pasted): the actual request host is
// app.servicetrade.com, not api.servicetrade.com. This was likely the
// real root cause of "Invalid credentials provided" the whole night --
// api.servicetrade.com may resolve to something that always rejects
// auth regardless of what's sent, since we were never hitting the
// server ServiceTrade's own docs say to use.
const ST_API_BASE = 'https://app.servicetrade.com/api';

// ServiceTrade service line name -> Termac division. Built from the real
// "Provided Service Lines" checklist Ted screenshotted for this account
// (Emergency/Exit Lights, Fire Suppression, Kitchen Suppression, Portable
// Fire Extinguishers -- all under the UniPro/Quality III umbrella for
// this particular ServiceTrade account). Extend this list if a synced
// location shows a service line not covered here rather than silently
// dropping it -- see the "unmapped" bucket in mapServiceLines() below.
const SERVICE_LINE_MAP = {
  'Emergency/Exit Light Group': 'unipro',
  'Emergency/Exit Light': 'unipro',
  'Fire Suppression': 'unipro',
  'Gas Station Fire Suppression': 'unipro',
  'Kitchen Fire Suppression': 'unipro',
  'Kitchen Suppression Group': 'unipro',
  'Kitchen Suppression Cylinder': 'unipro',
  'Fire Extinguisher Group': 'unipro',
  'Portable Fire Extinguisher': 'unipro',
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

// 2026-07-15: D1 only accepts primitives (string/number/boolean/null) as
// bind values. ServiceTrade's real response shapes weren't confirmed
// ahead of time -- the docs implied flat strings for fields like
// manufacturer, size, phone, etc., but the first live sync proved at
// least one of those actually comes back as a nested object. Rather
// than guess which field and patch it one at a time as new ones turn
// up, every value pulled from a ServiceTrade response goes through this
// first: objects/arrays get JSON-stringified (so the data is preserved,
// not lost), everything else passes through as-is, null/undefined
// becomes null.
function sv(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'object') {
    try { return JSON.stringify(val); } catch (e) { return String(val); }
  }
  return val;
}

const ST_OAUTH_ROW_ID = 'main';

// 2026-07-15, confirmed from ServiceTrade Support's own "Getting Started
// with OAuth2" article, replacing the session-based /auth approach that
// turned out to be the legacy path (being retired 31 Dec 2026 anyway).
// Real flow: exchange client_id/client_secret once for an access_token
// (24hr) + refresh_token, use the access_token as a Bearer header on
// every call, and refresh with the refresh_token (no secret needed)
// once it expires. Each refresh issues a brand-new refresh_token that
// must replace the old one -- ServiceTrade's docs are explicit that
// reusing a stale refresh_token is not supported, so this persists
// state in D1 across runs rather than re-deriving it every call.
// CONFIRMED WORKING 2026-07-15: first live token exchange succeeded.
async function getServiceTradeAccessToken(env) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM servicetrade_oauth_state WHERE id = ?`
  ).bind(ST_OAUTH_ROW_ID).first();

  // Still-valid cached access token -- no network call needed at all.
  if (row && row.access_token && row.expires_at && row.expires_at > now + 60000) {
    return row.access_token;
  }

  let tokenBody;
  if (row && row.refresh_token) {
    // Refresh path -- no client_secret needed per the docs.
    tokenBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.SERVICETRADE_CLIENT_ID,
      refresh_token: row.refresh_token,
    });
  } else {
    // First-ever exchange, or refresh_token was never stored.
    tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SERVICETRADE_CLIENT_ID,
      client_secret: env.SERVICETRADE_CLIENT_SECRET,
    });
  }

  const res = await fetch(`${ST_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('ServiceTrade OAuth2 token exchange failed: ' + res.status + ' ' + JSON.stringify(body).slice(0, 300));
  }

  const expiresAt = now + ((body.expires_in || 86400) * 1000);
  await env.DB.prepare(
    `INSERT INTO servicetrade_oauth_state (id, access_token, refresh_token, expires_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).bind(ST_OAUTH_ROW_ID, sv(body.access_token), sv(body.refresh_token || (row && row.refresh_token) || null), expiresAt, now).run();

  return body.access_token;
}

async function stGet(env, accessToken, path, params) {
  const url = new URL(ST_API_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`ServiceTrade GET ${path} failed: ${res.status}`);
  return res.json();
}

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function syncAssetsAndHistory(env, authToken, acctId, stLocationId, log) {
  let page = 1, totalPages = 1;
  const assets = [];
  do {
    const resp = await stGet(env, authToken, '/asset', { locationId: stLocationId, page });
    const rows = (resp.data && resp.data.assets) || [];
    totalPages = (resp.data && resp.data.totalPages) || 1;
    assets.push(...rows);
    page++;
  } while (page <= totalPages);

  const now = Date.now();
  for (const a of assets) {
    const assetId = 'STA-' + a.id;
    try {
      await env.DB.prepare(
        `INSERT INTO account_assets (id, account_id, external_asset_id, asset_type, description, location_in_site, service_line, manufacturer, model, size, install_date, maintenance_due_date, hydrostatic_test_due_date, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET description=excluded.description, maintenance_due_date=excluded.maintenance_due_date, hydrostatic_test_due_date=excluded.hydrostatic_test_due_date, updated_at=excluded.updated_at`
      ).bind(
        assetId, acctId, sv(String(a.id)), sv(a.type) || '', sv(a.description || a.name) || '',
        sv(a.locationInSite) || '', sv(a.serviceLine && a.serviceLine.name) || '',
        sv(a.manufacturer) || '', sv(a.model) || '', sv(a.size) || '',
        sv(a.installDate) || '', sv(a.maintenanceDueDate) || '', sv(a.hydrostaticTestDueDate) || '',
        now, now
      ).run();
    } catch (e) {
      log.assetWriteErrors = (log.assetWriteErrors || 0) + 1;
    }
  }
  log.assetsSynced = (log.assetsSynced || 0) + assets.length;

  const jobsResp = await stGet(env, authToken, '/job', { locationId: stLocationId, page: 1 });
  const jobs = (jobsResp.data && jobsResp.data.jobs) || [];
  const completed = jobs.filter((j) => j.status === 'completed' && j.completedOn);
  const upcoming = jobs.filter((j) => j.status !== 'completed' && j.scheduledDate);
  const lastService = completed.sort((a, b) => new Date(b.completedOn) - new Date(a.completedOn))[0];
  const nextDue = upcoming.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))[0];

  if (lastService || nextDue) {
    await env.DB.prepare(
      `UPDATE accounts SET last_service = ?, next_due = ?, updated_at = ? WHERE id = ?`
    ).bind(
      sv(lastService ? lastService.completedOn : null),
      sv(nextDue ? nextDue.scheduledDate : null),
      now, acctId
    ).run();
  }
}

async function syncLocations(env, log) {
  const authToken = await getServiceTradeAccessToken(env);
  let page = 1;
  let totalPages = 1;
  let synced = 0;
  let skipped = 0;
  const unmappedLinesSeen = new Set();

  do {
    const resp = await stGet(env, authToken, '/location', { page });
    const locations = (resp.data && resp.data.locations) || [];
    totalPages = (resp.data && resp.data.totalPages) || 1;

    for (const loc of locations) {
      try {
        const rawServiceLines = (loc.serviceLines || []).map((s) => s.name || s);
        const { divisions, unmapped } = mapServiceLines(rawServiceLines);
        unmapped.forEach((u) => unmappedLinesSeen.add(u));

        const stId = String(loc.id);
        const acctId = 'ST-' + stId;
        const locName = sv(loc.name) || '';
        const locAddress = sv(loc.address) || '';

        const existing = await env.DB.prepare(
          `SELECT id FROM accounts WHERE id = ? OR (business = ? AND address = ?)`
        ).bind(acctId, locName, locAddress).first();

        const now = Date.now();
        const servicesJson = JSON.stringify(divisions.length ? divisions : ['unipro']);
        const noteLines = 'ServiceTrade service lines on file: ' + (rawServiceLines.join(', ') || 'none listed');
        const finalAcctId = existing ? existing.id : acctId;

        if (existing) {
          await env.DB.prepare(
            `UPDATE accounts SET business = ?, name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, services = ?, updated_at = ? WHERE id = ?`
          ).bind(locName, locName, locAddress, sv(loc.city) || '', sv(loc.state) || '', sv(loc.zip) || '', sv(loc.phone) || '', servicesJson, now, existing.id).run();
          skipped++;
        } else {
          await env.DB.prepare(
            `INSERT INTO accounts (id, name, business, status, services, address, city, state, zip, phone, division, cust_num, source, activity_log, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            acctId, locName, locName, 'active', servicesJson,
            locAddress, sv(loc.city) || '', sv(loc.state) || '', sv(loc.zip) || '', sv(loc.phone) || '',
            'UniPro', stId, 'ServiceTrade Sync',
            JSON.stringify([{ ts: now, type: 'system', icon: '🔄', title: 'Synced from ServiceTrade', note: noteLines, who: 'ServiceTrade Sync' }]),
            now, now
          ).run();
          synced++;
        }

        if (loc.primaryContact && loc.primaryContact.name) {
          const contactId = 'ST-C-' + stId;
          const c = loc.primaryContact;
          await env.DB.prepare(
            `INSERT INTO contacts (id, name, company, title, email, phone, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, phone=excluded.phone, updated_at=excluded.updated_at`
          ).bind(contactId, sv(c.name) || '', locName, sv(c.title) || '', sv(c.email) || '', sv(c.phone) || '', acctId, now, now).run();
        }

        try {
          await syncAssetsAndHistory(env, authToken, finalAcctId, stId, log);
        } catch (e) {
          log.assetSyncErrors = (log.assetSyncErrors || 0) + 1;
        }
      } catch (e) {
        // 2026-07-15: a single location with an unexpected field shape
        // (the D1_TYPE_ERROR class of bug) used to 500 the entire sync,
        // losing every location after it in the same page. Now it's
        // logged and skipped -- every other location still gets synced,
        // and the response tells Ted exactly how many locations hit
        // this so it's visible, not silently swallowed.
        log.locationSyncErrors = (log.locationSyncErrors || 0) + 1;
        log.locationSyncErrorSamples = log.locationSyncErrorSamples || [];
        if (log.locationSyncErrorSamples.length < 5) {
          log.locationSyncErrorSamples.push({ locationId: loc.id, error: e.message });
        }
      }
    }
    page++;
  } while (page <= totalPages);

  log.synced = synced;
  log.updated = skipped;
  log.unmappedServiceLines = Array.from(unmappedLinesSeen);
  return log;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, hasCredentials: !!(env.SERVICETRADE_CLIENT_ID && env.SERVICETRADE_CLIENT_SECRET) });
    }
    if (url.pathname === '/sync' && request.method === 'POST') {
      const log = {};
      try {
        await syncLocations(env, log);
        return Response.json({ ok: true, ...log });
      } catch (e) {
        return Response.json({ ok: false, error: e.message, ...log }, { status: 500 });
      }
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const bodyText = await request.text();
        const headersObj = {};
        request.headers.forEach((v, k) => { headersObj[k] = v; });
        await env.DB.prepare(
          `INSERT INTO servicetrade_webhook_log (id, headers, body, received_at) VALUES (?,?,?,?)`
        ).bind('WH-' + Date.now() + '-' + Math.floor(Math.random() * 10000), JSON.stringify(headersObj), bodyText, Date.now()).run();
      } catch (e) { /* never fail the webhook ack, even if logging breaks */ }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/webhook-peek') {
      const rows = await env.DB.prepare(
        `SELECT id, headers, body, received_at FROM servicetrade_webhook_log ORDER BY received_at DESC LIMIT 5`
      ).all();
      return Response.json({ ok: true, count: (rows.results || []).length, recent: rows.results || [] });
    }
    return Response.json({ ok: true, message: 'servicetrade-sync -- POST /sync to run, GET /health to check credentials, POST /webhook to receive ServiceTrade events, GET /webhook-peek to view captured ones' });
  },

  async scheduled(event, env) {
    const log = {};
    try {
      await syncLocations(env, log);
    } catch (e) {
      // Swallow here -- a failed scheduled run shouldn't crash the cron,
      // but /health and manual /sync calls will surface the same error
      // for debugging.
    }
  },
};
