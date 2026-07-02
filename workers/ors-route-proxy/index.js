/**
 * Termac One — Route Intelligence Proxy Worker
 * Deploy to: Cloudflare Workers  (suggested name: ors-route-proxy.tedscholl.workers.dev)
 *
 * Shared road-routing intelligence for BOTH the Dispatch board and the Scheduler.
 * Each page calls this worker on its own; the pages and their logins stay separate.
 *
 * Environment secret (Cloudflare dashboard -> Workers -> Settings -> Variables):
 *   ORS_API_KEY  — free key from https://openrouteservice.org (sign up, copy the API key)
 *
 * Routes (POST JSON):
 *   /geocode   { address }                              -> { lat, lng }
 *        US Census one-line geocoder. Free, no key.
 *   /optimize  { start:[lat,lng], stops:[[lat,lng],..] } -> { order, savedMin, totalMin }
 *        ORS driving matrix (real road durations) + nearest-neighbor + 2-opt.
 *        order = stop indices in best driving sequence.
 *
 * If ORS or the Census service is unreachable, the worker returns an error and the
 * front-end falls back to its own nearest-neighbor. Dispatch and scheduling never
 * depend on this service to keep functioning.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    try {
      const body = await request.json();
      if (path.endsWith('/geocode')) return await geocode(body);
      if (path.endsWith('/optimize')) return await optimize(body, env);
      return json({ error: 'unknown route' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

/* ---- Geocode: US Census one-line address (free, no key) ---- */
async function geocode({ address }) {
  if (!address) return json({ error: 'address required' }, 400);
  const u = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
          + '?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(address);
  const r = await fetch(u);
  if (!r.ok) return json({ error: 'census ' + r.status }, 502);
  const d = await r.json();
  const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
  if (!m || !m.coordinates) return json({ error: 'no match' }, 404);
  // Census returns x = longitude, y = latitude
  return json({ lat: m.coordinates.y, lng: m.coordinates.x });
}

/* ---- Optimize: real driving durations from ORS, solved locally ---- */
async function optimize({ start, stops }, env) {
  if (!Array.isArray(stops) || !stops.length) return json({ error: 'stops required' }, 400);
  const key = env.ORS_API_KEY;
  if (!key) return json({ error: 'no key' }, 503); // front-end falls back to nearest-neighbor

  const toLngLat = p => [p[1], p[0]];               // [lat,lng] -> [lng,lat] for ORS
  const startLL = start ? toLngLat(start) : toLngLat(stops[0]);
  const locations = [startLL, ...stops.map(toLngLat)]; // index 0 = start, 1..N = stops

  const r = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations, metrics: ['duration'] })
  });
  if (!r.ok) return json({ error: 'ors ' + r.status }, 502);
  const d = await r.json();
  const D = d && d.durations;
  if (!D) return json({ error: 'no matrix' }, 502);

  const N = stops.length;
  const stopNodes = [];
  for (let i = 1; i <= N; i++) stopNodes.push(i);

  const seqDur = seq => {
    let t = 0, cur = 0;
    for (const s of seq) { t += D[cur][s]; cur = s; }
    return t;
  };

  // Nearest-neighbor from the start node
  let remaining = stopNodes.slice(), nn = [], cur = 0;
  while (remaining.length) {
    let best = remaining[0], bd = D[cur][best], bi = 0;
    remaining.forEach((s, i) => { const t = D[cur][s]; if (t < bd) { bd = t; best = s; bi = i; } });
    nn.push(best); cur = best; remaining.splice(bi, 1);
  }

  // 2-opt local improvement on real road durations
  let route = nn.slice(), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const cand = route.slice(0, i).concat(route.slice(i, k + 1).reverse(), route.slice(k + 1));
        if (seqDur(cand) + 1e-9 < seqDur(route)) { route = cand; improved = true; }
      }
    }
  }

  const optDur = seqDur(route);
  const naiveDur = seqDur(stopNodes);   // original input order
  return json({
    order: route.map(s => s - 1),       // back to 0-based stop indices
    totalMin: Math.round(optDur / 60),
    savedMin: Math.max(0, Math.round((naiveDur - optDur) / 60))
  });
}
