/**
 * Termac One — Google Maps Harvest Proxy Worker
 * Deploy to: Cloudflare Workers (googlemapharvester.tedscholl.workers.dev)
 *
 * Environment secrets required (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   OUTSCRAPER_API_KEY  — your Outscraper API key from app.outscraper.com
 *
 * KV namespace (optional, for daily budget tracking):
 *   Bind a KV namespace called HARVEST_KV to this worker
 *
 * Daily budget: 3000 records/day (≈ $3/day at typical Outscraper rates)
 */

const DAILY_CAP = 3000;
const KV_BUDGET_KEY = 'daily_budget';

// Category key → Google Maps search query
const CATEGORY_QUERIES = {
  restaurants:     'restaurants',
  hotels:          'hotels',
  assisted_living: 'assisted living facilities',
  nursing_homes:   'nursing homes',
  catering:        'catering companies',
  schools:         'schools',
  bars:            'bars and nightclubs',
  food_trucks:     'food trucks',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST required' }, 405);
    }

    // Parse body
    let body;
    try { body = await request.json(); } catch(e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { categoryKey = 'restaurants', location, limit = 40 } = body;

    if (!location || typeof location !== 'string') {
      return json({ error: 'location is required' }, 400);
    }

    const query = CATEGORY_QUERIES[categoryKey] || categoryKey;
    const clampedLimit = Math.max(1, Math.min(200, Number(limit) || 40));

    // ── Daily budget check (KV) ───────────────────────────────────────────
    let dailyUsage = null;
    if (env.HARVEST_KV) {
      try {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const raw = await env.HARVEST_KV.get(KV_BUDGET_KEY);
        const kv = raw ? JSON.parse(raw) : { date: today, used: 0 };

        // Reset if new day
        if (kv.date !== today) { kv.date = today; kv.used = 0; }

        const remaining = DAILY_CAP - kv.used;
        if (remaining <= 0) {
          return json({ error: 'Daily harvest budget reached ($3/day cap). Resets at midnight UTC.' }, 429);
        }

        const actualLimit = Math.min(clampedLimit, remaining);
        const clampedByDailyBudget = actualLimit < clampedLimit;

        dailyUsage = { used: kv.used, cap: DAILY_CAP, remaining, date: today };

        // Call Outscraper
        const results = await callOutscraper(env, query, location, actualLimit);

        // Update KV budget
        kv.used += results.length;
        await env.HARVEST_KV.put(KV_BUDGET_KEY, JSON.stringify(kv), { expirationTtl: 86400 * 2 });
        dailyUsage.used = kv.used;
        dailyUsage.remaining = DAILY_CAP - kv.used;

        return json({ results, dailyUsage, clampedByDailyBudget });

      } catch(e) {
        // KV error — fall through without budget tracking
        console.error('KV error:', e.message);
      }
    }

    // No KV — call without budget tracking
    try {
      const results = await callOutscraper(env, query, location, clampedLimit);
      return json({ results, dailyUsage: null });
    } catch(e) {
      return json({ error: e.message, detail: 'Outscraper API call failed — check your API key in Worker environment variables.' }, 502);
    }
  }
};

async function callOutscraper(env, query, location, limit) {
  if (!env.OUTSCRAPER_API_KEY) {
    throw new Error('OUTSCRAPER_API_KEY not set in Worker environment variables. Go to Cloudflare Dashboard → Workers → googlemapharvester → Settings → Variables and add it.');
  }

  const params = new URLSearchParams({
    query: `${query} in ${location}`,
    limit: String(limit),
    language: 'en',
    region: 'us',
    dropDuplicates: 'true',
  });

  const resp = await fetch(`https://api.app.outscraper.com/maps/search-v3?${params}`, {
    headers: {
      'X-API-KEY': env.OUTSCRAPER_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Outscraper API key invalid or expired (${resp.status}). Get a new key at app.outscraper.com → API Keys.`);
    }
    if (resp.status === 402) {
      throw new Error('Outscraper account has no credits. Add credits at app.outscraper.com → Billing.');
    }
    throw new Error(`Outscraper API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();

  // Outscraper returns { data: [...], status: 'Success' } for sync calls
  // or a task ID for async — we use sync (limit ≤ 200 should be sync)
  const results = Array.isArray(data) ? data : (data.data || []);
  return results.flat(); // Outscraper sometimes nests results in arrays
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
