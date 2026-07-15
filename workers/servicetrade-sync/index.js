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
 * Client ID/Secret pair Cathy originally set up, works and is confirmed
 * live -- a real token exchange succeeded on the first live /sync call.
 *
 * DATA-SHAPE FIX, 2026-07-15 (resolved and confirmed live): the first
 * real sync crashed with "D1_TYPE_ERROR: Type 'object' not supported"
 * because at least one field ServiceTrade actually returns is a nested
 * object where the docs implied a flat string. sv() below JSON-
 * stringifies any object/array value instead of crashing, applied to
 * every field pulled from a ServiceTrade response. Per-location and
 * per-asset writes are also individually try/caught now, so one bad
 * record can't take down the whole run.
 *
 * BATCHING, 2026-07-15 (this fix): the second real sync attempt, after
 * the data-shape fix, got real results (45 assets synced, 7 asset
 * errors safely caught) but then hit Cloudflare's own per-invocation
 * subrequest ceiling ("Too many subrequests by single Worker
 * invocation") -- Workers on the Free plan cap out at 50 external
 * fetch() calls per invocation, and a location plus its assets plus its
 * job history is 2-3 external calls each, so a single invocation could
 * only ever get partway into the first page of ~6,000+ locations no
 * matter what. Fixed by batching: each /sync call now processes a
 * bounded number of locations (LOCATIONS_PER_BATCH) and persists exactly
 * where it left off in servicetrade_sync_progress (D1 table, not
 * localStorage, per standing platform rule), so calling /sync again
 * picks up right where the last call stopped instead of restarting from
 * scratch or blowing the same ceiling again. This works regardless of
 * which Cloudflare plan the account is on -- if it turns out to be on
 * Workers Paid ($5/mo, 10,000 external subrequests per invocation by
 * default as of Cloudflare's Feb 2026 change), batching just means each
 * call finishes faster than the ceiling allows; if it's on Free, this is
 * what makes the sync completable at all. The nightly cron below now
 * runs a small chained loop of batches (see runBatchedSync) rather than
 * one unbounded call, so it makes steady progress on its own without
 * needing every night's run to be manually triggered.
 *
 * ACCOUNT MAPPING PHILOSOPHY, per Ted 2026-07-14: keep ServiceTrade's
 * own service-line language visible and intact (Lexi is comfortable
 * with ServiceTrade's structure and this should not force her into an
 * unfamiliar system), while still mapping cleanly into Termac's own
 * division taxonomy underneath. Every synced account keeps the real
 * ServiceTrade service line names in its activity log for full
 * traceability back to source, not just a silently remapped category.
 */

const ST_API_BASE = 'https://app.servicetrade.com/api';

// 2026-07-15, updated after Ted upgraded the termac-one Cloudflare
// account to Workers Paid: the per-invocation external-subrequest
// ceiling jumps from 50 (Free) to 10,000 by default. Each location
// costs roughly 2-3 external calls (asset pull, possible extra asset
// pagination, job pull), plus 1 call for the location page itself.
// 300 locations/batch keeps total external calls (~600-900) comfortably
// under the new ceiling with real margin, while cutting a full sync of
// ~6,000 locations down to roughly 20 manual /sync calls instead of
// ~500. If the account ever drops back to Free, this would need to
// come back down to ~12.
const LOCATIONS_PER_BATCH = 300;

// 2026-07-15, bumped after confirming several live batches ran clean
// (zero errors, ~10 locations per ServiceTrade page regardless of how
// high LOCATIONS_PER_BATCH is set -- the real page size is controlled
// by ServiceTrade's own API, not by us). At ~10 locations/call, 100
// chained batches per night covers roughly 1,000 locations, working
// through the full ~6,000-location list in well under a week
// automatically, with no manual /sync clicking required.
const CRON_BATCHES_PER_RUN = 100;

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

// D1 only accepts primitives as bind values. See DATA-SHAPE FIX note
// above -- objects/arrays get JSON-stringified instead of crashing.
function sv(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'object') {
    try { return JSON.stringify(val); } catch (e) { return String(val); }
  }
  return val;
}

// 2026-07-15: same normalization used for the GTO/FilterMan/UniPro CSV
// import -- uppercase, strip everything but letters/digits, collapse
// whitespace. Used to catch "XYZ CAFE" vs "XYZ Cafe LLC" as the same
// business when they share a zip, instead of the old exact-string
// comparison that let real duplicates straight through.
function normalizeForMatch(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

const ST_OAUTH_ROW_ID = 'main';
const PROGRESS_ROW_ID = 'main';

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
      grant_type: 'refresh_token',
      client_id: env.SERVICETRADE_CLIENT_ID,
      refresh_token: row.refresh_token,
    });
  } else {
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

async function getProgress(env) {
  const row = await env.DB.prepare(
    `SELECT current_page, offset_in_page, total_synced, total_updated, total_asset_errors, total_location_errors, completed_at FROM servicetrade_sync_progress WHERE id = ?`
  ).bind(PROGRESS_ROW_ID).first();
  if (row) return row;
  return { current_page: 1, offset_in_page: 0, total_synced: 0, total_updated: 0, total_asset_errors: 0, total_location_errors: 0, completed_at: null };
}

async function saveProgress(env, p) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO servicetrade_sync_progress (id, current_page, offset_in_page, total_synced, total_updated, total_asset_errors, total_location_errors, last_run_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET current_page=excluded.current_page, offset_in_page=excluded.offset_in_page,
       total_synced=excluded.total_synced, total_updated=excluded.total_updated,
       total_asset_errors=excluded.total_asset_errors, total_location_errors=excluded.total_location_errors,
       last_run_at=excluded.last_run_at, completed_at=excluded.completed_at`
  ).bind(
    PROGRESS_ROW_ID, p.current_page, p.offset_in_page, p.total_synced, p.total_updated,
    p.total_asset_errors, p.total_location_errors, now, p.completed_at || null
  ).run();
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

async function syncOneLocation(env, authToken, loc, log) {
  const rawServiceLines = (loc.serviceLines || []).map((s) => s.name || s);
  const { divisions, unmapped } = mapServiceLines(rawServiceLines);
  unmapped.forEach((u) => (log.unmappedLinesSeen = log.unmappedLinesSeen || new Set()).add(u));

  const stId = String(loc.id);
  const acctId = 'ST-' + stId;
  const locName = sv(loc.name) || '';

  // 2026-07-15 FIX: loc.address is a real structured object from
  // ServiceTrade (street/city/state/postalCode), not a flat string like
  // originally assumed. The first live sync stored the whole object as
  // one garbled JSON blob in `address` and left city/state/zip empty,
  // since it was reading those as separate top-level fields that don't
  // exist on the real response. 40 accounts synced before this fix were
  // repaired directly in D1; this unpacks it properly going forward.
  const addr = (loc.address && typeof loc.address === 'object') ? loc.address : {};
  const locStreet = sv(addr.street) || '';
  const locCity = sv(addr.city) || '';
  const locState = sv(addr.state) || '';
  const locZip = sv(addr.postalCode) || '';

  // 2026-07-15 FIX: matching used to be an exact string comparison on
  // business name + the (broken) address blob, which almost never
  // caught real duplicates -- "XYZ CAFE" vs "XYZ Cafe LLC" at the
  // identical address sailed past each other as different accounts.
  // Now pulls every existing account at the same zip (cheap, zip is
  // indexed-cardinality small even in dense areas) and compares names
  // normalized the same way the GTO/FilterMan/UniPro CSV import does --
  // uppercase, strip punctuation -- catching the same class of near-
  // duplicate that a pure exact match misses.
  const normName = normalizeForMatch(locName);
  let existing = null;
  if (locZip) {
    const candidates = await env.DB.prepare(
      `SELECT id, name FROM accounts WHERE zip = ? AND id != ?`
    ).bind(locZip, acctId).all();
    const rows = (candidates && candidates.results) || [];
    const match = rows.find((r) => normalizeForMatch(r.name) === normName);
    if (match) existing = { id: match.id };
  }
  if (!existing) {
    existing = await env.DB.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(acctId).first();
  }

  const now = Date.now();
  const servicesJson = JSON.stringify(divisions.length ? divisions : ['unipro']);
  const noteLines = 'ServiceTrade service lines on file: ' + (rawServiceLines.join(', ') || 'none listed');
  const finalAcctId = existing ? existing.id : acctId;

  if (existing) {
    await env.DB.prepare(
      `UPDATE accounts SET business = ?, name = ?, address = ?, city = ?, state = ?, zip = ?, phone = ?, services = ?, updated_at = ? WHERE id = ?`
    ).bind(locName, locName, locStreet, locCity, locState, locZip, sv(loc.phone) || '', servicesJson, now, existing.id).run();
    log.updated = (log.updated || 0) + 1;
  } else {
    await env.DB.prepare(
      `INSERT INTO accounts (id, name, business, status, services, address, city, state, zip, phone, division, cust_num, source, activity_log, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      acctId, locName, locName, 'active', servicesJson,
      locStreet, locCity, locState, locZip, sv(loc.phone) || '',
      'UniPro', stId, 'ServiceTrade Sync',
      JSON.stringify([{ ts: now, type: 'system', icon: '🔄', title: 'Synced from ServiceTrade', note: noteLines, who: 'ServiceTrade Sync' }]),
      now, now
    ).run();
    log.synced = (log.synced || 0) + 1;
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
}

// Processes one bounded batch (LOCATIONS_PER_BATCH locations) starting
// from wherever servicetrade_sync_progress left off, then saves the new
// position. Returns { done, batchLog, cumulativeTotals }.
async function runOneBatch(env) {
  const authToken = await getServiceTradeAccessToken(env);
  const progress = await getProgress(env);
  let { current_page: page, offset_in_page: offset } = progress;

  const batchLog = { synced: 0, updated: 0, assetsSynced: 0, assetWriteErrors: 0, assetSyncErrors: 0, locationSyncErrors: 0, locationSyncErrorSamples: [] };

  const resp = await stGet(env, authToken, '/location', { page });
  const locations = (resp.data && resp.data.locations) || [];
  const totalPages = (resp.data && resp.data.totalPages) || 1;

  if (locations.length === 0 && page > totalPages) {
    // Nothing left at all -- fully done.
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
    // Finished this page. Move to the next one, or finish entirely.
    if (page >= totalPages) {
      done = true;
    } else {
      nextPage = page + 1;
      nextOffset = 0;
    }
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, hasCredentials: !!(env.SERVICETRADE_CLIENT_ID && env.SERVICETRADE_CLIENT_SECRET) });
    }
    // Single bounded batch per call -- call this repeatedly to work
    // through the full location list. Response tells you exactly where
    // it left off and whether it's done.
    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        const result = await runOneBatch(env);
        return Response.json({
          ok: true,
          done: result.done,
          thisBatch: result.batchLog,
          cumulative: {
            totalSynced: result.progress.total_synced,
            totalUpdated: result.progress.total_updated,
            totalAssetErrors: result.progress.total_asset_errors,
            totalLocationErrors: result.progress.total_location_errors,
          },
          resumePosition: { page: result.progress.current_page, offsetInPage: result.progress.offset_in_page },
          message: result.done ? 'Sync fully complete.' : 'Batch complete. Call /sync again to continue from where this left off.',
        });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }
    if (url.pathname === '/sync-status') {
      const progress = await getProgress(env);
      return Response.json({ ok: true, progress });
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
    // 2026-07-15 TEMPORARY diagnostic, per Ted: last_service/next_due are
    // showing null on every single synced account, which isn't plausible
    // for real active accounts. Same root-cause class as the address bug
    // -- the /job field names assumed from docs (status/completedOn/
    // scheduledDate) may not match ServiceTrade's real response, same as
    // address turned out to be a nested object instead of a flat string.
    // Returns the RAW, unmodified /job response for one real location so
    // the actual field names can be seen directly instead of guessed at
    // a second time. Remove this route once the /job parsing is fixed.
    if (url.pathname === '/debug-job') {
      const locationId = url.searchParams.get('locationId');
      const companyId = url.searchParams.get('companyId');
      if (!locationId) return Response.json({ ok: false, error: 'pass ?locationId=<a real ServiceTrade location id>, optionally &companyId=<company id too>' }, { status: 400 });
      try {
        const authToken = await getServiceTradeAccessToken(env);
        // 2026-07-15: testing several hypotheses in one call instead of
        // one slow guess-and-redeploy cycle per idea. Ted confirmed via
        // the real ServiceTrade UI that this exact location has 4 real
        // jobs, but a plain locationId query came back completely empty
        // -- correctly shaped, zero rows. Trying: the same query as
        // before (control), the location's companyId instead, an
        // explicit status=all in case a default filter is hiding
        // history, and locationId as a repeated/array-style param in
        // case the API expects that shape for a single filter value.
        const attempts = {};
        try { attempts.plain_locationId = await stGet(env, authToken, '/job', { locationId, page: 1 }); }
        catch (e) { attempts.plain_locationId = { error: e.message }; }

        try { attempts.locationId_status_all = await stGet(env, authToken, '/job', { locationId, status: 'all', page: 1 }); }
        catch (e) { attempts.locationId_status_all = { error: e.message }; }

        if (companyId) {
          try { attempts.companyId = await stGet(env, authToken, '/job', { companyId, page: 1 }); }
          catch (e) { attempts.companyId = { error: e.message }; }
        }

        try {
          const u = new URL(ST_API_BASE + '/job');
          u.searchParams.append('locationId[]', locationId);
          u.searchParams.set('page', '1');
          const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${authToken}` } });
          attempts.locationId_array_syntax = res.ok ? await res.json() : { httpStatus: res.status };
        } catch (e) { attempts.locationId_array_syntax = { error: e.message }; }

        return Response.json({ ok: true, attempts });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }
    // 2026-07-15 TEMPORARY diagnostic, per Ted: /job returns a correctly-
    // shaped but completely EMPTY result for a location confirmed (via
    // screenshots of the real ServiceTrade UI) to have 4 real jobs. Since
    // the response shape itself is right, this isn't a field-parsing bug
    // like address was -- it's a scoping mismatch. ServiceTrade's own
    // docs show a location can carry both a modern `id` and a separate
    // `legacyId` (see the /appointment example in their API reference).
    // This pulls the raw /location/<id> object directly to check whether
    // that's what's happening here before guessing at a second fix.
    if (url.pathname === '/debug-location') {
      const locationId = url.searchParams.get('locationId');
      if (!locationId) return Response.json({ ok: false, error: 'pass ?locationId=<a real ServiceTrade location id>' }, { status: 400 });
      try {
        const authToken = await getServiceTradeAccessToken(env);
        const raw = await stGet(env, authToken, '/location/' + locationId, {});
        return Response.json({ ok: true, raw });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }
    return Response.json({ ok: true, message: 'servicetrade-sync -- POST /sync to run one batch, GET /sync-status to see progress, GET /health to check credentials, POST /webhook to receive ServiceTrade events, GET /webhook-peek to view captured ones' });
  },

  // Nightly cron: chains a few batches together so real progress happens
  // on its own without Ted needing to trigger every batch by hand. Each
  // batch is still fully bounded and independent -- if one throws, the
  // loop just stops for the night and picks back up tomorrow from the
  // saved cursor, nothing is lost or re-done.
  async scheduled(event, env) {
    try {
      for (let i = 0; i < CRON_BATCHES_PER_RUN; i++) {
        const result = await runOneBatch(env);
        if (result.done) break;
      }
    } catch (e) {
      // Swallow -- a failed scheduled run shouldn't crash the cron, next
      // night picks up from the last saved cursor.
    }
  },
};
