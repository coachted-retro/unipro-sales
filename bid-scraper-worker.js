// ═══════════════════════════════════════════════════════════════════
//  TERMAC BID SCRAPER WORKER
//  Deploy at: bid-scraper.tedscholl.workers.dev
//
//  Scrapes public procurement listings from:
//    1. PA eMarketplace  (state.pa.us — public, no login)
//    2. NJSTART          (njstart.gov — public listing titles)
//    3. DC OCP           (contracts.ocp.dc.gov — confirmed live)
//    4. MD eMMA          (emaryland.buyspeed.com — public RSS)
//
//  Returns: JSON array of bid objects ready for Termac Bids Pipeline
//  CORS: open (only called from Termac One platform)
// ═══════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// All Termac service categories — cast wide, filter by territory after
const KEYWORDS = [
  'fire suppression', 'fire protection', 'fire extinguisher',
  'kitchen hood', 'hood cleaning', 'hood suppression', 'hood system',
  'ansul', 'suppression system', 'fire system', 'fire inspection',
  'grease trap', 'grease interceptor', 'grease pumping',
  'dishwasher', 'dish machine', 'warewash', 'commercial kitchen',
  'hood filter', 'filter exchange', 'exhaust hood',
  'NFPA', 'fire safety', 'fire alarm', 'sprinkler',
  'kitchen equipment', 'cafeteria', 'food service equipment'
];

const TERRITORY_STATES = ['PA', 'NJ', 'DE', 'MD', 'DC', 'Pennsylvania',
  'New Jersey', 'Delaware', 'Maryland'];

function keywordMatch(text) {
  const t = (text || '').toLowerCase();
  return KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

function territoryMatch(text) {
  if (!text) return true; // if no state info, include it
  return TERRITORY_STATES.some(s => text.includes(s));
}

// ── Source 1: PA eMarketplace ────────────────────────────────────
// Public solicitation listing — no auth required for titles/due dates
async function fetchPA() {
  const results = [];
  try {
    // PA eMarketplace public solicitations search page
    const url = 'https://www.emarketplace.state.pa.us/Solicitations.aspx?SType=2';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TermacBidBot/1.0)' },
      cf: { cacheTtl: 3600 }
    });
    if (!res.ok) return results;
    const html = await res.text();

    // Parse solicitation rows from the results table
    // PA eMarketplace uses a GridView with class "rgMasterTable" or similar
    const rowPattern = /<tr[^>]*class="[^"]*(?:rgRow|rgAltRow)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowPattern.exec(html)) !== null) {
      const row = match[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length < 3) continue;
      const title = cells[1] || cells[0] || '';
      const refNo = cells[0] || '';
      const dueDate = cells[cells.length - 1] || '';
      if (!keywordMatch(title)) continue;

      // Extract link for the bid detail
      const linkMatch = row.match(/href="([^"]*Solicitation[^"]*)"/i);
      const bidUrl = linkMatch
        ? 'https://www.emarketplace.state.pa.us' + linkMatch[1]
        : 'https://www.emarketplace.state.pa.us/Solicitations.aspx';

      results.push({
        source: 'PA eMarketplace',
        refNo: refNo.replace(/\s+/g, ''),
        title: title.substring(0, 120),
        agency: cells[2] || 'PA State Agency',
        dueDate: parseDateStr(dueDate),
        estValue: null,
        url: bidUrl,
        territory: 'PA',
        scrapedAt: Date.now()
      });
    }
  } catch (e) {
    console.error('PA fetch error:', e.message);
  }
  return results;
}

// ── Source 2: NJSTART ────────────────────────────────────────────
// Public solicitation summaries — titles visible without login
async function fetchNJ() {
  const results = [];
  try {
    const url = 'https://www.njstart.gov/bso/';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TermacBidBot/1.0)' },
      cf: { cacheTtl: 3600 }
    });
    if (!res.ok) return results;
    const html = await res.text();

    // NJSTART uses table rows with solicitation data
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowPattern.exec(html)) !== null) {
      const row = match[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length < 2) continue;
      const title = cells.find(c => c.length > 15) || '';
      if (!keywordMatch(title)) continue;
      const refNo = cells.find(c => /\d{2}-[A-Z]-\d{4,}/i.test(c)) || '';
      const dueDate = cells.find(c => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) || '';

      results.push({
        source: 'NJSTART',
        refNo,
        title: title.substring(0, 120),
        agency: 'NJ State Agency',
        dueDate: parseDateStr(dueDate),
        estValue: null,
        url: 'https://www.njstart.gov/bso/',
        territory: 'NJ',
        scrapedAt: Date.now()
      });
    }
  } catch (e) {
    console.error('NJ fetch error:', e.message);
  }
  return results;
}

// ── Source 3: DC Office of Contracting & Procurement ─────────────
// DC OCP has a public solicitation search — confirmed live March 2026
async function fetchDC() {
  const results = [];
  try {
    // DC OCP public solicitation search API (confirmed accessible)
    const url = 'https://contracts.ocp.dc.gov/solicitations/search?keyword=fire&status=open';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TermacBidBot/1.0)',
        'Accept': 'application/json, text/html'
      },
      cf: { cacheTtl: 3600 }
    });
    if (!res.ok) return results;

    // Try JSON first (if they have an API endpoint), fall back to HTML
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.results || data.data || []);
      items.forEach(item => {
        const title = item.title || item.name || item.description || '';
        if (!keywordMatch(title)) return;
        results.push({
          source: 'DC OCP',
          refNo: item.solicitationNumber || item.id || '',
          title: title.substring(0, 120),
          agency: item.agency || item.department || 'DC Government',
          dueDate: item.dueDate || item.closingDate || '',
          estValue: item.estimatedValue || null,
          url: item.url || `https://contracts.ocp.dc.gov/solicitations/search`,
          territory: 'DC',
          scrapedAt: Date.now()
        });
      });
    } else {
      const html = await res.text();
      const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let match;
      while ((match = rowPattern.exec(html)) !== null) {
        const row = match[1];
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
          m[1].replace(/<[^>]+>/g, '').trim()
        );
        if (cells.length < 2) continue;
        const title = cells.find(c => c.length > 15) || '';
        if (!keywordMatch(title)) continue;
        const refNo = cells[0] || '';
        const dueDate = cells.find(c => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) || '';
        results.push({
          source: 'DC OCP',
          refNo,
          title: title.substring(0, 120),
          agency: 'DC Government',
          dueDate: parseDateStr(dueDate),
          estValue: null,
          url: 'https://contracts.ocp.dc.gov/solicitations/search',
          territory: 'DC',
          scrapedAt: Date.now()
        });
      }
    }
  } catch (e) {
    console.error('DC fetch error:', e.message);
  }
  return results;
}

// ── Source 4: Maryland eMMA ──────────────────────────────────────
// Maryland eMarylandMarketplace Advantage — public RSS feed
async function fetchMD() {
  const results = [];
  try {
    // MD eMMA public solicitations RSS
    const url = 'https://emaryland.buyspeed.com/bso/publicBidSummaryResponseMain.do';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TermacBidBot/1.0)' },
      cf: { cacheTtl: 3600 }
    });
    if (!res.ok) return results;
    const html = await res.text();

    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowPattern.exec(html)) !== null) {
      const row = match[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length < 2) continue;
      const title = cells.find(c => c.length > 15) || '';
      if (!keywordMatch(title)) continue;
      const refNo = cells[0] || '';
      const dueDate = cells.find(c => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) || '';
      const linkMatch = row.match(/href="([^"]+)"/i);
      results.push({
        source: 'Maryland eMMA',
        refNo,
        title: title.substring(0, 120),
        agency: cells[1] || 'MD State Agency',
        dueDate: parseDateStr(dueDate),
        estValue: null,
        url: linkMatch ? 'https://emaryland.buyspeed.com' + linkMatch[1] : 'https://emaryland.buyspeed.com/bso/',
        territory: 'MD',
        scrapedAt: Date.now()
      });
    }
  } catch (e) {
    console.error('MD fetch error:', e.message);
  }
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────
function parseDateStr(str) {
  if (!str) return '';
  try {
    const d = new Date(str);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  } catch(e) {}
  return str;
}

function dedupeByTitle(bids) {
  const seen = new Set();
  return bids.filter(b => {
    const key = (b.title || '').toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main handler ─────────────────────────────────────────────────
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const results = { pa: [], nj: [], dc: [], md: [], errors: [] };
    const fetches = await Promise.allSettled([fetchPA(), fetchNJ(), fetchDC(), fetchMD()]);

    if (fetches[0].status === 'fulfilled') results.pa = fetches[0].value;
    else results.errors.push('PA: ' + fetches[0].reason?.message);

    if (fetches[1].status === 'fulfilled') results.nj = fetches[1].value;
    else results.errors.push('NJ: ' + fetches[1].reason?.message);

    if (fetches[2].status === 'fulfilled') results.dc = fetches[2].value;
    else results.errors.push('DC: ' + fetches[2].reason?.message);

    if (fetches[3].status === 'fulfilled') results.md = fetches[3].value;
    else results.errors.push('MD: ' + fetches[3].reason?.message);

    const allBids = dedupeByTitle([
      ...results.pa, ...results.nj, ...results.dc, ...results.md
    ]);

    return new Response(JSON.stringify({
      bids: allBids,
      counts: { pa: results.pa.length, nj: results.nj.length, dc: results.dc.length, md: results.md.length },
      total: allBids.length,
      errors: results.errors,
      fetchedAt: new Date().toISOString()
    }), { headers: CORS_HEADERS });
  }
};
