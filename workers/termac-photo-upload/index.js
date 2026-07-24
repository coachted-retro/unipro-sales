/**
 * termac-photo-upload — Termac One
 * Accepts base64-encoded photos from browser portals and stores them
 * in the termac-photos R2 bucket. Returns the public CDN URL.
 *
 * POST body: { accountId, key, base64, contentType }
 * Returns:   { ok: true, url } | { ok: false, error }
 *
 * R2 bucket: termac-photos (bound as PHOTOS)
 * Public base: https://pub-d1578de45ac446e1b94b0d5956f367e2.r2.dev
 */

const PUBLIC_BASE = 'https://pub-d1578de45ac446e1b94b0d5956f367e2.r2.dev';
const ALLOWED_ORIGINS = [
  'https://sales.mytermac.com',
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
  'https://coachted-retro.github.io',
];

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'POST only' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400, origin);
    }

    const { accountId, key, base64, contentType } = body;

    if (!accountId || !key || !base64 || !contentType) {
      return json({ ok: false, error: 'Missing required fields: accountId, key, base64, contentType' }, 400, origin);
    }

    // Build R2 key: {accountId}/{key}
    const r2Key = `${accountId}/${key}`;

    let bytes;
    try {
      const raw = base64.includes(',') ? base64.split(',')[1] : base64;
      bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    } catch {
      return json({ ok: false, error: 'Invalid base64 data' }, 400, origin);
    }

    try {
      await env.PHOTOS.put(r2Key, bytes, {
        httpMetadata: { contentType },
      });
    } catch (err) {
      return json({ ok: false, error: 'R2 upload failed: ' + err.message }, 500, origin);
    }

    const url = `${PUBLIC_BASE}/${r2Key}`;
    return json({ ok: true, url, key: r2Key }, 200, origin);
  },
};
