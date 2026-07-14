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
 * HONEST STATUS, 2026-07-14: everything in this file except the token
 * exchange itself is built against ServiceTrade's confirmed, documented
 * API contract (base URL, response envelope, pagination, rate limits --
 * verified from api.servicetrade.com/api/docs). The ONE piece that is
 * NOT independently confirmed is the exact token endpoint/shape for the
 * Client ID + Client Secret pair generated via ServiceTrade's own
 * "Add an External System" flow. ServiceTrade's core public docs show
 * username/password login (POST /auth), but the External System
 * credential flow used here is part of their fuller API reference, which
 * requires a logged-in ServiceTrade account to view -- something Ted has
 * and I don't. getServiceTradeToken() below implements the standard
 * OAuth2 client_credentials shape as the best-grounded guess, but this
 * is the one call that needs a live test before this is trusted for real
 * syncing. If it 401s or 404s, the fix is almost certainly just the
 * token endpoint path or the parameter names, not the overall approach.
 * Do not treat this comment as resolved until it's been tested against
 * a real response.
 *
 * ACCOUNT MAPPING PHILOSOPHY, per Ted 2026-07-14: keep ServiceTrade's
 * own service-line language visible and intact (Lexi is comfortable
 * with ServiceTrade's structure and this should not force her into an
 * unfamiliar system), while still mapping cleanly into Termac's own
 * division taxonomy underneath. Every synced account keeps the real
 * ServiceTrade service line names in its activity log for full
 * traceability back to source, not just a silently remapped category.
 */

const ST_API_BASE = 'https://api.servicetrade.com/api';

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

async function getServiceTradeToken(env) {
  // See the HONEST STATUS note at the top of this file -- this is the
  // one call in the whole sync that still needs a live confirmation.
  const res = await fetch(`${ST_API_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.SERVICETRADE_CLIENT_ID,
      client_secret: env.SERVICETRADE_CLIENT_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !(body.data && body.data.authToken) && !body.authToken) {
    throw new Error('ServiceTrade auth failed: ' + res.status + ' ' + JSON.stringify(body).slice(0, 300));
  }
  return (body.data && body.data.authToken) || body.authToken;
}

async function stGet(env, authToken, path, params) {
  const url = new URL(ST_API_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Cookie: `PHPSESSID=${authToken}` },
  });
  if (!res.ok) throw new Error(`ServiceTrade GET ${path} failed: ${res.status}`);
  return res.json();
}

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function syncAssetsAndHistory(env, authToken, acctId, stLocationId, log) {
  // Assets: mirrors ServiceTrade's own asset structure directly, per Ted
  // -- same field names/shape as what's on their Assets tab (asset type,
  // location in site, manufacturer, install date, maintenance/hydro due
  // dates), not a re-invented schema. locationId as a filter param
  // follows the same convention confirmed for /job in ServiceTrade's own
  // Python SDK docs; not independently re-verified for /asset the same
  // way the /location and /job endpoints were, worth confirming on the
  // first live run same as the auth call.
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
    await env.DB.prepare(
      `INSERT INTO account_assets (id, account_id, external_asset_id, asset_type, description, location_in_site, service_line, manufacturer, model, size, install_date, maintenance_due_date, hydrostatic_test_due_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET description=excluded.description, maintenance_due_date=excluded.maintenance_due_date, hydrostatic_test_due_date=excluded.hydrostatic_test_due_date, updated_at=excluded.updated_at`
    ).bind(
      assetId, acctId, String(a.id), a.type || '', a.description || a.name || '',
      a.locationInSite || '', (a.serviceLine && a.serviceLine.name) || '',
      a.manufacturer || '', a.model || '', a.size || '',
      a.installDate || '', a.maintenanceDueDate || '', a.hydrostaticTestDueDate || '',
      now, now
    ).run();
  }
  log.assetsSynced = (log.assetsSynced || 0) + assets.length;

  // Recent job/service history: gives a real last_service date, and the
  // earliest upcoming due date across all jobs becomes next_due on the
  // account itself -- this is what makes a service-due reminder show up
  // as a real, dated item on a rep's agenda, the same way a scheduled
  // appointment or a follow-up already does, not a generic suggestion.
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
      lastService ? lastService.completedOn : null,
      nextDue ? nextDue.scheduledDate : null,
      now, acctId
    ).run();
  }
}

async function syncLocations(env, log) {
  const authToken = await getServiceTradeToken(env);
  let page = 1;
  let totalPages = 1;
  let synced = 0;
  let skipped = 0;
  const unmappedLinesSeen = new Set();

  do {
    // "location" is ServiceTrade's real term for a customer site -- this
    // is the resource that maps most directly onto a Termac "account".
    const resp = await stGet(env, authToken, '/location', { page });
    const locations = (resp.data && resp.data.locations) || [];
    totalPages = (resp.data && resp.data.totalPages) || 1;

    for (const loc of locations) {
      const rawServiceLines = (loc.serviceLines || []).map((s) => s.name || s);
      const { divisions, unmapped } = mapServiceLines(rawServiceLines);
      unmapped.forEach((u) => unmappedLinesSeen.add(u));

      const stId = String(loc.id);
      const acctId = 'ST-' + stId;

      // Standing cross-division dedup rule: check by ServiceTrade source
      // id first (idempotent re-sync), then by name+address before
      // inserting a new row, same rule every other import this session
      // followed.
      const existing = await env.DB.prepare(
        `SELECT id FROM accounts WHERE id = ? OR (business = ? AND address = ?)`
      ).bind(acctId, loc.name || '', loc.address || '').first();

      const now = Date.now();
      const servicesJson = JSON.stringify(divisions.length ? divisions : ['unipro']);
      const noteLines = 'ServiceTrade service lines on file: ' + (rawServiceLines.join(', ') || 'none listed');
      const finalAcctId = existing ? existing.id : acctId;

      if (existing) {
        await env.DB.prepare(
          `UPDATE accounts SET business = ?, name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, services = ?, updated_at = ? WHERE id = ?`
        ).bind(loc.name || '', loc.name || '', loc.address || '', loc.city || '', loc.state || '', loc.zip || '', loc.phone || '', servicesJson, now, existing.id).run();
        skipped++;
      } else {
        await env.DB.prepare(
          `INSERT INTO accounts (id, name, business, status, services, address, city, state, zip, phone, division, cust_num, source, activity_log, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          acctId, loc.name || '', loc.name || '', 'active', servicesJson,
          loc.address || '', loc.city || '', loc.state || '', loc.zip || '', loc.phone || '',
          'UniPro', stId, 'ServiceTrade Sync',
          JSON.stringify([{ ts: now, type: 'system', icon: '🔄', title: 'Synced from ServiceTrade', note: noteLines, who: 'ServiceTrade Sync' }]),
          now, now
        ).run();
        synced++;
      }

      // Primary contact, if ServiceTrade returned one on the location.
      if (loc.primaryContact && loc.primaryContact.name) {
        const contactId = 'ST-C-' + stId;
        const c = loc.primaryContact;
        await env.DB.prepare(
          `INSERT INTO contacts (id, name, company, title, email, phone, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, phone=excluded.phone, updated_at=excluded.updated_at`
        ).bind(contactId, c.name || '', loc.name || '', c.title || '', c.email || '', c.phone || '', acctId, now, now).run();
      }

      // Assets + service history, added same night per Ted -- pulled
      // per-location right after the account itself is synced/updated,
      // using whichever account id this location actually landed on
      // (the existing one on a re-sync, the freshly created one
      // otherwise).
      try {
        await syncAssetsAndHistory(env, authToken, finalAcctId, stId, log);
      } catch (e) {
        // A failed asset pull for one location shouldn't stop the whole
        // sync -- the account itself is already saved either way.
        log.assetSyncErrors = (log.assetSyncErrors || 0) + 1;
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
    return Response.json({ ok: true, message: 'servicetrade-sync -- POST /sync to run, GET /health to check credentials' });
  },

  // Nightly sync, same 1am ET cron slot pattern the rest of the platform
  // already uses.
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
