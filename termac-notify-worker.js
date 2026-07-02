/**
 * Termac One — Cross-Device Notification Bridge Worker
 * Deploy to: Cloudflare Workers  (suggested name: termac-notify → termac-notify.tedscholl.workers.dev)
 *
 * Purpose: when reception (or anyone) routes a call or lead to a person,
 * the notification needs to reach that person's device — not just the
 * device it was logged on. This Worker is the shared mailbox: senders
 * POST notifications here; every portal polls for its logged-in user's
 * notifications every 30 seconds and fires the local banner/badge.
 *
 * REQUIRED SETUP (one time, Cloudflare dashboard):
 *   1. Workers & Pages → Create Worker → name it termac-notify → paste this file → Deploy
 *   2. Storage & Databases → KV → Create namespace → name it TERMAC_NOTIFS
 *   3. Back on the Worker → Settings → Bindings → Add → KV Namespace
 *        Variable name: NOTIFS      KV namespace: TERMAC_NOTIFS
 *   4. Deploy again. Done.
 *
 * Routes:
 *   GET  /health                                  -> { ok: true }
 *   POST /notify        { recipientName, caller, company, phone, notes,
 *                         source, loggedBy, id, ts }
 *                                                 -> { ok: true }
 *   GET  /notify?recipient=NAME&since=TS          -> { notifications: [...] }
 *        Loose recipient match: "Ted Scholl" matches "Ted Scholl (Direct)".
 *
 * Storage model: one KV key per recipient (normalized), holding the most
 * recent 50 notifications, 7-day TTL refreshed on every write. No PII
 * beyond what's already in the CRM; no auth because the data is the same
 * routing info already visible to every logged-in portal user. If that
 * posture changes at Azure go-live, swap in an Entra-validated token here.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// "Ted Scholl (Direct)" and "ted scholl" both normalize to "ted scholl"
function normName(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path.endsWith('/health')) return json({ ok: true });

    if (!env.NOTIFS) {
      return json({ error: 'KV binding NOTIFS not configured — see setup steps in the worker source' }, 500);
    }

    try {
      if (path.endsWith('/notify') && request.method === 'POST') {
        const body = await request.json();
        const recipient = normName(body.recipientName);
        if (!recipient) return json({ error: 'recipientName required' }, 400);

        const key = 'notifs:' + recipient;
        let list = [];
        try { list = JSON.parse((await env.NOTIFS.get(key)) || '[]'); } catch (e) {}

        const notif = {
          id: body.id || ('HL' + Date.now() + Math.random().toString(36).slice(2, 6)),
          recipientName: body.recipientName || '',
          caller: body.caller || '',
          company: body.company || '',
          phone: body.phone || '',
          notes: (body.notes || '').slice(0, 500),
          source: body.source || 'Termac One',
          loggedBy: body.loggedBy || '',
          ts: body.ts || Date.now(),
        };
        // Dedupe by id, newest first, cap at 50
        list = [notif, ...list.filter(n => n.id !== notif.id)].slice(0, 50);
        await env.NOTIFS.put(key, JSON.stringify(list), { expirationTtl: 7 * 24 * 3600 });
        return json({ ok: true, id: notif.id });
      }

      if (path.endsWith('/notify') && request.method === 'GET') {
        const recipient = normName(url.searchParams.get('recipient'));
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        if (!recipient) return json({ error: 'recipient required' }, 400);

        let list = [];
        try { list = JSON.parse((await env.NOTIFS.get('notifs:' + recipient)) || '[]'); } catch (e) {}
        return json({ notifications: list.filter(n => (n.ts || 0) > since) });
      }

      return json({ error: 'unknown route' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
