/**
 * termac-vault-docs — Termac One
 * Stores and retrieves the actual compliance document files (W-9, COI,
 * license PDFs) for the Bid Vault. This is the piece that was missing —
 * the Company Vault already stores the *data* extracted from these
 *
 * 2026-07-13: same deploy-pipeline gap as bid-scraper — this worker
 * was pushed but never in the CI deploy list, so it was never actually
 * live despite the code being correct. Added to the list in
 * .github/workflows/deploy-workers.yml in the same commit as this note.
 * documents (EINs, policy numbers, expiration dates); this worker stores
 * the real files themselves so a bid bundle can actually include them.
 *
 * Bucket: termac-bid-vault-docs (bound as VAULT_DOCS) — deliberately has
 * NO public r2.dev URL, unlike termac-photos. These are compliance/
 * financial documents, not marketing photos, so nothing here is fetchable
 * without the shared secret. This matches the same practical security
 * posture already used everywhere else in this platform (the shared
 * X-API-Secret header on the D1 API) — not enterprise-grade auth, but a
 * real step up from "no file storage at all," and consistent with what's
 * already deployed rather than inventing a new, heavier standard here.
 *
 * POST /upload  { docType, label, base64, contentType, filename }
 *   -> { ok: true, key, url }
 * GET  /doc?key=...&secret=...
 *   -> streams the file back with correct content-type
 * GET  /list?docType=...  (header X-API-Secret)
 *   -> { ok: true, files: [{ key, docType, label, filename, uploadedAt, size }] }
 * DELETE /doc?key=...  (header X-API-Secret)
 *   -> { ok: true }
 */

const SHARED_SECRET = 'termac2026'; // same secret already used by the D1 API — see note above
const ALLOWED_ORIGINS = [
  'https://unipro-sales.pages.dev',
  'https://my.termac.com',
  'https://coachted-retro.github.io',
];
const ALLOWED_DOC_TYPES = ['w9', 'coi', 'license', 'bonding', 'other'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function checkSecret(request, url) {
  const headerSecret = request.headers.get('X-API-Secret');
  const querySecret = url.searchParams.get('secret');
  return headerSecret === SHARED_SECRET || querySecret === SHARED_SECRET;
}

function base64ToBytes(base64) {
  const binary = atob(base64.replace(/^data:[^;]+;base64,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!checkSecret(request, url)) {
      return json({ ok: false, error: 'Unauthorized' }, 401, origin);
    }

    // ── UPLOAD ──
    if (request.method === 'POST' && url.pathname === '/upload') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON' }, 400, origin);
      }
      const { docType, label, base64, contentType, filename } = body;
      if (!docType || !base64 || !contentType || !filename) {
        return json({ ok: false, error: 'Missing required fields: docType, base64, contentType, filename' }, 400, origin);
      }
      if (!ALLOWED_DOC_TYPES.includes(docType)) {
        return json({ ok: false, error: `docType must be one of: ${ALLOWED_DOC_TYPES.join(', ')}` }, 400, origin);
      }

      const bytes = base64ToBytes(base64);
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `vault/${docType}/${Date.now()}-${safeFilename}`;

      try {
        await env.VAULT_DOCS.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: {
            docType,
            label: label || '',
            filename: safeFilename,
            uploadedAt: String(Date.now()),
          },
        });
        return json({ ok: true, key, url: `${url.origin}/doc?key=${encodeURIComponent(key)}` }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, origin);
      }
    }

    // ── RETRIEVE / STREAM ──
    if (request.method === 'GET' && url.pathname === '/doc') {
      const key = url.searchParams.get('key');
      if (!key) return json({ ok: false, error: 'Missing key' }, 400, origin);
      try {
        const object = await env.VAULT_DOCS.get(key);
        if (!object) return json({ ok: false, error: 'Not found' }, 404, origin);
        const headers = new Headers(corsHeaders(origin));
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `inline; filename="${object.customMetadata?.filename || 'document'}"`);
        return new Response(object.body, { headers });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, origin);
      }
    }

    // ── LIST ──
    if (request.method === 'GET' && url.pathname === '/list') {
      const docType = url.searchParams.get('docType');
      const prefix = docType ? `vault/${docType}/` : 'vault/';
      try {
        const listed = await env.VAULT_DOCS.list({ prefix });
        const files = listed.objects.map((o) => ({
          key: o.key,
          docType: o.customMetadata?.docType || '',
          label: o.customMetadata?.label || '',
          filename: o.customMetadata?.filename || o.key.split('/').pop(),
          uploadedAt: o.customMetadata?.uploadedAt ? Number(o.customMetadata.uploadedAt) : null,
          size: o.size,
        }));
        return json({ ok: true, files }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, origin);
      }
    }

    // ── DELETE ──
    if (request.method === 'DELETE' && url.pathname === '/doc') {
      const key = url.searchParams.get('key');
      if (!key) return json({ ok: false, error: 'Missing key' }, 400, origin);
      try {
        await env.VAULT_DOCS.delete(key);
        return json({ ok: true }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, origin);
      }
    }

    return json({ ok: false, error: 'Not found' }, 404, origin);
  },
};
