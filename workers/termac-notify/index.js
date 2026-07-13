/**
 * Termac One — Cross-Device Notification Bridge Worker
 * Deploy to: Cloudflare Workers  (suggested name: termac-notify → termac-notify.termac-one.workers.dev)
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
 *   4. Settings → Variables and secrets → Add → Secret
 *        Name: RESEND_API_KEY      Value: (the real key from resend.com)
 *   5. Deploy again. Done.
 *
 * Routes:
 *   GET  /health                                  -> { ok: true }
 *   POST /notify        { recipientName, recipientEmail, ccEmails, caller,
 *                         company, phone, notes, source, loggedBy, id, ts }
 *                                                 -> { ok: true, emailSent }
 *   GET  /notify?recipient=NAME&since=TS          -> { notifications: [...] }
 *        Loose recipient match: "Ted Scholl" matches "Ted Scholl (Direct)".
 *
 * Storage model: one KV key per recipient (normalized), holding the most
 * recent 50 notifications, 7-day TTL refreshed on every write. No PII
 * beyond what's already in the CRM; no auth because the data is the same
 * routing info already visible to every logged-in portal user. If that
 * posture changes at Azure go-live, swap in an Entra-validated token here.
 *
 * 2026-07-10 UPDATE: every notification now ALSO sends a real email via
 * Resend when the caller provides a recipientEmail, not just the in-app
 * bell — per Ted, someone who isn't actively watching the app still
 * needs to know a hot lead came in. Email sending never blocks or fails
 * the in-app notification write; if RESEND_API_KEY isn't configured, or
 * the send fails, or no recipientEmail was given, the in-app side still
 * completes normally. Sends from mytermac.com (verified in Resend) —
 * swap FROM_ADDRESS below the day termac.com's own DNS is finally
 * verified through Altek.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FROM_ADDRESS = 'Termac One Alerts <alerts@mytermac.com>';

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

// Fire-and-forget style, but awaited so we can report success/failure back
// to the caller — never throws, always resolves to true/false.
async function sendEmail(env, notif) {
  if (!env.RESEND_API_KEY) return false;
  if (!notif.recipientEmail) return false;

  const subject = notif.source === 'Digital Business Card' || notif.notes.indexOf('🔥') === 0
    ? '🔥 New hot lead: ' + (notif.caller || 'Unknown')
    : 'Termac One notification: ' + (notif.caller || 'Unknown');

  const lines = [
    '<p><strong>' + escapeHtml(notif.caller || 'Unknown') + '</strong></p>',
    notif.company ? '<p>Company: ' + escapeHtml(notif.company) + '</p>' : '',
    notif.phone ? '<p>Phone: ' + escapeHtml(notif.phone) + '</p>' : '',
    notif.notes ? '<p>' + escapeHtml(notif.notes) + '</p>' : '',
    '<p style="color:#6B7280;font-size:13px">Source: ' + escapeHtml(notif.source || 'Termac One') + '</p>',
    '<p style="color:#6B7280;font-size:13px">Check your dashboard for full details.</p>',
  ].filter(Boolean).join('');

  const payload = {
    from: FROM_ADDRESS,
    to: [notif.recipientEmail],
    subject: subject,
    html: lines,
  };
  if (Array.isArray(notif.ccEmails) && notif.ccEmails.length) {
    payload.cc = notif.ccEmails.filter(e => e && e !== notif.recipientEmail);
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// General-purpose version of sendEmail above, for scheduled reports
// rather than single lead-routing notifications -- same Resend account/
// key, just a plain {recipients, subject, html} shape instead of the
// single-notification one. Added 2026-07-13 for the Report Settings
// admin tab (report_settings table in termac-crm), called from
// unipro-ai-proxy's hourly cron when a report's configured send time
// matches the current hour.
async function sendReportEmail(env, recipients, subject, html) {
  if (!env.RESEND_API_KEY) return false;
  if (!Array.isArray(recipients) || !recipients.length) return false;
  const payload = { from: FROM_ADDRESS, to: recipients, subject, html };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path.endsWith('/health')) return json({ ok: true });

    if (path.endsWith('/send-report') && request.method === 'POST') {
      const body = await request.json();
      if (!Array.isArray(body.recipients) || !body.recipients.length) {
        return json({ error: 'recipients (array) required' }, 400);
      }
      if (!body.subject || !body.html) {
        return json({ error: 'subject and html required' }, 400);
      }
      const sent = await sendReportEmail(env, body.recipients, body.subject, body.html);
      return json({ ok: sent, emailSent: sent });
    }

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
          recipientEmail: body.recipientEmail || '',
          ccEmails: Array.isArray(body.ccEmails) ? body.ccEmails : [],
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

        const emailSent = await sendEmail(env, notif);
        return json({ ok: true, id: notif.id, emailSent });
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
