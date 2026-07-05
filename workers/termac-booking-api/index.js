/**
 * termac-booking-api — Termac One
 * Deployed: 2026-07-05
 * The ONLY worker a customer's browser talks to directly when booking an
 * appointment through a rep's Digital Business Card. Deliberately narrow:
 * it can do exactly one thing (accept a booking request), and it never
 * exposes the real termac-d1-api secret to the public — that secret lives
 * only in this worker's own environment, used for a server-to-server call
 * that a browser never sees.
 *
 * Route:
 *   POST /book   — accepts a booking request, writes it as a tagged lead
 *
 * A booking becomes a real lead in the CRM (source: "Digital Business
 * Card"), assigned to whichever rep's card the customer scanned, with the
 * requested date/time in notes and set as the follow-up date — so it lands
 * somewhere the rep already looks, rather than a new queue nobody checks.
 */

const ALLOWED_ORIGINS = [
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
  'https://coachted-retro.github.io',
];

// Real reps and the division(s) they actually sell, per Ted — used to
// validate that a submitted repId is a real card, not an arbitrary value,
// and to fill in the division tag correctly.
const VALID_REPS = {
  'ted-scholl':      { name: 'Ted Scholl',      division: 'UniPro' },
  'tom-jordan':      { name: 'Tom Jordan',      division: 'Termac' },
  // All other reps sell across the full umbrella; division gets set from
  // whichever card/page the customer was actually looking at.
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

// Basic, honest field validation — this is a public form, assume nothing
// about what arrives. No field is trusted past these checks.
function validateBooking(body) {
  const problems = [];
  const name = (body.customerName || '').trim();
  const phone = (body.customerPhone || '').trim();
  const email = (body.customerEmail || '').trim();
  const repId = (body.repId || '').trim();
  const division = (body.division || '').trim();
  const requestedDate = (body.requestedDate || '').trim();
  const notes = (body.notes || '').trim();
  // Honeypot: a real customer never fills this in; a bot filling every
  // field on the form will.
  const honeypot = (body.website || '').trim();

  if (honeypot) problems.push('Spam check failed');
  if (!name || name.length > 120) problems.push('Name is required');
  if (!phone && !email) problems.push('Phone or email is required');
  if (phone && (phone.length > 30 || !/^[\d\s().+-]+$/.test(phone))) problems.push('Phone number looks invalid');
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) problems.push('Email looks invalid');
  if (!repId) problems.push('Missing rep identifier');
  if (notes.length > 1000) problems.push('Notes too long');
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) problems.push('Requested date format invalid');

  return { valid: problems.length === 0, problems, name, phone, email, repId, division, requestedDate, notes };
}

async function d1Fetch(env, method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Secret': env.D1_API_SECRET },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(env.D1_API_URL + path, opts);
  return await res.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ch = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: ch });
    }

    const url = new URL(request.url);

    // GET /profile?rep=<slug> — public, read-only. Returns only the
    // specific fields a card displays, never the raw D1 record (no id,
    // no created_at/updated_at) and never requires the caller to hold
    // any secret.
    if (url.pathname === '/profile' && request.method === 'GET') {
      const slug = (url.searchParams.get('rep') || '').trim();
      if (!slug) return err('Missing rep parameter', 400, origin);
      try {
        const result = await d1Fetch(env, 'GET', '/api/rep_cards?rep_slug=' + encodeURIComponent(slug));
        if (!result.ok || !Array.isArray(result.results) || result.results.length === 0) {
          return err('Profile not found', 404, origin);
        }
        const r = result.results[0];
        const publicProfile = {
          name: r.name || '', title: r.title || '',
          divisions: r.divisions ? r.divisions.split(',').map(s => s.trim()).filter(Boolean) : [],
          phone: r.phone || '', email: r.email || '', linkedin: r.linkedin || '',
          bio: r.bio || '', serviceArea: r.service_area || '',
          yearsExperience: r.years_experience || null,
        };
        return json({ ok: true, profile: publicProfile }, 200, origin);
      } catch (e) {
        return err('Profile service unavailable: ' + e.message, 502, origin);
      }
    }

    if (url.pathname !== '/book' || request.method !== 'POST') {
      return err('Not found', 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return err('Invalid request body', 400, origin);
    }

    const v = validateBooking(body);
    if (!v.valid) {
      return err(v.problems.join('; '), 400, origin);
    }

    const repInfo = VALID_REPS[v.repId];
    const repName = repInfo ? repInfo.name : v.repId;
    const division = v.division || (repInfo ? repInfo.division : 'UniPro');

    const notesParts = [];
    if (v.requestedDate) notesParts.push('Requested appointment date: ' + v.requestedDate);
    if (v.notes) notesParts.push('Customer notes: ' + v.notes);
    const fullNotes = 'Booked via Digital Business Card (' + repName + ').' +
      (notesParts.length ? ' ' + notesParts.join(' | ') : '');

    const leadRecord = {
      contact_name: v.name,
      phone: v.phone || null,
      email: v.email || null,
      division: division,
      assigned_rep: repName,
      source: 'Digital Business Card',
      notes: fullNotes,
      follow_up_date: v.requestedDate || null,
      lifecycle_stage: 'lead',
    };

    try {
      const result = await d1Fetch(env, 'POST', '/api/leads', leadRecord);
      if (!result.ok) {
        return err('Could not save booking: ' + (result.error || 'unknown error'), 502, origin);
      }
      return json({ ok: true, message: 'Booking request received' }, 201, origin);
    } catch (e) {
      return err('Booking service unavailable: ' + e.message, 502, origin);
    }
  },
};
