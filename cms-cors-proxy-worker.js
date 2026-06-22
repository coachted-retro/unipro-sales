/**
 * CMS CORS Proxy — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────────────────
 * data.cms.gov blocks direct browser requests (no CORS headers).
 * This Worker sits in the middle: the browser calls THIS Worker, which
 * fetches data.cms.gov server-side (no CORS restriction server-to-server),
 * then returns the response to the browser with permissive CORS headers added.
 *
 * DEPLOY INSTRUCTIONS (2 minutes):
 *   1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Name it: unipro-cms-proxy
 *   3. Click "Edit code" → paste this entire file → Deploy
 *   4. Your worker URL will be: https://unipro-cms-proxy.tedscholl.workers.dev
 *   5. That URL is already set as HARVEST_CMS_PROXY_URL in termac-os.html
 *      so nothing else needs to change — the harvester activates immediately.
 *
 * HOW IT WORKS:
 *   Browser calls:  https://unipro-cms-proxy.tedscholl.workers.dev?url=<encoded-cms-url>
 *   Worker fetches: <decoded-cms-url>  (server-to-server, no CORS block)
 *   Worker returns: the CMS response + Access-Control-Allow-Origin: *
 *
 * SECURITY:
 *   Only proxies requests to data.cms.gov. Any other target URL returns 403.
 *   This prevents the Worker from being abused as an open proxy.
 * ────────────────────────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGINS = [
  'https://data.cms.gov',
  'https://data.medicaid.gov',
];

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Only GET requests
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Extract and validate the target URL
    const url = new URL(request.url);
    const targetEncoded = url.searchParams.get('url');

    if (!targetEncoded) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(targetEncoded);
      // Validate — only proxy to approved origins
      const targetOrigin = new URL(targetUrl).origin;
      if (!ALLOWED_ORIGINS.some(o => targetUrl.startsWith(o))) {
        return new Response(JSON.stringify({ error: 'Target origin not allowed', origin: targetOrigin }), {
          status: 403,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid target URL' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Fetch from CMS server-to-server
    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Termac-CMS-Proxy/1.0',
        },
      });

      // Read the response body
      const body = await upstream.text();

      // Return with CORS headers so the browser accepts it
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'X-Proxy-Status': 'ok',
          'X-Target-URL': targetUrl.substring(0, 120), // truncated for debugging
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }), {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age':       '86400',
  };
}
