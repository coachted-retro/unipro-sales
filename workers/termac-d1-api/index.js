/**
 * termac-d1-api — Termac One
 * RESTful API layer over the termac-crm D1 database.
 *
 * Routes:
 *   GET    /api/:table               list
 *   GET    /api/:table/:id           get by id
 *   POST   /api/:table               insert
 *   PUT    /api/:table/:id           update
 *   DELETE /api/:table/:id           delete
 *   POST   /api/query                raw SELECT (read-only)
 *   POST   /api/dedup-accounts       deduplicate by name+address
 *                                    ?dry_run=true (default) or false
 *                                    ?limit=50&offset=0 for batched live runs
 */

const ALLOWED_ORIGINS = [
  'https://sales.mytermac.com',
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
  'https://coachted-retro.github.io',
];

const ALLOWED_TABLES = new Set([
  'users', 'companies', 'locations', 'accounts', 'contacts',
  'leads', 'opportunities', 'bids', 'jobs', 'deficiencies',
  'collections', 'scheduler_queue', 'activity_log',
  'notifications', 'messages', 'rep_cards', 'warehouse_inventory', 'dms_coldcall',
  'allpro_projects', 'allpro_cost_lines',
]);

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

function err(msg, status, origin) {
  return json({ ok: false, error: msg }, status, origin);
}

function nowTs() { return Date.now(); }

function generateId(prefix) {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${ts}${rand}`;
}

const TABLE_PREFIX = {
  users: 'USR', companies: 'CO', locations: 'LOC', accounts: 'ACC',
  contacts: 'CON', leads: 'LED', opportunities: 'OPP', bids: 'BID',
  jobs: 'JOB', deficiencies: 'DEF', collections: 'COL',
  scheduler_queue: 'SCH', activity_log: 'ACT', notifications: 'NOT',
  messages: 'MSG', rep_cards: 'REP', warehouse_inventory: 'WHI', dms_coldcall: 'DMS',
  allpro_projects: 'APR', allpro_cost_lines: 'APC',
};

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Merge priority — lower = wins.
 *
 *   0  bare Termac legacy IDs  (e.g. BA1534, CU310J)
 *   1  ST-  (app-generated)
 *   2  GTO-
 *   3  FM- / FilterMan-
 *   4  UNI-  (UniPro bulk import)
 *   5  everything else
 */
function mergePriority(id) {
  if (!id) return 5;
  if (/^[A-Z]{2,4}\d+[A-Z]?$/.test(id)) return 0; // bare legacy
  if (id.startsWith('ST-'))         return 1;
  if (id.startsWith('GTO-'))        return 2;
  if (id.startsWith('FM-'))         return 3;
  if (id.startsWith('FilterMan-'))  return 3;
  if (id.startsWith('UNI-'))        return 4;
  return 5;
}

/** Map a division field value to its canonical service tag. */
function divToService(div) {
  const m = {
    UniPro: 'UniPro', Termac: 'Termac', GTO: 'GTO',
    FilterMan: 'FilterMan', AllPro: 'AllPro',
  };
  return m[div] || null;
}

/** Canonical service sort order. */
const SVC_ORDER = ['Termac', 'UniPro', 'GTO', 'FilterMan', 'AllPro'];

/**
 * Merge any number of JSON-encoded service arrays + individual service strings
 * into a single deduplicated, canonically-ordered JSON array string.
 */
function mergeServices(...inputs) {
  const seen = new Set();
  for (const s of inputs) {
    if (!s || s === 'null' || s === '[]') continue;
    if (s.startsWith('[')) {
      try { JSON.parse(s).forEach(v => { if (v) seen.add(v); }); } catch (_) {}
    } else {
      seen.add(s); // bare string (division-derived)
    }
  }
  const out = [...seen].sort((a, b) => {
    const ia = SVC_ORDER.indexOf(a), ib = SVC_ORDER.indexOf(b);
    if (ia < 0 && ib < 0) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  return JSON.stringify(out);
}

/** Merge related_account_ids arrays. */
function mergeRelatedIds(existingStr, ...addIds) {
  let existing = [];
  try { existing = JSON.parse(existingStr || '[]') || []; } catch (_) {}
  const merged = new Set(existing);
  addIds.forEach(id => { if (id) merged.add(id); });
  return JSON.stringify([...merged]);
}

/** Query duplicate groups from D1. */
async function findDuplicateGroups(db, limit, offset) {
  const sql = `
    SELECT
      UPPER(TRIM(name))    AS norm_name,
      UPPER(TRIM(address)) AS norm_addr,
      COUNT(*)             AS dupes,
      GROUP_CONCAT(id,                          '|||') AS ids,
      GROUP_CONCAT(COALESCE(division,'?'),      '|||') AS divisions,
      GROUP_CONCAT(COALESCE(services,'null'),   '|||') AS all_services,
      GROUP_CONCAT(COALESCE(cust_num,''),       '|||') AS cust_nums,
      GROUP_CONCAT(COALESCE(related_account_ids,'[]'), '|||') AS all_related
    FROM accounts
    WHERE name    IS NOT NULL AND TRIM(name)    != ''
      AND address IS NOT NULL AND TRIM(address) != ''
    GROUP BY UPPER(TRIM(name)), UPPER(TRIM(address))
    HAVING COUNT(*) > 1
    ORDER BY dupes DESC
    LIMIT ? OFFSET ?
  `;
  const r = await db.prepare(sql).bind(limit, offset).all();
  return r.results || [];
}

/**
 * Build a merge plan for one duplicate group.
 * The division field is the authoritative source for which service tag an account
 * represents — even if the stored services string is wrong — so we always
 * inject it alongside the stored services during the merge.
 */
function buildMergePlan(group) {
  const ids      = group.ids.split('|||');
  const svcs     = group.all_services.split('|||');
  const divs     = group.divisions.split('|||');
  const custs    = group.cust_nums.split('|||');
  const rels     = group.all_related.split('|||');

  const rows = ids.map((id, i) => ({
    id, svc: svcs[i], div: divs[i], cust: custs[i], rel: rels[i],
  }));

  // Sort: lowest priority number = winner
  rows.sort((a, b) => mergePriority(a.id) - mergePriority(b.id));

  const winner = rows[0];
  const losers = rows.slice(1);

  // Merge services from stored field + each account's own division
  const allSvcInputs = rows.flatMap(r => {
    const divSvc = divToService(r.div);
    return [r.svc, divSvc].filter(Boolean);
  });
  const mergedSvc = mergeServices(...allSvcInputs);

  // Winner keeps its related IDs + all loser IDs + all loser cust_nums
  const extraRefs = losers.flatMap(l => [l.id, l.cust].filter(Boolean));
  const mergedRel = mergeRelatedIds(winner.rel, ...extraRefs);

  return {
    winner_id:          winner.id,
    winner_div:         winner.div,
    loser_ids:          losers.map(l => l.id),
    merged_services:    mergedSvc,
    merged_related:     mergedRel,
    group_label:        `${group.norm_name} / ${group.norm_addr}`,
    original_ids:       ids,
    original_divs:      divs,
    original_services:  svcs,
    dupe_count:         ids.length,
  };
}

/** Execute one merge plan against D1. */
async function executeMerge(db, plan) {
  const now = nowTs();

  // 1 — Update winner: services + related IDs
  await db.prepare(
    `UPDATE accounts SET services = ?, related_account_ids = ?, updated_at = ? WHERE id = ?`
  ).bind(plan.merged_services, plan.merged_related, now, plan.winner_id).run();

  for (const loserId of plan.loser_ids) {
    // 2 — Remap locations
    await db.prepare(
      `UPDATE locations SET account_id = ? WHERE account_id = ?`
    ).bind(plan.winner_id, loserId).run();

    // 3 — Remap appointments
    await db.prepare(
      `UPDATE appointments SET account_id = ? WHERE account_id = ?`
    ).bind(plan.winner_id, loserId).run();

    // 4 — Remap account-linked tasks
    await db.prepare(
      `UPDATE tasks SET record_id = ? WHERE record_id = ? AND record_type = 'account'`
    ).bind(plan.winner_id, loserId).run();

    // 5 — Tombstone
    await db.prepare(
      `INSERT OR IGNORE INTO crm_tombstones
         (id, table_name, record_id, deleted_at, created_at, updated_at)
       VALUES (?, 'accounts', ?, ?, ?, ?)`
    ).bind(generateId('TOMB'), loserId, now, now, now).run();

    // 6 — Delete
    await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(loserId).run();
  }
}

/** POST /api/dedup-accounts handler. */
async function handleDedup(request, env, origin, url) {
  // Default dry_run=true for safety — must explicitly pass dry_run=false to commit
  const dryRun = url.searchParams.get('dry_run') !== 'false';
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50'),  200);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    const countRow = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT 1 FROM accounts
        WHERE name    IS NOT NULL AND TRIM(name)    != ''
          AND address IS NOT NULL AND TRIM(address) != ''
        GROUP BY UPPER(TRIM(name)), UPPER(TRIM(address))
        HAVING COUNT(*) > 1
      )
    `).first();
    const totalGroups = countRow?.total || 0;

    const groups = await findDuplicateGroups(env.DB, limit, offset);
    const plans  = groups.map(buildMergePlan);

    if (dryRun) {
      return json({
        ok:           true,
        dry_run:      true,
        total_groups: totalGroups,
        limit,
        offset,
        returned:     plans.length,
        plans: plans.map(p => ({
          group:             p.group_label,
          dupe_count:        p.dupe_count,
          winner:            p.winner_id,
          winner_div:        p.winner_div,
          losers:            p.loser_ids,
          merged_services:   p.merged_services,
          original_ids:      p.original_ids,
          original_divs:     p.original_divs,
          original_services: p.original_services,
        })),
      }, 200, origin);
    }

    // Live run
    const results = [];
    for (const plan of plans) {
      try {
        await executeMerge(env.DB, plan);
        results.push({
          group:    plan.group_label,
          winner:   plan.winner_id,
          losers:   plan.loser_ids,
          services: plan.merged_services,
          ok:       true,
        });
      } catch (e) {
        results.push({
          group:  plan.group_label,
          winner: plan.winner_id,
          losers: plan.loser_ids,
          ok:     false,
          error:  e.message,
        });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed    = results.filter(r => !r.ok).length;
    const nextOffset = offset + results.length;

    return json({
      ok:           true,
      dry_run:      false,
      total_groups: totalGroups,
      limit,
      offset,
      processed:    results.length,
      succeeded,
      failed,
      next_offset:  nextOffset,
      done:         nextOffset >= totalGroups,
      results,
    }, 200, origin);

  } catch (e) {
    return err('Dedup error: ' + e.message, 500, origin);
  }
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ch = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: ch });
    }

    const secret = request.headers.get('X-API-Secret');
    if (!env.API_SECRET || secret !== env.API_SECRET) {
      return err('Unauthorized', 401, origin);
    }

    const url   = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    // POST /api/dedup-accounts
    if (parts[0] === 'api' && parts[1] === 'dedup-accounts' && request.method === 'POST') {
      return await handleDedup(request, env, origin, url);
    }

    // POST /api/query
    if (parts[0] === 'api' && parts[1] === 'query' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.sql || !body.sql.trim().toUpperCase().startsWith('SELECT')) {
          return err('Only SELECT statements allowed via /api/query', 400, origin);
        }
        const result = await env.DB.prepare(body.sql).bind(...(body.params || [])).all();
        return json({ ok: true, results: result.results, meta: result.meta }, 200, origin);
      } catch (e) {
        return err('Query error: ' + e.message, 500, origin);
      }
    }

    if (parts[0] !== 'api' || !parts[1]) return err('Not found', 404, origin);

    const table = parts[1];
    const id    = parts[2];

    if (!ALLOWED_TABLES.has(table)) return err(`Table '${table}' not allowed`, 400, origin);

    const method = request.method;

    try {
      if (method === 'GET' && !id) {
        const params = Object.fromEntries(url.searchParams);
        const limit  = Math.min(parseInt(params.limit)  || 100, 500);
        const offset = parseInt(params.offset) || 0;
        delete params.limit; delete params.offset;

        let where = '';
        const vals = [];
        const filters = Object.entries(params).filter(([k]) => /^[a-z_]+$/.test(k));
        if (filters.length) {
          where = ' WHERE ' + filters.map(([k]) => `${k} = ?`).join(' AND ');
          filters.forEach(([, v]) => vals.push(v));
        }
        const sql = `SELECT * FROM ${table}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`;
        const result = await env.DB.prepare(sql).bind(...vals, limit, offset).all();
        return json({ ok: true, results: result.results, count: result.results.length }, 200, origin);
      }

      if (method === 'GET' && id) {
        const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
        if (!result) return err('Not found', 404, origin);
        return json({ ok: true, result }, 200, origin);
      }

      if (method === 'POST' && !id) {
        const body  = await request.json();
        const now   = nowTs();
        const newId = body.id || generateId(TABLE_PREFIX[table] || 'REC');
        const record = { ...body, id: newId, created_at: now, updated_at: now };

        const cols = Object.keys(record).filter(k => /^[a-z_]+$/.test(k));
        const vals = cols.map(k => record[k]);
        await env.DB.prepare(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        ).bind(...vals).run();

        if (table !== 'activity_log' && table !== 'notifications' && table !== 'messages') {
          const acctId = record.account_id || (table === 'accounts' ? newId : null);
          await env.DB.prepare(
            `INSERT INTO activity_log (id,entity_type,entity_id,account_id,action,created_at) VALUES (?,?,?,?,?,?)`
          ).bind(generateId('ACT'), table, newId, acctId, 'created', now).run();
        }
        return json({ ok: true, id: newId }, 201, origin);
      }

      if (method === 'PUT' && id) {
        const body    = await request.json();
        const now     = nowTs();
        const updates = { ...body, updated_at: now };
        delete updates.id; delete updates.created_at;

        const cols = Object.keys(updates).filter(k => /^[a-z_]+$/.test(k));
        const vals = cols.map(k => updates[k]);
        const result = await env.DB.prepare(
          `UPDATE ${table} SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`
        ).bind(...vals, id).run();
        if (result.meta.changes === 0) return err('Not found', 404, origin);

        if (table !== 'activity_log' && table !== 'notifications' && table !== 'messages') {
          const acctId = updates.account_id || null;
          await env.DB.prepare(
            `INSERT INTO activity_log (id,entity_type,entity_id,account_id,action,detail,created_at) VALUES (?,?,?,?,?,?,?)`
          ).bind(generateId('ACT'), table, id, acctId, 'updated', JSON.stringify(Object.keys(updates)), now).run();
        }
        return json({ ok: true, id, changes: result.meta.changes }, 200, origin);
      }

      if (method === 'DELETE' && id) {
        const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
        if (result.meta.changes === 0) return err('Not found', 404, origin);
        return json({ ok: true, id, deleted: true }, 200, origin);
      }

      return err('Method not allowed', 405, origin);

    } catch (e) {
      return err('Database error: ' + e.message, 500, origin);
    }
  },
};
