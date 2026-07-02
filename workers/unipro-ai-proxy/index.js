/**
 * unipro-ai-proxy — Termac One
 * Proxies requests to the Anthropic API with CORS headers so browser-based
 * portals can call Claude without exposing the API key client-side.
 * Deployed at: unipro-ai-proxy.termac-one.workers.dev
 */

const ALLOWED_ORIGINS = [
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }

    try {
      const body = await request.json();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-4-6',
          max_tokens: body.max_tokens || 1000,
          messages: body.messages || [],
          system: body.system,
          temperature: body.temperature,
        }),
      });

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', detail: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
      });
    }
  }
};
