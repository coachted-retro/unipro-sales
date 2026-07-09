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
  'townships','quality_complaints',
]);

const TABLE_PREFIX = {
  users:'USR', companies:'CO', locations:'LOC', accounts:'ACC',
  contacts:'CON', leads:'LED', opportunities:'OPP', bids:'BID',
  jobs:'JOB', deficiencies:'DEF', collections:'COL',
  scheduler_queue:'SCH', activity_log:'ACT', notifications:'NOT',
  messages:'MSG', rep_cards:'REP', warehouse_inventory:'WHI', dms_coldcall:'DMS',
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
  }
};
// redeploy trigger 1783634118
