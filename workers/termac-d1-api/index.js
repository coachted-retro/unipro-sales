/**
 * termac-d1-api — Termac One
 * RESTful API layer over the termac-crm D1 database.
 * All platform portals call this Worker instead of localStorage.
 *
 * Routes:
 *   GET    /api/:table               list (supports ?limit=&offset=&[col]=val)
 *   GET    /api/:table/:id           get by id
 *   POST   /api/:table               insert
 *   PUT    /api/:table/:id           update
 *   DELETE /api/:table/:id           delete
 *   POST   /api/query                raw SELECT (read-only, for complex joins)
 *   POST   /api/dedup-accounts       deduplicate accounts by name+address
 *                                    ?dry_run=true  → report only, no changes
 *                                    ?limit=50&offset=0 for batched live runs
 */

const ALLOWED_ORIGINS = [
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

function nowTs() {
  return Date.now();
}

function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
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
// Account deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Priority for which account record survives a merge.
 * Lower number = higher priority (wins).
 *
 * Priority order:
 *   0 — bare Termac legacy IDs  (e.g. BA1534, CU310J — letters+digits, no dash prefix)
 *   1 — ST-  (app-generated Termac One IDs)
 *   2 — GTO-
 *   3 — FM- / FilterMan-
 *   4 — UNI-  (UniPro bulk import — lowest priority)
 *   5 — everything else
 */
function mergePriority(id) {
  if (!id) return 5;
  // Bare Termac legacy: 2-4 uppercase letters + digits (+ optional trailing letter)
  // e.g. BA1534, CU310J, AM323J, GTO-prefixed already handled below
  if (/^[A-Z]{2,4}\d+[A-Z]?$/.test(id)) return 0;
  if (id.startsWith('ST-'))        return 1;
  if (id.startsWith('GTO-'))       return 2;
  if (id.startsWith('FM-'))        return 3;
  if (id.startsWith('FilterMan-')) return 3;
  if (id.startsWith('UNI-'))       return 4;
  return 5;
}

/**
 * Merge two JSON-encoded services arrays (strings) into a deduplicated sorted array.
 * Returns the merged JSON string.
 */
function mergeServices(...svcStrings) {
  const seen = new Set();
  const order = ['Termac', 'UniPro', 'GTO', 'FilterMan', 'AllPro'];
  for (const s of svcStrings) {
    if (!s || s === 'null') continue;
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) arr.forEach(v => seen.add(v));
    } catch (_) {}
  }
  // Sort by canonical order, then alphabetically for unknowns
  const out = [...seen].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return JSON.stringify(out);
}

/**
 * Merge two JSON-encoded related_account_ids arrays.
 * Adds all loser IDs to the winner's list, deduplicated.
 */
function mergeRelatedIds(existingStr, ...addIds) {
  let existing = [];
  try { existing = JSON.parse(existingStr || '[]') || []; } catch (_) {}
  const merged = new Set(existing);
  addIds.forEach(id => { if (id) merged.add(id); });
  return JSON.stringify([...merged]);
}

/**
 * Find duplicate account groups (exact name + address match).
 * Returns rows with: norm_name, norm_addr, ids (pipe-separated), services (pipe-separated).
 */
async function findDuplicateGroups(db, limit, offset) {
  const sql = `
    SELECT
      UPPER(TRIM(name))    AS norm_name,
      UPPER(TRIM(address)) AS norm_addr,
      COUNT(*)             AS dupes,
      GROUP_CONCAT(id,          '|||') AS ids,
      GROUP_CONCAT(COALESCE(division,'?'), '|||') AS divisions,
      GROUP_CONCAT(COALESCE(services,'null'), '|||') AS all_services,
      GROUP_CONCAT(COALESCE(cust_num,''), '|||') AS cust_nums,
      GROUP_CONCAT(COALESCE(related_account_ids,'[]'), '|||') AS all_related
    FROM accounts
    WHERE name    IS NOT NULL AND TRIM(name)    != ''
      AND address IS NOT NULL AND TRIM(address) != ''
    GROUP BY UPPER(TRIM(name)), UPPER(TRIM(address))
    HAVING COUNT(*) > 1
    ORDER BY dupes DESC
    LIMIT ? OFFSET ?
  `;
  const result = await db.prepare(sql).bind(limit, offset).all();
  return result.results || [];
}

/**
 * Process one duplicate group: determine winner, build merge plan.
 * Returns { winner_id, loser_ids, merged_services, merged_related_ids, group_label }
 */
function buildMergePlan(group) {
  const ids       = group.ids.split('|||');
  const svcs      = group.all_services.split('|||');
  const custNums  = group.cust_nums.split('|||');
  const related   = group.all_related.split('|||');

  // Sort by priority; lowest number wins
  const indexed = ids.map((id, i) => ({ id, svc: svcs[i], cust: custNums[i], rel: related[i] }));
  indexed.sort((a, b) => mergePriority(a.id) - mergePriority(b.id));

  const winner = indexed[0];
  const losers = indexed.slice(1);

  const mergedSvc     = mergeServices(...indexed.map(r => r.svc));
  // Winner keeps its own related IDs + gains all loser IDs + all loser cust_nums as references
  const extraRefs     = losers.flatMap(l => [l.id, l.cust].filter(Boolean));
  const mergedRelated = mergeRelatedIds(winner.rel, ...extraRefs);

  return {
    winner_id:         winner.id,
    loser_ids:         losers.map(l => l.id),
    merged_services:   mergedSvc,
    merged_related:    mergedRelated,
    group_label:       `${group.norm_name} / ${group.norm_addr}`,
    original_ids:      ids,
    original_services: svcs,
  };
}

/**
 * Execute one merge plan against the database.
 * - Updates winner's services + related_account_ids
 * - Remaps locations.account_id and appointments.account_id from losers → winner
 * - Inserts losers into crm_tombstones
 * - Deletes losers from accounts
 */
async function executeMerge(db, plan) {
  const now = nowTs();

  // 1. Update winner
  await db.prepare(
    `UPDATE accounts SET services = ?, related_account_ids = ?, updated_at = ? WHERE id = ?`
  ).bind(plan.merged_services, plan.merged_related, now, plan.winner_id).run();

  for (const loserId of plan.loser_ids) {
    // 2. Remap locations
    await db.prepare(
      `UPDATE locations SET account_id = ? WHERE account_id = ?`
    ).bind(plan.winner_id, loserId).run();

    // 3. Remap appointments
    await db.prepare(
      `UPDATE appointments SET account_id = ? WHERE account_id = ?`
    ).bind(plan.winner_id, loserId).run();

    // 4. Remap tasks (record_id for account-linked tasks)
    await db.prepare(
      `UPDATE tasks SET record_id = ? WHERE record_id = ? AND record_type = 'account'`
    ).bind(plan.winner_id, loserId).run();

    // 5. Tombstone the loser
    await db.prepare(
      `INSERT OR IGNORE INTO crm_tombstones (id, table_name, record_id, deleted_at, created_at, updated_at)
       VALUES (?, 'accounts', ?, ?, ?, ?)`
    ).bind(generateId('TOMB'), loserId, now, now, now).run();

    // 6. Delete loser
    await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(loserId).run();
  }
}

/**
 * Main dedup handler.
 * POST /api/dedup-accounts?dry_run=true|false&limit=50&offset=0
 */
async function handleDedup(request, env, origin, url) {
  const dryRun = url.searchParams.get('dry_run') !== 'false'; // default true for safety
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50'), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    // Count total groups for progress reporting
    const countResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT 1 FROM accounts
        WHERE name IS NOT NULL AND TRIM(name) != ''
          AND address IS NOT NULL AND TRIM(address) != ''
        GROUP BY UPPER(TRIM(name)), UPPER(TRIM(address))
        HAVING COUNT(*) > 1
      )
    `).first();
    const totalGroups = countResult?.total || 0;

    const groups = await findDuplicateGroups(env.DB, limit, offset);
    const plans  = groups.map(buildMergePlan);

    if (dryRun) {
      // Dry run: return the plan, touch nothing
      return json({
        ok:           true,
        dry_run:      true,
        total_groups: totalGroups,
        limit,
        offset,
        returned:     plans.length,
        plans:        plans.map(p => ({
          group:             p.group_label,
          winner:            p.winner_id,
          losers:            p.loser_ids,
          merged_services:   p.merged_services,
          original_ids:      p.original_ids,
          original_services: p.original_services,
        })),
      }, 200, origin);
    }

    // Live run: execute each plan
    const results = [];
    for (const plan of plans) {
      try {
        await executeMerge(env.DB, plan);
        results.push({ group: plan.group_label, winner: plan.winner_id, losers: plan.loser_ids, ok: true });
      } catch (e) {
        results.push({ group: plan.group_label, winner: plan.winner_id, losers: plan.loser_ids, ok: false, error: e.message });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed    = results.filter(r => !r.ok).length;

    return json({
      ok:           true,
      dry_run:      false,
      total_groups: totalGroups,
      limit,
      offset,
      processed:    results.length,
      succeeded,
      failed,
      next_offset:  offset + results.length,
      done:         (offset + results.length) >= totalGroups,
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

    // Auth check
    const secret = request.headers.get('X-API-Secret');
    if (!env.API_SECRET || secret !== env.API_SECRET) {
      return err('Unauthorized', 401, origin);
    }

    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\//, '').split('/');

    // POST /api/dedup-accounts
    if (parts[0] === 'api' && parts[1] === 'dedup-accounts' && request.method === 'POST') {
      return await handleDedup(request, env, origin, url);
    }

    // POST /api/query — raw SELECT
    if (parts[0] === 'api' && parts[1] === 'query' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.sql || !body.sql.trim().toUpperCase().startsWith('SELECT')) {
          return err('Only SELECT statements allowed via /api/query', 400, origin);
        }
        const result = await env.DB.prepare(body.sql)
          .bind(...(body.params || []))
          .all();
        return json({ ok: true, results: result.results, meta: result.meta }, 200, origin);
      } catch (e) {
        return err('Query error: ' + e.message, 500, origin);
      }
    }

    if (parts[0] !== 'api' || !parts[1]) {
      return err('Not found', 404, origin);
    }

    const table = parts[1];
    const id = parts[2];

    if (!ALLOWED_TABLES.has(table)) {
      return err(`Table '${table}' not allowed`, 400, origin);
    }

    const method = request.method;

    try {
      // GET /api/:table
      if (method === 'GET' && !id) {
        const params = Object.fromEntries(url.searchParams);
        const limit = Math.min(parseInt(params.limit) || 100, 500);
        const offset = parseInt(params.offset) || 0;
        delete params.limit;
        delete params.offset;

        let where = '';
        const vals = [];
        const filters = Object.entries(params).filter(([k]) =>
          /^[a-z_]+$/.test(k)
        );
        if (filters.length) {
          where = ' WHERE ' + filters.map(([k]) => `${k} = ?`).join(' AND ');
          filters.forEach(([, v]) => vals.push(v));
        }

        const sql = `SELECT * FROM ${table}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`;
        const result = await env.DB.prepare(sql)
          .bind(...vals, limit, offset)
          .all();
        return json({ ok: true, results: result.results, count: result.results.length }, 200, origin);
      }

      // GET /api/:table/:id
      if (method === 'GET' && id) {
        const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
          .bind(id)
          .first();
        if (!result) return err('Not found', 404, origin);
        return json({ ok: true, result }, 200, origin);
      }

      // POST /api/:table
      if (method === 'POST' && !id) {
        const body = await request.json();
        const now = nowTs();
        const newId = body.id || generateId(TABLE_PREFIX[table] || 'REC');
        const record = { ...body, id: newId, created_at: now, updated_at: now };

        const cols = Object.keys(record).filter(k => /^[a-z_]+$/.test(k));
        const vals = cols.map(k => record[k]);
        const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;

        await env.DB.prepare(sql).bind(...vals).run();

        if (table !== 'activity_log' && table !== 'notifications' && table !== 'messages') {
          const acctId = record.account_id || (table === 'accounts' ? newId : null);
          await env.DB.prepare(
            `INSERT INTO activity_log (id,entity_type,entity_id,account_id,action,created_at) VALUES (?,?,?,?,?,?)`
          ).bind(generateId('ACT'), table, newId, acctId, 'created', now).run();
        }

        return json({ ok: true, id: newId }, 201, origin);
      }

      // PUT /api/:table/:id
      if (method === 'PUT' && id) {
        const body = await request.json();
        const now = nowTs();
        const updates = { ...body, updated_at: now };
        delete updates.id;
        delete updates.created_at;

        const cols = Object.keys(updates).filter(k => /^[a-z_]+$/.test(k));
        const vals = cols.map(k => updates[k]);
        const sql = `UPDATE ${table} SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;

        const result = await env.DB.prepare(sql).bind(...vals, id).run();
        if (result.meta.changes === 0) return err('Not found', 404, origin);

        if (table !== 'activity_log' && table !== 'notifications' && table !== 'messages') {
          const acctId = updates.account_id || null;
          await env.DB.prepare(
            `INSERT INTO activity_log (id,entity_type,entity_id,account_id,action,detail,created_at) VALUES (?,?,?,?,?,?,?)`
          ).bind(generateId('ACT'), table, id, acctId, 'updated', JSON.stringify(Object.keys(updates)), now).run();
        }

        return json({ ok: true, id, changes: result.meta.changes }, 200, origin);
      }

      // DELETE /api/:table/:id
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
