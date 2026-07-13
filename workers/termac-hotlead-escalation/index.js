/**
 * termac-hotlead-escalation — Termac One
 * Deployed: 2026-07-10
 *
 * Purpose: if a hot inbound lead (Digital Business Card, harvester, DMS,
 * eventually website) sits unaddressed for too long, Jim Kennedy and Tom
 * Pittakas get notified so a rep isn't silently sitting on a real
 * opportunity. Per Ted: 60-minute threshold, both get notified.
 *
 * "Unaddressed" = is_hot = 1 AND is_new_lead = 1. is_new_lead gets
 * cleared automatically the moment a rep actually opens the lead in
 * sales-portal.html (see spViewRecord) -- so this reuses that existing
 * signal rather than inventing a new one.
 *
 * Runs on a Cloudflare Cron Trigger (see wrangler.toml, every 15 minutes)
 * so this fires even if nobody has the app open — a closed browser
 * should never be the reason an escalation doesn't happen. Also exposes
 * a GET /run route for manual testing without waiting for the schedule.
 *
 * Talks to termac-notify over a Service Binding (env.NOTIFY_SERVICE), not
 * a raw fetch to its public *.workers.dev URL — same reason as
 * termac-booking-api: Cloudflare blocks worker-to-worker fetch() to
 * public workers.dev URLs (error 1042, not JSON). Do not revert this to
 * a plain fetch(...) call.
 */

const ESCALATION_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes, per Ted
// 2026-07-12: Jim + Tom pulled off lead notifications for now per Ted, while
// DMS gets populated with a large batch of new leads (would otherwise spam
// them). Cron still runs and still marks leads escalated, it just has
// nobody to notify. Restore by uncommenting the two lines below.
const ESCALATION_RECIPIENTS = [
  // { name: 'Jim Kennedy', email: 'jkennedy@termac.com' },
  // { name: 'Tom Pittakas', email: 'tpittakas@termac.com' },
];

async function d1Fetch(env, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Secret': env.D1_API_SECRET },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await env.D1_SERVICE.fetch('https://unipro-ai-proxy.termac-one.workers.dev' + path.replace('/api/', '/db/'), opts);
  return await res.json();
}

async function notify(env, recipient, lead, minutesWaiting) {
  try {
    await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        caller: lead.contact_name || lead.business || 'Unknown',
        company: lead.business || '',
        phone: lead.phone || '',
        notes: '⏰ Hot lead sitting unaddressed for ' + minutesWaiting + ' min. Assigned to: ' +
          (lead.assigned_rep || 'Unassigned') + '. Source: ' + (lead.source || 'Unknown') + '.',
        source: 'Hot Lead Escalation',
        loggedBy: 'termac-hotlead-escalation',
      }),
    });
  } catch (e) { /* one recipient failing should never block the other or the DB update */ }
}

async function runEscalationCheck(env) {
  const cutoff = Date.now() - ESCALATION_THRESHOLD_MS;
  const result = await d1Fetch(env, 'GET', '/api/leads?limit=500');
  if (!result.ok || !Array.isArray(result.results)) {
    return { checked: 0, escalated: 0, error: result.error || 'D1 query failed' };
  }

  const stale = result.results.filter(lead =>
    lead.is_hot &&
    lead.is_new_lead &&
    !lead.escalated &&
    (lead.created_at || 0) < cutoff &&
    // 2026-07-12, per Ted: a Digital Business Card booking is a rep's own
    // self-harvested lead, not a corporate/DMS-sourced lead management
    // needs oversight on. This is a permanent exclusion, not part of the
    // "Jim/Tom paused for now" change above -- even once recipients are
    // restored, these should never escalate to managers.
    lead.source !== 'Digital Business Card'
  );

  for (const lead of stale) {
    const minutesWaiting = Math.round((Date.now() - (lead.created_at || Date.now())) / 60000);
    for (const recipient of ESCALATION_RECIPIENTS) {
      await notify(env, recipient, lead, minutesWaiting);
    }
    // Mark escalated so this doesn't re-fire every 15 minutes forever.
    await d1Fetch(env, 'PUT', '/api/leads/' + lead.id, { escalated: 1 });
  }

  return { checked: result.results.length, escalated: stale.length };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEscalationCheck(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runEscalationCheck(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, note: 'GET /run to manually trigger a check' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
