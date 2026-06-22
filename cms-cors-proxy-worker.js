/**
 * Termac Government Data Proxy — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────────────────
 * Routes all Termac One harvester requests server-side so CORS never blocks
 * them. Works for CMS, Socrata (PA/DE/NJ), and ArcGIS (DC/MD) sources.
 *
 * DEPLOYED AS: cms-cors-proxy (tedscholl.workers.dev)
 * URL already set in termac-os.html as HARVEST_CMS_PROXY_URL.
 *
 * HOW IT WORKS:
 *   Browser calls:  https://cms-cors-proxy.tedscholl.workers.dev?url=<encoded-url>
 *   Worker fetches: <decoded-url>  (server-to-server, no CORS block)
 *   Worker returns: the API response + Access-Control-Allow-Origin: *
 *
 * SECURITY: Only proxies to domains in ALLOWED_ORIGINS below. Any other
 * target returns 403. Prevents open-proxy abuse.
 * ────────────────────────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGINS = [
  // CMS / Medicaid
  'https://data.cms.gov',
  'https://data.medicaid.gov',
  // PA — Philadelphia ArcGIS Business Licenses
  'https://services.arcgis.com',
  // DC — DCGIS ArcGIS Business Licenses
  'https://maps2.dcgis.dc.gov',
  // DE — Delaware Socrata business registry
  'https://data.delaware.gov',
  // NJ — NJ open data (Socrata) construction permits
  'https://data.nj.gov',
  // MD — Baltimore County ArcGIS development permits
  'https://bcgis.baltimorecountymd.gov',
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

    // Fetch from upstream server-to-server (no CORS restriction)
    try {
      const upstream = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Termac-GovData-Proxy/2.0',
        },
      });

      const body = await upstream.text();

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'X-Proxy-Status': 'ok',
          'X-Target-URL': targetUrl.substring(0, 200),
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
