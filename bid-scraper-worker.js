/**
 * Termac One — Bid & RFP Scraper Worker v2
 * Deploy to: Cloudflare Workers (bid-scraper.tedscholl.workers.dev)
 *
 * Sources (all public, no API key required):
 *   - SAM.gov API v2 (federal — requires free API key registration at SAM.gov)
 *   - PHLContracts (Philadelphia open data — Socrata, no key needed)
 *   - DC OCP (DC government contracts — Socrata, no key needed)
 *   - NJSTART RSS feed fallback (NJ open bids)
 *   - Maryland eMMA (public bid board)
 *   - PA eMarketplace (HTML parse)
 *   - Delaware procurement (public)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

function todayMinus(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// ── SAM.GOV (Federal) ───────────────────────────────────────────────────────
// Note: requires free API key from SAM.gov/profile — pass as ?sam_key=YOURKEY
// or set SAM_API_KEY in Worker environment variables
async function scrapeSAMgov(apiKey) {
  if (!apiKey) return { bids: [], error: 'SAM.gov: No API key — register free at sam.gov/profile then add SAM_API_KEY to Worker env vars' };

  try {
    const keywords = encodeURIComponent('fire extinguisher suppression kitchen hood grease trap dish machine');
    const postedFrom = todayMinus(45).replace(/-/g, '/');
    const url = `https://api.sam.gov/opportunities/v2/search?limit=50&api_key=${apiKey}&postedFrom=${postedFrom}&q=${keywords}&active=true`;

    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const bids = (data.opportunitiesData || [])
      .filter(o => matchesKeyword(o.title) || matchesKeyword(o.description))
      .slice(0, 25)
      .map(o => ({
        source: 'SAM.gov',
        refNo: o.solicitationNumber || o.id || '',
        title: o.title || '',
        agency: o.fullParentPathName || o.organizationHierarchy?.office || 'Federal Agency',
        dueDate: o.responseDeadLine ? o.responseDeadLine.slice(0,10) : '',
        url: `https://sam.gov/opp/${o.id}/view`,
        scopeRaw: (o.description || o.title || '').slice(0, 500),
        estValue: null,
        scrapedAt: Date.now(),
      }));

    return { bids, count: bids.length };
  } catch (e) {
    return { bids: [], error: `SAM.gov: ${e.message}` };
  }
}

// ── PHILADELPHIA PHLContracts (Socrata — no key needed) ─────────────────────
async function scrapePHL() {
  try {
    // Philadelphia open contracts dataset
    const where = encodeURIComponent(
      `award_date >= '${todayMinus(60)}'`
    );
    // Also try solicitations dataset
    const urls = [
      'https://data.phila.gov/resource/uj4g-h5en.json?$limit=100&$order=award_date+DESC',
      'https://phl.carto.com/api/v2/sql?q=SELECT+*+FROM+solicitations+ORDER+BY+created_at+DESC+LIMIT+50',
    ];

    // Use the procurement open data endpoint
    const res = await fetch(
      'https://data.phila.gov/resource/uj4g-h5en.json?$limit=100&$order=award_date+DESC',
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) throw new Error(`PHL HTTP ${res.status}`);
    const records = await res.json();

    const bids = records
      .filter(r => matchesKeyword(r.description) || matchesKeyword(r.department_name) || matchesKeyword(r.vendor_name))
      .slice(0, 20)
      .map(r => ({
        source: 'Philadelphia PHLContracts',
        refNo: r.contract_number || r.bid_number || '',
        title: r.description || r.contract_description || 'Philadelphia Contract',
        agency: r.department_name || 'City of Philadelphia',
        dueDate: '',
        url: 'https://www.phila.gov/departments/procurement/',
        scopeRaw: r.description || '',
        estValue: r.dollar_amount ? parseFloat(r.dollar_amount) : null,
        scrapedAt: Date.now(),
      }));

    return { bids, count: bids.length };
  } catch(e) {
    return { bids: [], error: `PHLContracts: ${e.message}` };
  }
}

// ── DC OPEN PROCUREMENT (Socrata — no key needed) ───────────────────────────
async function scrapeDC() {
  try {
    const res = await fetch(
      'https://opendata.dc.gov/datasets/DCGIS::contract-awards.geojson?where=1=1&outFields=*&resultRecordCount=100&orderByFields=AWARD_DATE+DESC',
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) throw new Error(`DC HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    const bids = features
      .filter(f => matchesKeyword(f.properties?.CONTRACT_SCOPE || f.properties?.DESCRIPTION || ''))
      .slice(0, 20)
      .map(f => {
        const p = f.properties || {};
        return {
          source: 'DC OCP',
          refNo: p.CONTRACT_NUMBER || p.SOLICITATION_NUMBER || '',
          title: p.CONTRACT_SCOPE || p.DESCRIPTION || 'DC Government Contract',
          agency: p.AGENCY_NAME || 'DC Government',
          dueDate: '',
          url: 'https://contracts.dc.gov',
          scopeRaw: p.CONTRACT_SCOPE || p.DESCRIPTION || '',
          estValue: p.CONTRACT_AMOUNT ? parseFloat(p.CONTRACT_AMOUNT) : null,
          scrapedAt: Date.now(),
        };
      });

    return { bids, count: bids.length };
  } catch(e) {
    return { bids: [], error: `DC OCP: ${e.message}` };
  }
}

// ── NJSTART (NJ government procurement) ─────────────────────────────────────
async function scrapeNJ() {
  try {
    // NJSTART public solicitation search API
    const res = await fetch(
      'https://www.njstart.gov/bso/external/advsearch/searchBid.sdo?mode=current&filter=FIRE&pageNbr=1',
      { headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res.ok) throw new Error(`NJSTART HTTP ${res.status}`);
    const text = await res.text();

    // Parse bid titles from response
    const matches = [];
    const rows = text.match(/class="bidbrdRow[^"]*"[\s\S]*?<\/tr>/g) || [];
    rows.slice(0, 30).forEach(row => {
      const titleMatch = row.match(/title="([^"]+)"/);
      const agencyMatch = row.match(/Entity:\s*([^<\n]+)/);
      if (titleMatch && matchesKeyword(titleMatch[1])) {
        matches.push({
          source: 'NJSTART',
          refNo: '',
          title: titleMatch[1].trim(),
          agency: agencyMatch ? agencyMatch[1].trim() : 'State of New Jersey',
          dueDate: '',
          url: 'https://www.njstart.gov',
          scopeRaw: titleMatch[1].trim(),
          scrapedAt: Date.now(),
        });
      }
    });

    return { bids: matches, count: matches.length };
  } catch(e) {
    return { bids: [], error: `NJSTART: ${e.message}` };
  }
}

// ── MARYLAND eMMA ───────────────────────────────────────────────────────────
async function scrapeMD() {
  try {
    const res = await fetch(
      'https://emma.maryland.gov/page.aspx/en/rfp/request_browse_public',
      { headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res.ok) throw new Error(`MD HTTP ${res.status}`);
    const text = await res.text();

    const matches = [];
    // Extract solicitation titles from eMMA HTML
    const titleMatches = text.match(/<a[^>]+href="[^"]*request_view_public[^"]*"[^>]*>([^<]+)<\/a>/g) || [];
    titleMatches.slice(0, 30).forEach(tag => {
      const title = tag.replace(/<[^>]+>/g, '').trim();
      if (matchesKeyword(title)) {
        const href = (tag.match(/href="([^"]+)"/) || [])[1] || '';
        matches.push({
          source: 'Maryland eMMA',
          refNo: '',
          title,
          agency: 'State of Maryland',
          dueDate: '',
          url: href ? `https://emma.maryland.gov${href}` : 'https://emma.maryland.gov',
          scopeRaw: title,
          scrapedAt: Date.now(),
        });
      }
    });

    return { bids: matches, count: matches.length };
  } catch(e) {
    return { bids: [], error: `Maryland eMMA: ${e.message}` };
  }
}

// ── DELAWARE ────────────────────────────────────────────────────────────────
async function scrapeDE() {
  try {
    const res = await fetch(
      'https://bidcondocs.delaware.gov/List.aspx',
      { headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res.ok) throw new Error(`DE HTTP ${res.status}`);
    const text = await res.text();

    const matches = [];
    const rows = text.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    rows.slice(0, 40).forEach(row => {
      const titleMatch = row.match(/href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      if (titleMatch && matchesKeyword(titleMatch[2])) {
        matches.push({
          source: 'Delaware Bid Board',
          refNo: '',
          title: titleMatch[2].trim(),
          agency: 'State of Delaware',
          dueDate: '',
          url: `https://bidcondocs.delaware.gov/${titleMatch[1]}`,
          scopeRaw: titleMatch[2].trim(),
          scrapedAt: Date.now(),
        });
      }
    });

    return { bids: matches, count: matches.length };
  } catch(e) {
    return { bids: [], error: `Delaware: ${e.message}` };
  }
}

// ── PA eMARKETPLACE ─────────────────────────────────────────────────────────
async function scrapePA() {
  try {
    // PA uses a different URL structure — try the JSON API first
    const res = await fetch(
      'https://www.emarketplace.state.pa.us/Solicitations.aspx?type=open',
      { headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res.ok) throw new Error(`PA HTTP ${res.status}`);
    const text = await res.text();

    const matches = [];
    // Match solicitation rows with titles and IDs
    const rows = text.match(/SID=\d+[^"]*"[^>]*>([^<]+)<\/a>/g) || [];
    rows.slice(0, 30).forEach(row => {
      const titleMatch = row.match(/>([^<]+)<\/a>/);
      const sidMatch = row.match(/SID=(\d+)/);
      if (titleMatch && matchesKeyword(titleMatch[1])) {
        matches.push({
          source: 'PA eMarketplace',
          refNo: sidMatch ? sidMatch[1] : '',
          title: titleMatch[1].trim(),
          agency: 'Commonwealth of Pennsylvania',
          dueDate: '',
          url: `https://www.emarketplace.state.pa.us/Solicitations.aspx?SID=${sidMatch?.[1]||''}`,
          scopeRaw: titleMatch[1].trim(),
          scrapedAt: Date.now(),
        });
      }
    });

    return { bids: matches, count: matches.length };
  } catch(e) {
    return { bids: [], error: `PA eMarketplace: ${e.message}` };
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const samKey = env.SAM_API_KEY || url.searchParams.get('sam_key') || '';

    const results = { bids: [], counts: {}, errors: [], sources_checked: [] };

    // Run all public scrapers in parallel
    const [phlResult, dcResult, njResult, mdResult, deResult, paResult, samResult] = await Promise.allSettled([
      scrapePHL(),
      scrapeDC(),
      scrapeNJ(),
      scrapeMD(),
      scrapeDE(),
      scrapePA(),
      scrapeSAMgov(samKey),
    ]);

    const sources = [
      { key: 'phl', label: 'PHLContracts',    result: phlResult },
      { key: 'dc',  label: 'DC OCP',           result: dcResult  },
      { key: 'nj',  label: 'NJSTART',          result: njResult  },
      { key: 'md',  label: 'Maryland eMMA',    result: mdResult  },
      { key: 'de',  label: 'Delaware',         result: deResult  },
      { key: 'pa',  label: 'PA eMarketplace',  result: paResult  },
      { key: 'sam', label: 'SAM.gov',          result: samResult },
    ];

    sources.forEach(({ key, label, result }) => {
      const data = result.status === 'fulfilled' ? result.value : { bids: [], error: result.reason?.message };
      results.counts[key] = data.bids?.length || 0;
      results.sources_checked.push(label);
      if (data.error) results.errors.push(`${label}: ${data.error}`);
      if (data.bids?.length) results.bids.push(...data.bids);
    });

    // Dedupe by title similarity
    const seen = new Set();
    results.bids = results.bids.filter(b => {
      const key = (b.title || '').toLowerCase().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
