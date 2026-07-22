/**
 * Termac One -- Live Chat Worker
 * Deployed as: termac-chat.termac-one.workers.dev
 *
 * Provides real cross-device messaging for every portal that loads
 * termac-messaging.js. All messages stored in D1 (termac-crm), same
 * database every other Worker uses. No KV, no localStorage.
 *
 * D1 table: chat_messages
 *   id          TEXT PRIMARY KEY
 *   room        TEXT NOT NULL
 *   sender      TEXT NOT NULL
 *   role        TEXT
 *   text        TEXT NOT NULL
 *   ts          INTEGER NOT NULL
 *
 * Routes:
 *   GET  /health                          -> { ok: true }
 *   GET  /chat/:room?since=TS&limit=N     -> { messages: [...] }
 *   POST /chat/:room  { sender, role, text, ts } -> { ok: true, id }
 *   DELETE /chat/:room  (admin clear)     -> { ok: true, deleted: N }
 *
 * Auth: same open posture as termac-notify -- data is internal
 * routing info already visible to every logged-in portal user.
 * Swap in an Entra token check here if posture tightens.
 *
 * Message retention: 30 days. A scheduled cron purges older rows
 * once per day so the table stays lean. Cap per room: 500 messages
 * returned max; stored indefinitely until purge.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_RETURN = 200;   // messages returned per GET
const RETAIN_DAYS = 30;   // purge messages older than this
const MAX_TEXT = 2000;    // max message length

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function uid() {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function roomFromPath(pathname) {
  // /chat/all  ->  'all'
  // /chat/dm:Ted%20Scholl%20%26%20Tom%20Pittakas  ->  'dm:Ted Scholl & Tom Pittakas'
  const m = pathname.match(/\/chat\/(.+)/);
  return m ? decodeURIComponent(m[1]).slice(0, 200) : null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // Health check
    if (path === '/health') return json({ ok: true });

    // All chat routes require DB binding
    if (!env.DB) {
      return json({ error: 'DB binding not configured' }, 500);
    }

    const room = roomFromPath(path);
    if (!room) return json({ error: 'unknown route' }, 404);

    try {
      // GET /chat/:room  -- fetch messages
      if (request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get('limit') || String(MAX_RETURN), 10), MAX_RETURN);

        const { results } = await env.DB.prepare(
          'SELECT id, room, sender, role, text, ts FROM chat_messages WHERE room = ? AND ts > ? ORDER BY ts ASC LIMIT ?'
        ).bind(room, since, limit).all();

        return json({ messages: results || [] });
      }

      // POST /chat/:room  -- send a message
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) {
          return json({ error: 'invalid JSON' }, 400);
        }

        const sender = String(body.sender || '').slice(0, 100).trim();
        const role   = String(body.role   || '').slice(0, 60).trim();
        const text   = String(body.text   || '').slice(0, MAX_TEXT).trim();
        const ts     = typeof body.ts === 'number' ? body.ts : Date.now();

        if (!sender) return json({ error: 'sender required' }, 400);
        if (!text)   return json({ error: 'text required' }, 400);

        const id = uid();
        await env.DB.prepare(
          'INSERT INTO chat_messages (id, room, sender, role, text, ts) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, room, sender, role, text, ts).run();

        return json({ ok: true, id, ts });
      }

      // DELETE /chat/:room  -- admin clear (internal use only)
      if (request.method === 'DELETE') {
        const { meta } = await env.DB.prepare(
          'DELETE FROM chat_messages WHERE room = ?'
        ).bind(room).run();
        return json({ ok: true, deleted: meta.changes });
      }

      return json({ error: 'method not allowed' }, 405);

    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Daily cron: purge messages older than RETAIN_DAYS
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const cutoff = Date.now() - (RETAIN_DAYS * 24 * 60 * 60 * 1000);
    try {
      await env.DB.prepare('DELETE FROM chat_messages WHERE ts < ?').bind(cutoff).run();
    } catch (e) {
      console.error('chat purge failed:', e);
    }
  },
};
