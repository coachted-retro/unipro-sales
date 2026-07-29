/**
 * termac-hotlead-escalation — Termac One
 * Updated: 2026-07-27 per Ted Scholl
 *
 * TWO-PHASE NOTIFICATION MODEL:
 *
 * Phase 1 -- IMMEDIATE (fires on first cron cycle after lead arrives):
 *   Rep + Jim Kennedy + Tom Pittakas + Sean O'Reilly + Terence O'Reilly.
 *   Everyone sees it right away. Only the rep is responsible for responding.
 *
 * Phase 2 -- ESCALATION (30 minutes later if rep has not acted):
 *   Management only: Jim, Tom, Sean, Terence.
 *   Rep does NOT get a second blast -- they already know.
 *
 * Grace periods after rep action stop the clock:
 *   Spoke / Acknowledged -> never escalate again
 *   Lead viewed          -> 4 hours
 *   Left voicemail       -> 24 hours
 *   No answer            -> 2 hours
 *
 * Cron runs every 15 min. 30-min threshold fires on the second cycle.
 */

const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000;

const ACTION_GRACE_MS = {
  'Spoke with customer':  Infinity,
  'Acknowledged':         Infinity,
  'Lead viewed':          4 * 60 * 60 * 1000,
  'Left voicemail':       24 * 60 * 60 * 1000,
  'No answer':            2 * 60 * 60 * 1000,
};
const DEFAULT_GRACE_MS = 2 * 60 * 60 * 1000;

// EMAILS COME FROM D1 ONLY. No hardcoded lists. Ever.
// To change any email: update staff_auth in D1. Done.
async function getStaffFromD1(env) {
  const res = await d1Fetch(env, 'POST', '/db/query', {
    sql: "SELECT name, email, role, lead_escalation_cc FROM staff_auth WHERE email IS NOT NULL AND email != ''",
    params: []
  });
  if (!res.ok || !Array.isArray(res.results)) return { repMap: {}, management: [] };
  const repMap = {};
  const management = [];
  for (const s of res.results) {
    repMap[s.name] = s.email;
    // Only staff with lead_escalation_cc=1 get notified on leads
    // Sean O'Reilly, Terence O'Reilly, Tom Pittakas, Jim Kennedy -- set in D1
    if (s.lead_escalation_cc == 1) {
      management.push({ name: s.name, email: s.email });
    }
  }
  return { repMap, management };
}

async function d1Fetch(env, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Secret': env.D1_API_SECRET },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await env.D1_SERVICE.fetch(
    'https://unipro-ai-proxy.termac-one.workers.dev' + path.replace('/api/', '/db/'), opts
  );
  return await res.json();
}

async function sendNotif(env, recipientName, recipientEmail, lead, subject, notesText) {
  try {
    await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientName:  recipientName,
        recipientEmail: recipientEmail,
        caller:   lead.contact_name || lead.business || 'Unknown',
        company:  lead.business || '',
        phone:    lead.phone || '',
        notes:    notesText,
        source:   subject,
        loggedBy: 'termac-hotlead-escalation',
        lead_id:    lead.id || null,
        record_id:  lead.id || null,
        tab:        'leads',
        dest_url:   lead.id
          ? ('sales-portal.html?tab=leads&open=' + encodeURIComponent(lead.id))
          : null,
      }),
    });
  } catch (e) { /* one recipient failing never blocks others */ }
}

async function runEscalationCheck(env) {
  const now = Date.now();
  const { repMap, management: MANAGEMENT } = await getStaffFromD1(env);
  const result = await d1Fetch(env, 'GET', '/api/leads?limit=500');
  if (!result.ok || !Array.isArray(result.results)) {
    return { checked: 0, phase1: 0, phase2: 0, error: result.error || 'D1 query failed' };
  }

  let phase1Count = 0;
  let phase2Count = 0;

  for (const lead of result.results) {
    if (!lead.is_hot) continue;
    // STANDING RULE per Ted July 27 -- FINAL:
    // Management is only looped in when a lead is ACTIVELY ROUTED to a
    // salesperson by Kate (reception) or by DMS staff. That is the trigger.
    // Harvested leads, scraped leads, anything that just populates a bucket
    // for a rep to work through later -- those NEVER notify management.
    // Nobody needs to know a bucket got filled. They need to know when a
    // real human called or emailed and needs a rep to follow up NOW.
    // The signal is assigned_rep being set AND source being reception/DMS.
    const srcLower = (lead.source || '').toLowerCase();
    const isRoutedReception = srcLower.indexOf('reception') !== -1;
    const isRoutedDMS = srcLower.indexOf('dms') !== -1 || srcLower.indexOf('digital message') !== -1;
    const wasRouted = (isRoutedReception || isRoutedDMS) && !!(lead.assigned_rep);
    if (!wasRouted) continue;
    if (lead.source === 'Digital Business Card') continue;

    const ageMs   = now - (lead.created_at || now);
    const repName = lead.assigned_rep || '';
    const repEmail = repMap[repName] || null;
    const sentTo  = new Set();

    // ── PHASE 1: immediate, fires once per lead ─────────────────────────
    if (lead.is_new_lead && !lead.notified_phase1) {
      const subject  = '🔥 Hot Lead — ' + (lead.business || lead.contact_name || 'New Lead');
      const notesText = '🔥 New hot lead just came in.' +
        ' Assigned to: ' + (repName || 'Unassigned') +
        '. Source: ' + (lead.source || 'Unknown') +
        '. Address: ' + (lead.address || '—') + '.';

      if (repEmail) {
        await sendNotif(env, repName, repEmail, lead, subject, notesText);
        sentTo.add(repEmail);
      }
      for (const m of MANAGEMENT) {
        if (!sentTo.has(m.email)) {
          await sendNotif(env, m.name, m.email, lead, subject, notesText);
          sentTo.add(m.email);
        }
      }

      await d1Fetch(env, 'PUT', '/db/leads/' + lead.id, { notified_phase1: 1, is_new_lead: 0, updated_at: Date.now() });
      phase1Count++;
    }

    // ── PHASE 2: escalation if rep hasn't acted within 30 min ──────────
    if (!lead.notified_phase1) continue;
    if (lead.notified_phase2)  continue;
    if (ageMs < ESCALATION_THRESHOLD_MS) continue;

    // Check grace period if rep has acted
    if (lead.rep_action_at) {
      const grace = ACTION_GRACE_MS[lead.rep_action] !== undefined
        ? ACTION_GRACE_MS[lead.rep_action]
        : DEFAULT_GRACE_MS;
      if (grace === Infinity) continue;
      if ((now - lead.rep_action_at) < grace) continue;
    }

    const minutesWaiting = Math.round(ageMs / 60000);
    const escalateSubject = '⚠️ No Response — ' + (lead.business || lead.contact_name || 'Hot Lead');
    const escalateText = '⏰ ' + minutesWaiting + ' minutes and no response from ' +
      (repName || 'Unassigned') +
      '. Lead: ' + (lead.business || lead.contact_name || 'Unknown') +
      '. Phone: ' + (lead.phone || '—') +
      '. Source: ' + (lead.source || 'Unknown') + '.';

    for (const m of MANAGEMENT) {
      await sendNotif(env, m.name, m.email, lead, escalateSubject, escalateText);
    }

    await d1Fetch(env, 'PUT', '/db/leads/' + lead.id, { notified_phase2: 1, escalated: 1, updated_at: Date.now() });
    phase2Count++;
  }

  return { checked: result.results.length, phase1: phase1Count, phase2: phase2Count };
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
    return new Response(
      JSON.stringify({ ok: true, note: 'GET /run to trigger manually' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  },
};
