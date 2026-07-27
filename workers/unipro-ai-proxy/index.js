/**
 * unipro-ai-proxy — Termac One
 * Routes:
 *   POST /          — Anthropic API proxy (AI features)
 *   GET/POST/PUT/DELETE /db/:table[/:id] — D1 CRM database API
 *   POST /db/query  — raw SELECT
 *   GET  /campaign/unsubscribe — public unsubscribe link used in drip campaign emails
 */

const ALLOWED_ORIGINS = [
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
  'https://sales.mytermac.com',
  'https://coachted-retro.github.io',
];

const ALLOWED_TABLES = new Set([
  'users','companies','locations','accounts','contacts',
  'leads','opportunities','bids','jobs','deficiencies',
  'collections','scheduler_queue','activity_log',
  'notifications','messages','rep_cards','warehouse_inventory','dms_coldcall',
  // AllPro Project Planner rebuild, added 2026-07-09
  'allpro_projects','allpro_milestones','allpro_quotes','allpro_quote_lines',
  'allpro_hood_pricing','allpro_fan_pricing','allpro_hood_designer',
  'allpro_permits','allpro_bid_lines','allpro_parts_catalog',
  'townships','quality_complaints','rep_schedule',
  // localStorage-only audit fix, added 2026-07-10
  'appointments',
  // AllPro reconciliation, added 2026-07-10
  'allpro_design_projects',
  // localStorage-only audit, added 2026-07-10
  'broadcasts', 'dispatch_msgs', 'wh_requisitions', 'wh_ready_handoffs', 'parts_requests',
  'transfer_requests', 'hr_data', 'allpro_spiffs',
  // Fixed 2026-07-11 - allpro_cost_lines was already in the client's
  // D1_SYNC_TABLES list (termac-d1-sync.js) and being pushed to/read
  // from constantly by the AllPro Costing tab and Financials dashboard,
  // but was never added here - every request for it 400'd silently.
  'allpro_cost_lines',
  // Delete-propagation fix, added 2026-07-11 - local-first sync only ever
  // added new records found in D1, never removed ones deleted server-side,
  // so a deletion never actually reached other devices. Tombstones close
  // that gap: crmDelete writes one here alongside the real DELETE, and
  // hydration checks this table to purge matching local records too.
  'crm_tombstones',
  // Daily digest, added 2026-07-11 - written by the cron trigger below,
  // read by the client on Home to show what the scheduled job prepared.
  'daily_digests',
  // Real per-rep call/visit targets, added 2026-07-11 - the cron job has
  // no access to localStorage at all, so this closes the gap that made
  // the digest fall back to defaults instead of each rep's real targets.
  'rep_targets',
  // Pitch Tool vs Quick Sale usage tracking, added 2026-07-16 per Ted --
  // logs a lightweight event each time a rep launches either path, so
  // the Manager Dashboard can show whether someone's leaning on Quick
  // Sale as a full-time shortcut instead of presenting the full
  // cross-sell pitch.
  'rep_tool_usage',
  // Division GM Dashboards, added 2026-07-12 - manual monthly P&L
  // actuals entry for divisions without a live NetSuite/Adagio feed yet.
  'division_actuals',
  // Trade Partner Network, added 2026-07-12 - cross-division database of
  // subcontractors, fire-protection vendors who sub work to Termac, and
  // general contractors used for bid work. Shared by every division, not
  // scoped to AllPro.
  'trade_partners','trade_partner_referrals','trade_partner_bids',
  // AllPro Toolbox, added 2026-07-12 - editable reference library and
  // material/labor rate tables backing the calculators on the AllPro
  // Project Planner's left toolbar.
  'reference_library','allpro_rate_tables',
  // Accounts Payable, added 2026-07-13 - fixing a real localStorage-only
  // bug found during a platform-wide audit. See accounts-payable-schema.sql.
  'accounts_payable',
  // Expense Reports, added 2026-07-13 - same class of bug. See
  // expense-reports-schema.sql.
  'expense_reports',
  // Customer Orders, added 2026-07-13 - same class of bug. See
  // customer-orders-schema.sql.
  'customer_orders',
  // Reorder Requests, added 2026-07-13 - storage layer fix only, see
  // reorder-requests-schema.sql for the note on missing consumer UI.
  'reorder_requests',
  // Warehouse Alerts, added 2026-07-13 - fixes a broken cross-device
  // warehouse/tech parts-staging confirmation workflow. See
  // warehouse-alerts-schema.sql.
  'warehouse_alerts',
  // Growth & Opportunity Intelligence panel + Bid Pipeline Watchlist tab,
  // added 2026-07-12. growth_snapshots is written on a schedule (piggybacks
  // the existing daily digest cron) to build a real forward-looking trend
  // instead of a fabricated one. bid_watchlist tracks known recurring public
  // bids (e.g. SEPTA fire extinguisher maintenance) between live-scraper hits.
  'growth_snapshots','bid_watchlist',
  // Route Debriefs, added 2026-07-13 - same class of bug: tech end-of-
  // shift debriefs were 100% localStorage-only on whichever device
  // submitted them (route-debrief.html), capped at 60 and truncated
  // silently. A GM on a different device could never see any of it.
  // See the per-division routing fix on gm-dashboard.html the same day.
  'debriefs',
  // Report Settings admin tab, added 2026-07-13 per Ted -- restricted to
  // Jim Kennedy (VP Sales), Ted Scholl (Admin), Tom Pittakas (Sales
  // Manager) only. Controls which automated reports send, to whom, and
  // on what schedule, without needing a code change + redeploy for
  // every timing tweak.
  'report_settings',
  // Reception call log, added 2026-07-13 per Ted -- was 100%
  // localStorage-only with no D1 path at all (not even a partial
  // sync attempt), meaning any incoming call that didn't happen to
  // match an existing lead/contact by phone number was invisible
  // outside the one device that logged it. Covers every call type
  // (new inquiries, complaints, emergencies, vendor calls, etc.),
  // not just cold-call-style new business.
  'rcp_calls',
  // Fire Safety Drip Campaign, added 2026-07-14 per Ted -- customer
  // monthly + prospect biweekly email tracks, sent via the existing
  // Resend integration (termac-notify's /send-report), bypassing Brevo
  // entirely until that gets set up. See fire-safety-campaign-schema.sql.
  'campaign_content','campaign_sends','campaign_optouts',
  // Opportunity lifecycle / SLA tracking + churn revenue + rep commission
  // structure, added 2026-07-15 per Ted. See
  // opportunity_churn_commission_schema_v2.sql for the full D1 schema.
  'rep_comp_profiles','bonus_tiers','reason_codes',
  'account_rep_assignments','account_churn_events',
  // 2026-07-15 per Ted's console-error catch: added to the client's
  // D1_SYNC_TABLES list in termac-d1-sync.js on 2026-07-15 (feeds the
  // pricing modal on Opportunity creation) but never mirrored here --
  // same class of bug as the allpro_cost_lines miss on 2026-07-11. Every
  // GET for this table has been 400ing silently since, meaning the real
  // 615-row pricing catalog in D1 was unreachable from any device that
  // didn't already have it cached locally from wherever it was built.
  'service_pricing_catalog',
  // account_assets, added 2026-07-16 -- existed since the ServiceTrade
  // sync build (77 real rows: hood systems, fire extinguishers,
  // emergency lights, etc.) but was never opened up to any client,
  // written only by workers/servicetrade-sync directly against D1.
  // Surfacing it read-only on the Location detail page per Ted.
  'account_assets',
  // tasks, added 2026-07-17 per Ted: self-assigned to-dos and follow-ups,
  // either standalone or attached to a lead/location/contact/opportunity/
  // account.
  'tasks',
  // st_services, added 2026-07-17: recurring service contract summary
  // derived from ServiceTrade job recurrence data per location.
  'st_services',
  // st_deficiencies, added 2026-07-17: open inspection findings flagged
  // during ServiceTrade service visits -- key context for disco prep.
  'st_deficiencies',
  // ServiceTrade sync progress tracking, added 2026-07-17 -- the ST
  // sync dashboard panel was 400ing because this table was never added.
  'servicetrade_sync_progress',
  // AllPro Site Survey, Material Costs, Job Bundles, Calendar Sync -- added 2026-07-23
  'allpro_site_surveys','allpro_material_costs','allpro_job_bundles','calendar_sync',
  // Termac dish machine quote builder -- added 2026-07-23
  // Stores one row per dish machine quote built by Tom Pittakas or any rep.
  // Full site survey, equipment selection, chemical program, payment terms.
  'termac_dish_quotes',
  // localStorage-to-D1 migration, added 2026-07-24 per full platform audit --
  // all of these were 100% localStorage-only across every device. Any data
  // entered on one device was invisible everywhere else.
  'unipro_jobs',        // job log across all UniPro divisions
  'route_debriefs',     // rep end-of-day route debrief submissions
  'office_queue',       // cross-device office notification/action queue
  'callback_queue',     // reception callback queue
  'reception_calls',    // full reception call log (supplements rcp_calls)
  'tech_referrals',     // tech-to-sales lead referrals
  'hot_lead_notifs',    // hot lead alert log
  'payables',           // accounts payable (supplements accounts_payable)
  'hr_announcements',   // HR announcements board
]);

const TABLE_PREFIX = {
  users:'USR', companies:'CO', locations:'LOC', accounts:'ACC',
  contacts:'CON', leads:'LED', opportunities:'OPP', bids:'BID',
  jobs:'JOB', deficiencies:'DEF', collections:'COL',
  scheduler_queue:'SCH', activity_log:'ACT', notifications:'NOT',
  messages:'MSG', rep_cards:'REP', warehouse_inventory:'WHI', dms_coldcall:'DMS',
  appointments:'APT',
  allpro_design_projects:'ADP',
  broadcasts:'BC', dispatch_msgs:'DM', wh_requisitions:'WHR',
  wh_ready_handoffs:'WHH', parts_requests:'PR', transfer_requests:'XFR',
  hr_data:'HRD',
  allpro_spiffs:'SPF',
  crm_tombstones:'TMB',
  allpro_cost_lines:'ACL',
  daily_digests:'DIG',
  rep_targets:'TGT',
  division_actuals:'DVA',
  trade_partners:'TRP',
  trade_partner_referrals:'REF',
  trade_partner_bids:'TPB',
  reference_library:'REL',
  allpro_rate_tables:'ART',
  allpro_quotes:'AQT',
  allpro_quote_lines:'AQL',
  allpro_hood_pricing:'AHP',
  allpro_fan_pricing:'AFP',
  allpro_parts_catalog:'APC',
  accounts_payable:'AP',
  expense_reports:'EXP',
  customer_orders:'ORD',
  reorder_requests:'RO',
  warehouse_alerts:'WHA',
  debriefs:'DBR',
  report_settings:'RPT',
  rcp_calls:'RCP',
  campaign_content:'CC',
  campaign_sends:'CS',
  campaign_optouts:'CO2',
  rep_comp_profiles:'RCM',
  bonus_tiers:'BTR',
  reason_codes:'RSN',
  account_rep_assignments:'ARA',
  account_churn_events:'ACE',
  tasks:'TSK',
  account_assets:'AST',
  st_services:'STS',
  st_deficiencies:'STD',
  servicetrade_sync_progress:'SSP',
  allpro_site_surveys:'ASS',
  allpro_material_costs:'AMC',
  allpro_job_bundles:'AJB',
  calendar_sync:'CAL',
  termac_dish_quotes:'TDQ',
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function nowTs() { return Date.now(); }

function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2,6).toUpperCase();
  return `${prefix}-${ts}${rand}`;
}

async function handleDB(request, env, origin, parts, method) {
  if (!env.API_SECRET || request.headers.get('X-API-Secret') !== env.API_SECRET) {
    return json({ ok:false, error:'Unauthorized' }, 401, origin);
  }

  const table = parts[0];
  const id = parts[1];

  // POST /db/query
  if (table === 'query' && method === 'POST') {
    try {
      const body = await request.json();
      if (!body.sql || !body.sql.trim().toUpperCase().startsWith('SELECT')) {
        return json({ ok:false, error:'Only SELECT allowed' }, 400, origin);
      }
      const result = await env.DB.prepare(body.sql).bind(...(body.params||[])).all();
      return json({ ok:true, results:result.results }, 200, origin);
    } catch(e) { return json({ ok:false, error:e.message }, 500, origin); }
  }

  if (!ALLOWED_TABLES.has(table)) {
    return json({ ok:false, error:`Table '${table}' not allowed` }, 400, origin);
  }

  try {
    if (method === 'GET' && !id) {
      const url = new URL(request.url);
      const params = Object.fromEntries(url.searchParams);
      const limit = Math.min(parseInt(params.limit)||100, 500);
      const offset = parseInt(params.offset)||0;
      delete params.limit; delete params.offset;
      const filters = Object.entries(params).filter(([k]) => /^[a-z_]+$/.test(k));
      let where = filters.length ? ' WHERE '+filters.map(([k])=>`${k} = ?`).join(' AND ') : '';
      const vals = filters.map(([,v])=>v);
      const result = await env.DB.prepare(`SELECT * FROM ${table}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
        .bind(...vals, limit, offset).all();
      return json({ ok:true, results:result.results, count:result.results.length }, 200, origin);
    }

    if (method === 'GET' && id) {
      const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (!result) return json({ ok:false, error:'Not found' }, 404, origin);
      return json({ ok:true, result }, 200, origin);
    }

    if (method === 'POST' && !id) {
      const body = await request.json();
      const now = nowTs();
      const newId = body.id || generateId(TABLE_PREFIX[table]||'REC');
      const record = { ...body, id:newId, created_at:now, updated_at:now };
      const cols = Object.keys(record).filter(k=>/^[a-z_]+$/.test(k));
      const vals = cols.map(k=>record[k]);
      await env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`)
        .bind(...vals).run();
      if (!['activity_log','notifications','messages'].includes(table)) {
        const acctId = record.account_id||(table==='accounts'?newId:null);
        await env.DB.prepare(`INSERT INTO activity_log (id,entity_type,entity_id,account_id,action,created_at) VALUES (?,?,?,?,?,?)`)
          .bind(generateId('ACT'),table,newId,acctId,'created',now).run();
      }
      return json({ ok:true, id:newId }, 201, origin);
    }

    if (method === 'PUT' && id) {
      const body = await request.json();
      const now = nowTs();
      const updates = { ...body, updated_at:now };
      delete updates.id; delete updates.created_at;
      const cols = Object.keys(updates).filter(k=>/^[a-z_]+$/.test(k));
      const vals = cols.map(k=>updates[k]);
      const result = await env.DB.prepare(`UPDATE ${table} SET ${cols.map(k=>`${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...vals, id).run();
      if (result.meta.changes === 0) return json({ ok:false, error:'Not found' }, 404, origin);
      return json({ ok:true, id, changes:result.meta.changes }, 200, origin);
    }

    if (method === 'DELETE' && id) {
      const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      if (result.meta.changes === 0) return json({ ok:false, error:'Not found' }, 404, origin);
      return json({ ok:true, id, deleted:true }, 200, origin);
    }

    return json({ ok:false, error:'Method not allowed' }, 405, origin);
  } catch(e) {
    return json({ ok:false, error:'Database error: '+e.message }, 500, origin);
  }
}

// -- CAMPAIGN UNSUBSCRIBE -- public, no auth (has to work from a plain
// email link click), GET only, writes to campaign_optouts and shows a
// plain confirmation page. Never touches the real account/lead record.
async function handleCampaignUnsubscribe(request, env, origin) {
  const url = new URL(request.url);
  const targetType = url.searchParams.get('type');
  const targetId = url.searchParams.get('id');
  const page = (msg) => new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Termac One</title></head>
     <body style="font-family:Arial,sans-serif;padding:40px;text-align:center;color:#1A1D21">
     <h2>Termac Family of Companies</h2><p>${msg}</p></body></html>`,
    { status:200, headers:{ 'Content-Type':'text/html', ...corsHeaders(origin) } }
  );

  if (!targetType || !targetId || !['account','lead'].includes(targetType)) {
    return page('That unsubscribe link looks incomplete. Reply to any email from Ted directly and we will take care of it.');
  }

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO campaign_optouts (target_type, target_id, opted_out_at) VALUES (?,?,?)`
    ).bind(targetType, targetId, nowTs()).run();
    return page('You have been unsubscribed from this email series. You will not receive further messages from this campaign.');
  } catch (e) {
    return page('Something went wrong processing that. Reply to any email from Ted directly and we will take care of it.');
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.replace(/^\//, '').split('/');

    // Route /db/* to D1 handler
    if (pathParts[0] === 'db') {
      return handleDB(request, env, origin, pathParts.slice(1), method);
    }

    // Google Places autocomplete proxy -- keeps the API key server-side so
    // it never appears in browser source. Accepts GET with ?q=<search term>
    // and optionally &lat=&lng= for location bias. Returns Places predictions
    // in a consistent shape regardless of Google API version changes.
    if (pathParts[0] === 'maps' && pathParts[1] === 'autocomplete') {
      if (!env.GOOGLE_MAPS_KEY) return json({ ok: false, error: 'Maps not configured' }, 503, origin);
      const q = url.searchParams.get('q') || '';
      if (q.length < 2) return json({ ok: true, predictions: [] }, 200, origin);
      const lat  = url.searchParams.get('lat') || '40.0';
      const lng  = url.searchParams.get('lng') || '-75.2';
      const radius = url.searchParams.get('radius') || '80000';
      const gUrl = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
        + '?input=' + encodeURIComponent(q)
        + '&types=establishment|geocode'
        + '&components=country:us'
        + '&location=' + lat + ',' + lng
        + '&radius=' + radius
        + '&key=' + env.GOOGLE_MAPS_KEY;
      try {
        const gr = await fetch(gUrl);
        const gd = await gr.json();
        const predictions = (gd.predictions || []).slice(0, 6).map(function(p) {
          return {
            placeId:   p.place_id,
            main:      p.structured_formatting.main_text,
            secondary: p.structured_formatting.secondary_text || '',
            isPlace:   p.types && p.types.indexOf('establishment') !== -1,
          };
        });
        return json({ ok: true, predictions: predictions }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: 'Places lookup failed' }, 502, origin);
      }
    }

    // Google Places detail -- resolves a placeId to full address + ZIP
    if (pathParts[0] === 'maps' && pathParts[1] === 'detail') {
      if (!env.GOOGLE_MAPS_KEY) return json({ ok: false, error: 'Maps not configured' }, 503, origin);
      const placeId = url.searchParams.get('place_id') || '';
      if (!placeId) return json({ ok: false, error: 'place_id required' }, 400, origin);
      const gUrl = 'https://maps.googleapis.com/maps/api/place/details/json'
        + '?place_id=' + encodeURIComponent(placeId)
        + '&fields=address_components,formatted_address,name,formatted_phone_number,geometry'
        + '&key=' + env.GOOGLE_MAPS_KEY;
      try {
        const gr = await fetch(gUrl);
        const gd = await gr.json();
        const comps = (gd.result && gd.result.address_components) || [];
        const get = function(type) {
          var c = comps.find(function(x){ return x.types && x.types.indexOf(type) !== -1; });
          return c ? c.long_name : '';
        };
        return json({
          ok: true,
          name:             (gd.result && gd.result.name) || '',
          formatted:        (gd.result && gd.result.formatted_address) || '',
          phone:            (gd.result && gd.result.formatted_phone_number) || '',
          street_number:    get('street_number'),
          route:            get('route'),
          city:             get('locality') || get('sublocality'),
          state:            get('administrative_area_level_1'),
          zip:              get('postal_code'),
          country:          get('country'),
          lat:              gd.result && gd.result.geometry && gd.result.geometry.location.lat || null,
          lng:              gd.result && gd.result.geometry && gd.result.geometry.location.lng || null,
        }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: 'Place detail lookup failed' }, 502, origin);
      }
    }

    // Public campaign unsubscribe link, GET only, no auth
    if (pathParts[0] === 'campaign' && pathParts[1] === 'unsubscribe' && method === 'GET') {
      return handleCampaignUnsubscribe(request, env, origin);
    }

    // Default: Anthropic AI proxy (POST only)
    if (method !== 'POST') {
      return json({ error: 'POST only' }, 405, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'API key not configured' }, 503, origin);
    }

    try {
      const body = await request.json();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-4-6',
          max_tokens: body.max_tokens || 1000,
          messages: body.messages || [],
          system: body.system,
          temperature: body.temperature,
        }),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    } catch(err) {
      return json({ error: 'Proxy error', detail: err.message }, 500, origin);
    }
  },

  // -- DAILY DIGEST -- runs on the cron schedule in wrangler.toml, not
  // triggered by any page load. Computes each rep's real pace targets
  // and real hot leads straight from D1, writes one row per rep plus a
  // team rollup for managers, so it's there waiting the moment anyone
  // opens the app - not recomputed live, genuinely prepared ahead of
  // time. Reads each rep's real call/visit targets from rep_targets
  // where they exist, falling back to sensible defaults only for reps
  // who haven't had targets set through the Quota Builder yet.
  async scheduled(event, env, ctx) {
    // Cron is now hourly (see wrangler.toml note), so these three keep
    // their exact original once-a-day behavior via an explicit hour
    // check -- none of them were built to run 24x/day safely, and
    // changing that wasn't in scope of adding report scheduling.
    if (new Date().getUTCHours() === 11) {
      ctx.waitUntil(runDailyDigest(env));
      ctx.waitUntil(runBusinessStatusCheck(env));
      ctx.waitUntil(runGrowthSnapshot(env));
    }
    // Report Settings admin tab, added 2026-07-13 per Ted -- this one
    // actually needs the hourly cadence, to check each report's real
    // configured send_hour_utc against the current hour.
    ctx.waitUntil(runScheduledReports(env));
    // Fire Safety Drip Campaign, added 2026-07-14 per Ted -- self-healing
    // daily trigger. Rather than requiring an exact hour match (which
    // would miss today's run entirely if deployed after the target
    // hour), this fires on any hourly tick at or after 13:00 UTC (9am
    // ET), and runFireSafetyCampaigns itself checks whether a batch
    // already went out today before doing anything -- so it catches up
    // same-day on a late deploy, but still only actually runs once per
    // day once it settles into its normal rhythm. This does NOT change
    // how often any single recipient gets emailed -- that's governed
    // separately by each track's intervalDays inside runCampaignTrack
    // (30 days for customers, 14 for prospects), checked per-recipient
    // regardless of how many times this daily check itself fires.
    if (new Date().getUTCHours() >= 13) {
      ctx.waitUntil(runFireSafetyCampaigns(env));
    }
  },
};

// -- SCHEDULED REPORTS -- reads report_settings (managed via the Report
// Settings admin tab, restricted to Jim Kennedy/Ted Scholl/Tom Pittakas)
// and sends any report whose configured schedule matches right now.
// last_sent_at guards against double-sending if the Worker somehow gets
// invoked twice in the same hour window.
async function runScheduledReports(env) {
  try {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDow = ['SU','MO','TU','WE','TH','FR','SA'][now.getUTCDay()];
    const currentDom = now.getUTCDate();
    const todayStr = now.toISOString().slice(0, 10);

    const due = await env.DB.prepare(
      `SELECT * FROM report_settings WHERE enabled = 1 AND send_hour_utc = ?`
    ).bind(currentHour).all();

    for (const report of (due.results || [])) {
      // Skip if already sent today (covers the rare case of two
      // invocations landing in the same hour, and covers non-daily
      // frequencies where "due this hour" isn't enough on its own).
      if (report.last_sent_at) {
        const lastSentStr = new Date(report.last_sent_at).toISOString().slice(0, 10);
        if (lastSentStr === todayStr) continue;
      }

      if (report.frequency === 'weekly') {
        let days = [];
        try { days = JSON.parse(report.days_of_week || '[]'); } catch (e) {}
        if (!days.includes(currentDow)) continue;
      } else if (report.frequency === 'monthly') {
        if (report.day_of_month && currentDom !== report.day_of_month) continue;
      }
      // 'daily' frequency has no further check -- send_hour_utc match is enough.

      let recipients = [];
      try { recipients = JSON.parse(report.recipients || '[]'); } catch (e) {}
      if (!recipients.length) continue;

      const html = await buildReportHtml(env, report.report_key);
      if (!html) continue;

      try {
        // 2026-07-13 fix: was a raw fetch() to termac-notify's public
        // workers.dev URL, which Cloudflare blocks worker-to-worker
        // (error 1042, not JSON) -- silently failed every time via the
        // catch below, which is why last_sent_at never updated and Ted
        // never saw a single report despite the setting being saved and
        // enabled correctly. Now uses the Service Binding, same pattern
        // already working for termac-booking-api.
        if (!env.NOTIFY_SERVICE) continue;
        await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/send-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipients,
            subject: (report.label || report.report_key) + ' - ' + todayStr,
            html,
          }),
        });
      } catch (e) { continue; }

      await env.DB.prepare(`UPDATE report_settings SET last_sent_at = ? WHERE id = ?`)
        .bind(Date.now(), report.id).run();
    }
  } catch (e) {
    // Swallow -- a failed report check shouldn't take the worker down.
  }
}

// Builds the actual HTML body for a given report_key. Currently only
// 'daily_digest' is real; add new cases here as new reports are defined
// through the admin tab rather than needing a full new pipeline each time.
async function buildReportHtml(env, reportKey) {
  if (reportKey === 'daily_digest') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await env.DB.prepare(
        `SELECT * FROM daily_digests WHERE digest_date = ? ORDER BY rep_name`
      ).bind(today).all();
      const reps = (rows.results || []).filter(r => r.rep_name !== '__team__');
      const team = (rows.results || []).find(r => r.rep_name === '__team__');
      if (!reps.length && !team) return null;
      let html = '<h2>Daily Rep Digest — ' + today + '</h2>';
      if (team) html += '<p>' + escapeHtmlLocal(team.message || '') + '</p>';
      html += '<table style="border-collapse:collapse;width:100%">';
      html += '<tr><th style="text-align:left;padding:6px;border-bottom:1px solid #ccc">Rep</th><th style="text-align:left;padding:6px;border-bottom:1px solid #ccc">Hot Leads</th><th style="text-align:left;padding:6px;border-bottom:1px solid #ccc">Message</th></tr>';
      reps.forEach(r => {
        html += '<tr><td style="padding:6px;border-bottom:1px solid #eee">' + escapeHtmlLocal(r.rep_name) + '</td>' +
          '<td style="padding:6px;border-bottom:1px solid #eee">' + (r.hot_lead_count || 0) + '</td>' +
          '<td style="padding:6px;border-bottom:1px solid #eee">' + escapeHtmlLocal(r.message || '') + '</td></tr>';
      });
      html += '</table>';
      return html;
    } catch (e) { return null; }
  }
  return null;
}
function escapeHtmlLocal(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// -- FIRE SAFETY DRIP CAMPAIGN -- added 2026-07-14 per Ted. Two tracks,
// both sent through the same Resend integration report emails already
// use (termac-notify's /send-report, Service Binding, no Brevo). Runs
// once daily (see the UTC-13 hour check in scheduled() above).
//
// customer_monthly: existing active accounts, one email every 30 days,
// educational + cross-sell, pulled from accounts' primary contact.
// prospect_biweekly: leads (non-customers), one email every 14 days,
// persuasive, pushes the free site safety survey booking link.
//
// BATCH_SIZE caps each run so this never tries to process the whole
// book in one Worker invocation -- same reasoning as the business status
// check job. Whoever is most overdue (or never sent to) goes first each
// day, so the backlog clears itself over the following days rather than
// stalling on one end of the list.
const CAMPAIGN_BATCH_SIZE = 60;
const BOOKING_LINK = 'https://coachted-retro.github.io/unipro-sales/digital-card.html?rep=ted-scholl';
// Company banner, added 2026-07-14 per Ted -- the "60 years / A System of
// Services" family-of-companies banner, same one on the printed survey
// report. Stored as a hosted image constant so every template can share
// {{BANNER}} without duplicating the image data in each campaign_content
// row. TEMPORARY: this is currently a base64 data URI as a stopgap so the
// campaign can go out today. Base64 images are unreliable across email
// clients (Gmail/Outlook often strip or clip them) and bloat message
// size, so this should be swapped to a real hosted URL (e.g. a static
// asset in this repo, referenced via the GitHub Pages URL the same way
// termac-one-logo.png already is) the next time this file gets touched.
const BANNER_IMG_URL = 'data:image/jpeg;base64,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';
const BANNER_HTML = '<div style="text-align:center;padding:16px 16px 8px;border-bottom:3px solid #1A1D21"><img src="' + BANNER_IMG_URL + '" alt="Termac Family of Companies" style="max-width:100%;height:auto;display:inline-block"></div>';

async function runFireSafetyCampaigns(env) {
  // Same-day guard: if either track has already sent at least one email
  // today (UTC calendar day), skip entirely. This is what keeps the new
  // >=13 hourly check above from re-running every hour after 13:00 --
  // it fires once, sends today's batch, and every hourly tick after
  // that for the rest of the day sees today's row and does nothing.
  try {
    const todayStartUtc = new Date();
    todayStartUtc.setUTCHours(0, 0, 0, 0);
    const alreadyRanToday = await env.DB.prepare(
      `SELECT 1 FROM campaign_sends WHERE sent_at >= ? LIMIT 1`
    ).bind(todayStartUtc.getTime()).first();
    if (alreadyRanToday) return;
  } catch (e) {
    // If this check itself fails, fall through and attempt the send
    // anyway rather than silently never sending again.
  }
  try {
    await runCampaignTrack(env, {
      campaign: 'customer_monthly',
      targetType: 'account',
      intervalDays: 30,
    });
  } catch (e) {
    // Swallow -- one track failing shouldn't block the other or take
    // the worker down. Tomorrow's run picks up where this left off.
  }
  try {
    await runCampaignTrack(env, {
      campaign: 'prospect_biweekly',
      targetType: 'lead',
      intervalDays: 14,
    });
  } catch (e) {
    // Same reasoning as above.
  }
}

async function runCampaignTrack(env, cfg) {
  const now = Date.now();
  const cutoff = now - cfg.intervalDays * 24 * 60 * 60 * 1000;

  // Active rotating content for this track, in sequence order.
  const contentResult = await env.DB.prepare(
    `SELECT * FROM campaign_content WHERE campaign = ? AND active = 1 ORDER BY sequence_number ASC`
  ).bind(cfg.campaign).all();
  const content = contentResult.results || [];
  if (!content.length) return; // nothing to send yet

  // Candidates: real accounts/leads with an actual email on file, not
  // opted out, and either never sent to on this campaign or last sent
  // more than intervalDays ago. Ordered oldest-touched-first (nulls,
  // i.e. never sent, come first) so the backlog clears itself.
  let candidates;
  if (cfg.targetType === 'account') {
    // 2026-07-14 fix: this used to JOIN contacts on c.location_id and
    // c.is_primary, columns that don't exist on the live accounts or
    // contacts tables (accounts has no location_id, contacts has no
    // is_primary at all -- confirmed via PRAGMA table_info against the
    // real database, the original schema.sql this was written against
    // had drifted from what's actually live). That made this query
    // throw on every run, silently caught by the try/catch around it,
    // meaning the customer_monthly track never sent a single email since
    // the campaign went live. accounts already carries its own
    // contact_email column directly, no join needed at all.
    candidates = await env.DB.prepare(
      `SELECT a.id AS target_id, a.contact_email AS recipient_email,
              (SELECT MAX(sent_at) FROM campaign_sends cs WHERE cs.target_type='account' AND cs.target_id=a.id AND cs.campaign=?) AS last_sent_at,
              (SELECT COUNT(*) FROM campaign_sends cs WHERE cs.target_type='account' AND cs.target_id=a.id AND cs.campaign=?) AS send_count
       FROM accounts a
       WHERE a.status = 'active' AND a.contact_email IS NOT NULL AND a.contact_email != ''
         AND a.id NOT IN (SELECT target_id FROM campaign_optouts WHERE target_type='account')
       ORDER BY last_sent_at IS NOT NULL, last_sent_at ASC
       LIMIT ?`
    ).bind(cfg.campaign, cfg.campaign, CAMPAIGN_BATCH_SIZE).all();
  } else {
    candidates = await env.DB.prepare(
      `SELECT l.id AS target_id, l.email AS recipient_email,
              (SELECT MAX(sent_at) FROM campaign_sends cs WHERE cs.target_type='lead' AND cs.target_id=l.id AND cs.campaign=?) AS last_sent_at,
              (SELECT COUNT(*) FROM campaign_sends cs WHERE cs.target_type='lead' AND cs.target_id=l.id AND cs.campaign=?) AS send_count
       FROM leads l
       WHERE l.email IS NOT NULL AND l.email != ''
         AND l.id NOT IN (SELECT target_id FROM campaign_optouts WHERE target_type='lead')
       ORDER BY last_sent_at IS NOT NULL, last_sent_at ASC
       LIMIT ?`
    ).bind(cfg.campaign, cfg.campaign, CAMPAIGN_BATCH_SIZE).all();
  }

  for (const row of (candidates.results || [])) {
    if (row.last_sent_at && row.last_sent_at > cutoff) continue; // not due yet

    const idx = (row.send_count || 0) % content.length;
    const piece = content[idx];

    const bodyWithLink = piece.body_html
      .split('{{BOOKING_LINK}}').join(BOOKING_LINK)
      .split('{{BANNER}}').join(BANNER_HTML);
    const unsubscribeUrl = `https://unipro-ai-proxy.termac-one.workers.dev/campaign/unsubscribe?type=${cfg.targetType}&id=${row.target_id}`;
    const html = bodyWithLink +
      `<p style="font-family:Arial,sans-serif;font-size:11px;color:#9AA0A8;text-align:center;margin-top:24px">` +
      `Termac Family of Companies, Eastern PA · NJ · DE · MD · DC &nbsp;·&nbsp; ` +
      `<a href="${unsubscribeUrl}" style="color:#9AA0A8">Unsubscribe from this series</a></p>`;

    let status = 'sent';
    try {
      if (!env.NOTIFY_SERVICE) { status = 'failed'; }
      else {
        await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/send-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipients: [row.recipient_email],
            subject: piece.subject,
            html,
          }),
        });
      }
    } catch (e) {
      status = 'failed';
    }

    await env.DB.prepare(
      `INSERT INTO campaign_sends (id, campaign, target_type, target_id, content_id, recipient_email, status, sent_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      generateId('CS'), cfg.campaign, cfg.targetType, row.target_id,
      piece.id, row.recipient_email, status, Date.now()
    ).run();

    // Log this send as a real touchpoint, added 2026-07-14 per Ted --
    // uses the same activity_log mechanism logTouchpoint() in
    // termac-d1-sync.js already writes to for every call, visit, and
    // note across the platform (entity_type as the plural table name,
    // action as "icon title", detail as the note, account_id set for
    // accounts and left null for leads). This is what makes the send
    // show up in that account or lead's own touchpoint timeline the
    // next time it's opened, and count toward any touchpoint-based
    // stat that reads from activity_log, without needing a second,
    // parallel logging system.
    if (status === 'sent') {
      try {
        await env.DB.prepare(
          `INSERT INTO activity_log (id, entity_type, entity_id, account_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?,?,?,?)`
        ).bind(
          'act_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
          cfg.targetType === 'account' ? 'accounts' : 'leads',
          row.target_id,
          cfg.targetType === 'account' ? row.target_id : null,
          'Fire Safety Campaign',
          '\uD83D\uDCE7 Fire Safety Campaign Email Sent',
          piece.subject,
          Date.now()
        ).run();
      } catch (e) {
        // A failed touchpoint log should never block the actual send
        // record above -- the email already went out either way.
      }
    }
  }
}

// -- BUSINESS STATUS CHECK -- added 2026-07-11 per Ted. Runs on the same
// daily cron as the digest above, reusing the same ANTHROPIC_API_KEY
// secret. Rotates through real accounts (ServiceTrade-manual imports
// first, since those are the newest/least-verified, then everything
// else oldest-checked-first) at a fixed batch size per day rather than
// hitting the whole book at once -- ~2,400 accounts at 25/day is a
// ~96-day rotation, which is plenty for "is this place still open,"
// nothing here changes status day to day for the vast majority of
// accounts.
//
// DELIBERATE DESIGN CHOICE: this job never sets accounts.status itself.
// A web-search-based AI judgment is good enough to flag something for a
// human to glance at, not good enough to silently close a real account
// on. It writes an activity_log row every time it checks something, and
// sets accounts.status_flag to 'possible_closure' or 'name_change' only
// when the signal is real -- those flags surface in the Operations
// Report as a review queue. A person (Ted or office) still makes the
// final call and clears the flag.
async function runBusinessStatusCheck(env) {
  const BATCH_SIZE = 25;
  const now = Date.now();
  try {
    if (!env.ANTHROPIC_API_KEY) return; // same guard as the AI proxy route above

    const batch = await env.DB.prepare(
      `SELECT id, name, business, address, city, state, zip
       FROM accounts
       WHERE status = 'active'
       ORDER BY
         CASE WHEN source = 'servicetrade_manual' THEN 0 ELSE 1 END,
         last_status_check_at IS NOT NULL,
         last_status_check_at ASC
       LIMIT ?`
    ).bind(BATCH_SIZE).all();

    const accounts = batch.results || [];

    for (const acct of accounts) {
      const name = acct.name || acct.business || '';
      const addr = [acct.address, acct.city, acct.state, acct.zip].filter(Boolean).join(', ');
      if (!name || !addr) {
        // Not enough to search on -- still stamp it checked so the
        // rotation moves past it instead of stalling here forever.
        await env.DB.prepare(`UPDATE accounts SET last_status_check_at = ? WHERE id = ?`)
          .bind(now, acct.id).run();
        continue;
      }

      let findingText = '';
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 300,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{
              role: 'user',
              content: `Is the business "${name}" at ${addr} still open and operating? ` +
                `Search the web for current status. Respond in exactly this format, ` +
                `three lines, no extra text:\n` +
                `STATUS: OPEN or CLOSED or UNCLEAR\n` +
                `NAME_CHANGE: none, or a short description if a rebrand/new ownership was found\n` +
                `SOURCE: one short citation (site name) supporting STATUS`,
            }],
          }),
        });
        const data = await res.json();
        const textBlock = (data.content || []).find(b => b.type === 'text');
        findingText = textBlock ? textBlock.text : '';
      } catch (e) {
        findingText = 'STATUS: UNCLEAR\nNAME_CHANGE: none\nSOURCE: search failed - ' + e.message;
      }

      const statusMatch = /STATUS:\s*(OPEN|CLOSED|UNCLEAR)/i.exec(findingText);
      const nameChangeMatch = /NAME_CHANGE:\s*(.+)/i.exec(findingText);
      const status = statusMatch ? statusMatch[1].toUpperCase() : 'UNCLEAR';
      const nameChange = nameChangeMatch ? nameChangeMatch[1].trim() : '';
      const hasNameChange = nameChange && !/^none$/i.test(nameChange);

      let flag = null;
      if (status === 'CLOSED') flag = 'possible_closure';
      else if (hasNameChange) flag = 'name_change';

      await env.DB.prepare(
        `INSERT INTO activity_log (id, entity_type, entity_id, account_id, action, detail, created_at) VALUES (?,?,?,?,?,?,?)`
      ).bind(
        'LOG-STATUSCHK-' + acct.id + '-' + now,
        'account', acct.id, acct.id, 'business_status_check',
        (findingText || 'No result').slice(0, 500),
        now
      ).run();

      await env.DB.prepare(
        `UPDATE accounts SET last_status_check_at = ?, status_flag = ? WHERE id = ?`
      ).bind(now, flag, acct.id).run();
    }
  } catch (e) {
    // Same pattern as runDailyDigest -- a failed run shouldn't take the
    // worker down, just means today's batch didn't advance. Tomorrow
    // picks up from wherever last_status_check_at left off.
  }
}

async function runDailyDigest(env) {
  const today = new Date().toISOString().slice(0,10);
  const now = Date.now();
  const DEFAULT_CALL_TARGET = 10; // daily, derived from a 50/week default quota
  const DEFAULT_VISIT_TARGET = 2;

  try {
    const repsResult = await env.DB.prepare(
      `SELECT DISTINCT assigned_rep FROM leads WHERE assigned_rep IS NOT NULL AND assigned_rep != ''`
    ).all();
    const repNames = (repsResult.results || []).map(r => r.assigned_rep).filter(Boolean);

    let teamHotCount = 0, teamRepCount = 0;

    for (const repName of repNames) {
      let callTarget = DEFAULT_CALL_TARGET, visitTarget = DEFAULT_VISIT_TARGET;
      try {
        const tgtResult = await env.DB.prepare(
          `SELECT call_target, visit_target FROM rep_targets WHERE rep_name = ?`
        ).bind(repName).first();
        if (tgtResult) {
          // Stored values are weekly (matching the Quota Builder); the
          // digest works in daily terms, same /5 conversion the client uses.
          if (tgtResult.call_target) callTarget = Math.max(1, Math.round(tgtResult.call_target / 5));
          if (tgtResult.visit_target) visitTarget = Math.max(1, Math.round(tgtResult.visit_target / 5));
        }
      } catch (e) { /* fall through to defaults */ }

      const hotResult = await env.DB.prepare(
        `SELECT id, business, ai_score FROM leads WHERE assigned_rep = ? AND (ai_score >= 7 OR is_hot = 1) ORDER BY ai_score DESC LIMIT 3`
      ).bind(repName).all();
      const hotLeads = hotResult.results || [];
      teamHotCount += hotLeads.length;
      teamRepCount++;

      const message = hotLeads.length
        ? `${hotLeads.length} hot lead${hotLeads.length===1?'':'s'} ready today`
        : `No hot leads flagged right now - worth a look at the pipeline`;

      await env.DB.prepare(
        `INSERT OR REPLACE INTO daily_digests (id, rep_name, digest_date, call_target, visit_target, hot_lead_count, hot_leads_json, message, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(
        'DIG-' + repName.replace(/\s+/g,'') + '-' + today,
        repName, today, callTarget, visitTarget,
        hotLeads.length, JSON.stringify(hotLeads), message, now
      ).run();
    }

    // Team rollup - one row Tom/Jim can read without opening every rep individually
    await env.DB.prepare(
      `INSERT OR REPLACE INTO daily_digests (id, rep_name, digest_date, call_target, visit_target, hot_lead_count, hot_leads_json, message, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      'DIG-team-' + today, '__team__', today, null, null,
      teamHotCount, JSON.stringify({ repCount: teamRepCount }),
      `${teamRepCount} reps, ${teamHotCount} hot leads flagged team-wide today`, now
    ).run();
  } catch (e) {
    // Swallow - a failed digest shouldn't take the worker down, just
    // means nothing new got written today. Next morning tries again.
  }
}

// -- GROWTH SNAPSHOT -- added 2026-07-13 per Ted. Runs on the same daily
// cron as the digest above. Records one real data point per day into
// growth_snapshots: total active accounts, total annual_value (real
// revenue once populated, honestly 0/null until then -- this job never
// invents a number), and a division breakdown. This is what lets the
// Growth & Opportunity panel show a genuine trend line over time instead
// of a single point-in-time snapshot. INSERT OR IGNORE against the
// unique snapshot_date index means re-running this on the same UTC day
// (e.g. a manual re-trigger) never creates a duplicate or double-counts.
async function runGrowthSnapshot(env) {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
    const now = Date.now();

    const totals = await env.DB.prepare(
      `SELECT COUNT(*) as total_accounts,
              SUM(CASE WHEN annual_value IS NOT NULL THEN annual_value ELSE 0 END) as total_value,
              SUM(CASE WHEN annual_value IS NOT NULL THEN 1 ELSE 0 END) as accounts_with_value
       FROM accounts WHERE status = 'active'`
    ).first();

    const byDivision = await env.DB.prepare(
      `SELECT division, COUNT(*) as cnt FROM accounts WHERE status = 'active' GROUP BY division`
    ).all();
    const divisionMap = {};
    for (const row of (byDivision.results || [])) {
      divisionMap[row.division || 'Unassigned'] = row.cnt;
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO growth_snapshots
       (id, snapshot_date, total_active_accounts, total_annual_value, accounts_with_value, by_division, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      'snap_' + today,
      today,
      totals ? totals.total_accounts : 0,
      totals ? totals.total_value : 0,
      totals ? totals.accounts_with_value : 0,
      JSON.stringify(divisionMap),
      now
    ).run();
  } catch (e) {
    // Swallow - same reasoning as the digest job. Missing one day's
    // snapshot is recoverable; taking the worker down is not.
  }
}
