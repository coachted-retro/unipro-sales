/**
 * termac-photo-upload — Termac One
 * Handles uploads to two R2 buckets:
 *   termac-photos  (PHOTOS binding)  — field photos, visit photos
 *   allpro-job-docs (JOB_DOCS binding) — proposals, cost sheets, internal docs, job bundles
 *
 * POST body: { bucket, key, base64, contentType }
 *   bucket: 'photos' | 'job-docs'
 *   key: path within bucket e.g. 'CAP-CWC-001/proposals/CAP-CWC-001.pdf'
 *
 * Returns: { ok: true, url } | { ok: false, error }
 */

const PUBLIC_BASES = {
  photos:   'https://pub-d1578de45ac446e1b94b0d5956f367e2.r2.dev',
  'job-docs': 'https://pub-69004395a9774054a5ab572bc9a0755a.r2.dev',
};

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

function respond(data, status, origin) {
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
      return respond({ ok: false, error: 'POST only' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ ok: false, error: 'Invalid JSON' }, 400, origin);
    }

    const { bucket = 'photos', key, base64: b64Data, contentType } = body;

    if (!key || !b64Data || !contentType) {
      return respond({ ok: false, error: 'Missing required fields: key, base64, contentType' }, 400, origin);
    }

    // Select bucket
    const r2 = bucket === 'job-docs' ? env.JOB_DOCS : env.PHOTOS;
    const publicBase = PUBLIC_BASES[bucket] || PUBLIC_BASES.photos;

    if (!r2) {
      return respond({ ok: false, error: 'Bucket not available: ' + bucket }, 500, origin);
    }

    let bytes;
    try {
      const raw = b64Data.includes(',') ? b64Data.split(',')[1] : b64Data;
      bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    } catch {
      return respond({ ok: false, error: 'Invalid base64 data' }, 400, origin);
    }

    try {
      await r2.put(key, bytes, { httpMetadata: { contentType } });
    } catch (err) {
      return respond({ ok: false, error: 'R2 upload failed: ' + err.message }, 500, origin);
    }

    const url = `${publicBase}/${key}`;
    return respond({ ok: true, url, key, bucket }, 200, origin);
  },
};
