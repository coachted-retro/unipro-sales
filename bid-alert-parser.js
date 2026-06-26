// ════════════════════════════════════════════════════════════════════════════
// bid-alert-parser.js  —  Termac One bid-alert ingestion (Option A)
// ----------------------------------------------------------------------------
// Reads PA e-Alerts and NJSTART notification emails, extracts the fire/kitchen
// solicitations, and writes them to the BID_ALERTS KV namespace under keys
// bids:PA and bids:NJ. The bid-scraper worker reads those keys for its PA/NJ
// sources, so the front-end bid board needs no change.
//
// TRANSPORT-AGNOSTIC — wire up whichever you have:
//   • Cloudflare Email Routing  → the email() handler runs on each inbound mail
//   • Brevo / SendGrid inbound  → POST the parsed-email JSON to the fetch() handler
//
// BINDINGS (Cloudflare dashboard → this worker → Settings → Variables):
//   BID_ALERTS    KV namespace   (REQUIRED — also bind the SAME namespace to bid-scraper)
//   INGEST_TOKEN  Secret         (optional — protects the HTTP webhook; ?token=…)
//   FORWARD_TO    Plain var      (optional — copy every alert to a human inbox)
//
// ⚠️ The parseAlert() row extractor is a sensible generic. Forward me ONE real
//    PA e-Alert and ONE real NJSTART notification and I'll tighten the selectors
//    to those exact formats — that's the last 10% that makes capture reliable.
// ════════════════════════════════════════════════════════════════════════════

const KEYWORDS = [
  'fire suppression', 'fire extinguisher', 'hood suppression', 'ansul',
  'kitchen hood', 'exhaust hood', 'grease trap', 'fog service', 'grease interceptor',
  'dish machine', 'dishwasher', 'warewasher', 'stainless steel fabrication',
  'stainless fabrication', 'custom stainless', 'hood filter', 'kitchen exhaust',
  'nfpa 10', 'nfpa 96', 'fire protection', 'suppression system',
  'commercial kitchen', 'food service equipment', 'kitchen equipment',
  'fire inspection', 'extinguisher inspection', 'wet chemical',
];

function matchesKeyword(text) {
  const lower = (text || '').toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Normalize one parsed solicitation into the shared bid shape used everywhere.
function toBid(provider, o) {
  const isNJ = provider === 'NJSTART';
  return {
    source: provider,
    refNo: o.refNo || '',
    title: o.title || '',
    agency: o.agency || (isNJ ? 'State of New Jersey' : 'Commonwealth of Pennsylvania'),
    dueDate: o.dueDate || '',
    url: o.url || (isNJ ? 'https://www.njstart.gov' : 'https://www.emarketplace.state.pa.us'),
    scopeRaw: o.scope || o.title || '',
    estValue: o.estValue ?? null,
    territory: isNJ ? 'NJ' : 'PA',
    scrapedAt: Date.now(),
  };
}

// ── Identify provider + extract solicitation rows from an alert email ───────
function parseAlert(subject, html, text) {
  const hay = `${subject}\n${html}\n${text}`;
  const provider =
    /njstart|periscope|mdfcommerce|treasury.*new jersey/i.test(hay) ? 'NJSTART' :
    /emarketplace|e-?alert|dgs|pennsylvania|commonwealth/i.test(hay) ? 'PA eMarketplace' :
    null;
  if (!provider) return { provider: null, bids: [] };

  const body = html || text || '';
  const bids = [];
  const seen = new Set();

  // Primary: each solicitation is usually an anchor whose text is the title.
  const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(body)) !== null) {
    const url = m[1].trim();
    const title = stripTags(m[2]);
    if (title.length < 8 || !matchesKeyword(title)) continue;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const refNo = (title.match(/\b\d{2}-[A-Z]\d{3,}\b|SID=?\d+|\b\d{6,}\b/) || [''])[0]
      .replace('SID=', '');
    bids.push(toBid(provider, { title, url, refNo }));
  }

  // Fallback: plain-text alerts (one solicitation per email, no links).
  if (!bids.length) {
    const plain = text || stripTags(html);
    plain.split(/\n+/).forEach(line => {
      const t = line.trim();
      if (t.length >= 12 && matchesKeyword(t)) {
        const key = t.toLowerCase().slice(0, 60);
        if (!seen.has(key)) { seen.add(key); bids.push(toBid(provider, { title: t.slice(0, 160) })); }
      }
    });
    if (!bids.length && matchesKeyword(subject)) {
      bids.push(toBid(provider, { title: subject.trim().slice(0, 160) }));
    }
  }

  return { provider, bids };
}

// ── Merge into KV, dedupe by title, expire after 60 days, cap at 200 ────────
async function storeBids(env, provider, bids) {
  if (!bids.length) return 0;
  const terr = provider === 'NJSTART' ? 'NJ' : 'PA';
  let existing = [];
  try {
    const raw = await env.BID_ALERTS.get(`bids:${terr}`);
    if (raw) existing = JSON.parse(raw);
  } catch { /* first write */ }

  const seen = new Set(existing.map(b => (b.title || '').toLowerCase().slice(0, 60)));
  let added = 0;
  for (const b of bids) {
    const k = (b.title || '').toLowerCase().slice(0, 60);
    if (!seen.has(k)) { existing.push(b); seen.add(k); added++; }
  }

  const cutoff = Date.now() - 60 * 86400000;
  existing = existing.filter(b => (b.scrapedAt || 0) >= cutoff).slice(-200);
  await env.BID_ALERTS.put(`bids:${terr}`, JSON.stringify(existing));
  return added;
}

export default {
  // ── Cloudflare Email Routing transport ────────────────────────────────────
  async email(message, env, ctx) {
    const subject = message.headers.get('subject') || '';
    let raw = '';
    try { raw = await new Response(message.raw).text(); } catch { /* ignore */ }

    // Pull the html and plain parts out of the raw MIME (good enough for alerts)
    const htmlPart = (raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i) || [])[1] || '';
    const textPart = (raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i) || [])[1] || raw;

    const { provider, bids } = parseAlert(subject, htmlPart, textPart);
    if (provider) ctx.waitUntil(storeBids(env, provider, bids));

    // Keep a human copy so nothing is silently swallowed.
    if (env.FORWARD_TO) { try { await message.forward(env.FORWARD_TO); } catch { /* routing rule may handle it */ } }
  },

  // ── HTTP webhook transport (Brevo / SendGrid inbound parse) + health/debug ─
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/health') return new Response('ok');
      if (url.pathname === '/peek') {
        // Quick look at what's stored — handy while testing.
        const pa = await env.BID_ALERTS?.get('bids:PA');
        const nj = await env.BID_ALERTS?.get('bids:NJ');
        return new Response(JSON.stringify({
          pa: pa ? JSON.parse(pa).length : 0,
          nj: nj ? JSON.parse(nj).length : 0,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('bid-alert-parser: POST inbound email JSON to ingest.', { status: 200 });
    }

    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (env.INGEST_TOKEN && url.searchParams.get('token') !== env.INGEST_TOKEN) {
      return new Response('unauthorized', { status: 401 });
    }

    let payload = {};
    try { payload = await request.json(); } catch { /* tolerate empties */ }
    // Be liberal about inbound shapes (Brevo uses items[]; SendGrid is flat).
    const item = (payload.items && payload.items[0]) || payload;
    const subject = item.Subject || item.subject || '';
    const html = item.RawHtmlBody || item.HtmlBody || item.html || '';
    const text = item.RawTextBody || item.TextBody || item.text || '';

    const { provider, bids } = parseAlert(subject, html, text);
    const stored = provider ? await storeBids(env, provider, bids) : 0;

    return new Response(JSON.stringify({ provider, parsed: bids.length, stored }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
