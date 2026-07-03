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
 *
 * Auth: API_SECRET header must match env.API_SECRET
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
  'notifications', 'messages',
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
  messages: 'MSG',
};

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

        // Log activity (skip for activity_log itself to avoid recursion)
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
