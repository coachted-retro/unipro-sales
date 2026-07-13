/**
 * unipro-ai-proxy — Termac One
 * Routes:
 *   POST /          — Anthropic API proxy (AI features)
 *   GET/POST/PUT/DELETE /db/:table[/:id] — D1 CRM database API
 *   POST /db/query  — raw SELECT
 */

const ALLOWED_ORIGINS = [
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
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
  accounts_payable:'AP',
  expense_reports:'EXP',
  customer_orders:'ORD',
  reorder_requests:'RO',
  warehouse_alerts:'WHA',
  debriefs:'DBR',
  report_settings:'RPT',
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
        await fetch('https://termac-notify.termac-one.workers.dev/send-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipients,
            subject: (report.label || report.report_key) + ' — ' + todayStr,
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
