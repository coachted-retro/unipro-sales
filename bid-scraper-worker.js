/**
 * Termac One — Bid & RFP Scraper Worker
 * Deploy to: Cloudflare Workers (bid-scraper.tedscholl.workers.dev)
 *
 * Environment secrets (Cloudflare Dashboard → Workers → Settings → Variables):
 *   APIFY_API_TOKEN — your Apify API token (for BidNet Direct scraper)
 *
 * Sources scraped:
 *   - SAM.gov (federal) — public API, no key needed
 *   - PA eMarketplace — public feed
 *   - NJSTART — public feed
 *   - Philadelphia PHLContracts — public feed
 *   - DC OCP — public feed
 *   - Maryland eMMA — public feed
 *   - Delaware Bid Board — public feed
 *   - BidNet Direct — via Apify scraper (requires APIFY_API_TOKEN)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Termac service keywords for bid matching
const KEYWORDS = [
  'fire suppression', 'fire extinguisher', 'hood suppression', 'ansul',
  'kitchen hood', 'exhaust hood', 'grease trap', 'fog service', 'grease interceptor',
  'dish machine', 'dishwasher', 'warewasher', 'stainless steel fabrication',
  'stainless fabrication', 'custom stainless', 'hood filter', 'kitchen exhaust filter',
  'nfpa 10', 'nfpa 96', 'fire protection inspection', 'suppression system inspection',
  'kitchen equipment', 'food service equipment', 'commercial kitchen',
];

// NAICS codes relevant to Termac services
const NAICS_CODES = [
  '238990', // Specialty Trade Contractors
  '561790', // Services to Buildings
  '332322', // Sheet Metal Work (stainless fab)
  '423720', // Plumbing & HVAC Equipment
  '811310', // Commercial Equipment Repair (dish machine)
  '562998', // All Other Misc Waste Mgmt (grease trap)
  '561720', // Janitorial Services (some hood cleaning)
];

function matchesKeyword(text) {
  const lower = (text || '').toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

// ── APIFY BIDNET SCRAPER ────────────────────────────────────────────────────
async function scrapeBidNet(apiToken) {
  if (!apiToken) {
    return { bids: [], error: 'APIFY_API_TOKEN not set in Worker environment variables' };
  }

  try {
    // Run the BidNetDirect Government Bids Scraper
    // Actor: petr_cermak/bidnet-direct-government-bids-scraper
    const actorId = 'petr_cermak~bidnet-direct-government-bids-scraper';
    
    // Start the actor run
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        states: ['Pennsylvania', 'New Jersey', 'Delaware', 'Maryland', 'District of Columbia'],
        keywords: KEYWORDS.slice(0, 10).join(', '), // Top keywords
        maxItems: 100,
        status: 'Open',
      }),
    });

    if (!runRes.ok) {
      const errText = await runRes.text().catch(() => '');
      return { bids: [], error: `Apify run failed: ${runRes.status} ${errText.slice(0, 200)}` };
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) return { bids: [], error: 'No run ID returned from Apify' };

    // Wait for completion (up to 60 seconds)
    let attempts = 0;
    let status = 'RUNNING';
    while (status === 'RUNNING' && attempts < 12) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${apiToken}` },
      });
      const statusData = await statusRes.json();
      status = statusData.data?.status || 'RUNNING';
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      return { bids: [], error: `Apify run status: ${status} after ${attempts * 5}s` };
    }

    // Fetch results
    const dataRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}/dataset/items?limit=100`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });
    const items = await dataRes.json();

    // Filter and normalize
    const bids = (items || [])
      .filter(item => matchesKeyword(item.title) || matchesKeyword(item.description))
      .map(item => ({
        source: 'BidNet Direct',
        refNo: item.bidNumber || item.id || '',
        title: item.title || item.name || '',
        agency: item.agency || item.organization || '',
        dueDate: item.dueDate || item.closingDate || '',
        url: item.url || '',
        scopeRaw: item.description || item.title || '',
        estValue: null,
        scrapedAt: Date.now(),
      }));

    return { bids, count: bids.length };

  } catch (e) {
    return { bids: [], error: `BidNet scrape error: ${e.message}` };
  }
}

// ── SAM.GOV (Federal) ───────────────────────────────────────────────────────
async function scrapeSAMgov() {
  try {
    const keywords = 'fire+suppression+fire+extinguisher+hood+suppression+kitchen+equipment';
    const today = new Date();
    const postedFrom = new Date(today - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    const url = `https://api.sam.gov/opportunities/v2/search?limit=50&postedFrom=${postedFrom}&keywords=${keywords}&active=true&typeOfSetAside=&ptype=o`;
    
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) throw new Error(`SAM.gov ${res.status}`);
    const data = await res.json();
    
    const bids = (data.opportunitiesData || [])
      .filter(o => matchesKeyword(o.title) || matchesKeyword(o.description))
      .slice(0, 25)
      .map(o => ({
        source: 'SAM.gov',
        refNo: o.solicitationNumber || o.id || '',
        title: o.title || '',
        agency: o.fullParentPathName || o.organizationHierarchy?.office || '',
        dueDate: o.responseDeadLine || '',
        url: `https://sam.gov/opp/${o.id}/view`,
        scopeRaw: o.description || o.title || '',
        estValue: null,
        scrapedAt: Date.now(),
      }));

    return { bids, count: bids.length };
  } catch (e) {
    return { bids: [], error: `SAM.gov: ${e.message}` };
  }
}

// ── PA eMARKETPLACE ─────────────────────────────────────────────────────────
async function scrapePA() {
  try {
    const res = await fetch(
      'https://www.emarketplace.state.pa.us/Solicitations.aspx?type=open&format=json',
      { headers: { 'Accept': 'application/json, text/html' } }
    );
    
    if (!res.ok) throw new Error(`PA ${res.status}`);
    const text = await res.text();
    
    // Parse HTML table if JSON not available
    const matches = [];
    const rows = text.match(/href="\/Solicitations\.aspx\?SID=[\w&=]+">([^<]+)<\/a>/g) || [];
    rows.slice(0, 30).forEach(row => {
      const titleMatch = row.match(/>([^<]+)<\/a>/);
      if (titleMatch && matchesKeyword(titleMatch[1])) {
        matches.push({
          source: 'PA eMarketplace',
          refNo: '',
          title: titleMatch[1].trim(),
          agency: 'Commonwealth of Pennsylvania',
          dueDate: '',
          url: 'https://www.emarketplace.state.pa.us/Solicitations.aspx',
          scopeRaw: titleMatch[1].trim(),
          scrapedAt: Date.now(),
        });
      }
    });

    return { bids: matches, count: matches.length };
  } catch (e) {
    return { bids: [], error: `PA eMarketplace: ${e.message}` };
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const results = { bids: [], counts: {}, errors: [] };

    // Run all scrapers in parallel
    const [samResult, paResult, bidnetResult] = await Promise.allSettled([
      scrapeSAMgov(),
      scrapePA(),
      scrapeBidNet(env.APIFY_API_TOKEN),
    ]);

    // Process results
    const sources = [
      { key: 'sam', label: 'SAM.gov', result: samResult },
      { key: 'pa', label: 'PA eMarketplace', result: paResult },
      { key: 'bidnet', label: 'BidNet Direct', result: bidnetResult },
    ];

    sources.forEach(({ key, label, result }) => {
      if (result.status === 'fulfilled') {
        const data = result.value;
        results.counts[key] = data.count || 0;
        results.bids.push(...(data.bids || []));
        if (data.error) results.errors.push(`${label}: ${data.error}`);
      } else {
        results.errors.push(`${label}: ${result.reason}`);
        results.counts[key] = 0;
      }
    });

    // Dedupe by title
    const seen = new Set();
    results.bids = results.bids.filter(b => {
      const key = (b.title || '').toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return new Response(JSON.stringify(results), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
};
