
// ── TERMAC ONE: localStorage key migration ─────────────────────────────────
// Canonical keys: termac_crm_accounts, termac_crm_leads
// Run once per session to merge any data written under legacy key names.
(function termacKeyMigration() {
  try {
    var OLD_ACCOUNT_KEYS = ['crm_accounts', 'accounts'];
    var OLD_LEAD_KEYS    = ['leads', 'termac_leads', 'crm_leads', 'termac_crm_leads'];
    var CANONICAL_ACCTS  = 'termac_crm_accounts';
    var CANONICAL_LEADS  = 'termac_crm_leads';

    function mergeArrays(a, b, idField) {
      // b wins on conflict (newer write)
      var map = {};
      (a||[]).forEach(function(x){ if(x && x[idField]) map[x[idField]] = x; });
      (b||[]).forEach(function(x){ if(x && x[idField]) map[x[idField]] = x; });
      return Object.values(map);
    }

    // Accounts
    var canonical = JSON.parse(localStorage.getItem(CANONICAL_ACCTS) || '[]');
    OLD_ACCOUNT_KEYS.forEach(function(k) {
      var old = JSON.parse(localStorage.getItem(k) || '[]');
      if (old.length) {
        canonical = mergeArrays(canonical, old, 'id');
        localStorage.removeItem(k);
      }
    });
    if (canonical.length) localStorage.setItem(CANONICAL_ACCTS, JSON.stringify(canonical));

    // Leads
    var canonicalLeads = JSON.parse(localStorage.getItem(CANONICAL_LEADS) || '[]');
    OLD_LEAD_KEYS.forEach(function(k) {
      if (k === CANONICAL_LEADS) return;
      var old = JSON.parse(localStorage.getItem(k) || '[]');
      if (old.length) {
        canonicalLeads = mergeArrays(canonicalLeads, old, 'id');
        localStorage.removeItem(k);
      }
    });
    if (canonicalLeads.length) localStorage.setItem(CANONICAL_LEADS, JSON.stringify(canonicalLeads));

  } catch(e) { console.warn('Key migration error:', e); }
})();
// ── END KEY MIGRATION ───────────────────────────────────────────────────────

/* ═══════════════════════════════════════════════════════════════════════════
   TERMAC ONE — LIFECYCLE ENGINE v1.0
   termac-lifecycle.js

   Closes every gap in the lead → account → job → invoice → recurring lifecycle.

   SYSTEMS:
   1. Universal Lead Notification — every source, same chain, CC Jim + Tom
   2. Reception ZIP routing — auto-assigns rep on lead creation
   3. Warm Harvest Queue — harvesters → rep territory bucket (bypass DMS)
   4. wonLead() — signature triggers full account + job packet + notifications
   5. Appointment/Opportunity creation — one-click from lead card
   6. Deficiency → Lexi high-priority notification + quote workflow
   7. Auto-scheduling cadence — NFPA + division service intervals
   8. Warehouse bidirectional — pull confirmation back to tech
   9. Customer-facing confirmation — Brevo-wired appointment confirmation
═══════════════════════════════════════════════════════════════════════════ */

// ── SERVICE INTERVAL REGISTRY ─────────────────────────────────────────────
// Source of truth for all recurring service cadences.
// Used by: wonLead(), auto-scheduler, cert expiry drip triggers.
const SERVICE_INTERVALS = {
  // UniPro / Quality III — NFPA governed
  'nfpa10_annual':       { label:'NFPA 10 — Extinguisher Annual',          months: 12,  nfpa:'NFPA 10 §7.3'   },
  'nfpa10_6year':        { label:'NFPA 10 — 6-Year Maintenance',            months: 72,  nfpa:'NFPA 10 §7.5'   },
  'nfpa96_semiannual':   { label:'NFPA 96 — Hood Suppression Semi-Annual',  months: 6,   nfpa:'NFPA 96 §11'    },
  'nfpa96_annual':       { label:'NFPA 96 — Hood Suppression Annual',       months: 12,  nfpa:'NFPA 96 §11'    },
  'exitlights_annual':   { label:'Exit/Emergency Lights Annual',             months: 12,  nfpa:'NFPA 101 §7.9'  },
  'sprinkler_annual':    { label:'Sprinkler System Annual',                  months: 12,  nfpa:'NFPA 25'        },
  'sprinkler_5year':     { label:'Sprinkler System 5-Year',                  months: 60,  nfpa:'NFPA 25 §5.3'   },
  // GTO — site-survey defined frequency
  'gto_monthly':         { label:'Grease Trap — Monthly',                    months: 1,   nfpa:null             },
  'gto_bimonthly':       { label:'Grease Trap — Bi-Monthly (every 2mo)',    months: 2,   nfpa:null             },
  'gto_quarterly':       { label:'Grease Trap — Quarterly',                  months: 3,   nfpa:null             },
  'gto_semiannual':      { label:'Grease Trap — Semi-Annual',                months: 6,   nfpa:null             },
  // Filter Man — site-survey defined frequency
  'filterman_weekly':    { label:'Hood Filters — Weekly',                    weeks: 1,    nfpa:null             },
  'filterman_biweekly':  { label:'Hood Filters — Bi-Weekly (every 2wk)',    weeks: 2,    nfpa:null             },
  'filterman_4week':     { label:'Hood Filters — Every 4 Weeks',            weeks: 4,    nfpa:null             },
  'filterman_6week':     { label:'Hood Filters — Every 6 Weeks',            weeks: 6,    nfpa:null             },
  'filterman_monthly':   { label:'Hood Filters — Monthly',                   months: 1,   nfpa:null             },
  // Termac — dish machine
  'termac_monthly':      { label:'Dish Machine Service — Monthly',           months: 1,   nfpa:null             },
  'termac_quarterly':    { label:'Dish Machine Service — Quarterly',         months: 3,   nfpa:null             },
  // AllPro — project-based, no recurring
};

function lcIntervalNextDue(intervalKey, fromDate) {
  const def = SERVICE_INTERVALS[intervalKey];
  if (!def) return null;
  const base = fromDate ? new Date(fromDate) : new Date();
  if (def.weeks) {
    base.setDate(base.getDate() + def.weeks * 7);
  } else if (def.months) {
    base.setMonth(base.getMonth() + def.months);
  }
  return base.toISOString().split('T')[0];
}

// ── 1. UNIVERSAL LEAD NOTIFICATION ────────────────────────────────────────
// Every new lead fires this regardless of source.
// CC: Jim Kennedy + Tom Pittakas always.
function lcNotifyNewLead(lead, source) {
  if (!lead) return;
  const rep        = lead.assignedRep || lead.claimedBy || 'Unassigned';
  const repInfo    = NOTIF_STAFF[rep] || null;
  const now        = new Date();
  const dateStr    = now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const timeStr    = now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  const biz        = lead.business || lead.name || 'Unknown';
  const phone      = lead.phone || '—';
  const addr       = lead.address || lead.zip || '—';
  const services   = (lead.services||[]).join(', ') || lead.company || 'UniPro';
  const score      = lead.score || '—';
  const notes      = lead.notes || '';

  const subjectText = `🔥 HOT LEAD — ${biz} · ${source}`;
  const bodyLines = [
    rep !== 'Unassigned' ? `${rep},` : 'Team,',
    '',
    `A new hot lead has been assigned${rep !== 'Unassigned' ? ' to you' : ''} from ${source}. Details below.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'LEAD DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Business:     ${biz}`,
    `Phone:        ${phone}`,
    `Address:      ${addr}`,
    `Services:     ${services}`,
    `Lead Score:   ${score}/10`,
    `Source:       ${source}`,
    `Assigned To:  ${rep}`,
    `Date / Time:  ${dateStr} · ${timeStr}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'NOTES',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    notes || 'No notes recorded.',
    '',
    '⚡ Respond within 15 minutes for best close rate.',
    '',
    'View in Termac One: https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '— Termac One Lifecycle Engine',
  ];
  const bodyText = bodyLines.join('\n');

  // Build TO and CC lists
  const toEmail  = repInfo ? repInfo.email : 'tscholl@termac.com';
  const ccEmails = ['jkennedy@termac.com','tpittakas@termac.com','tscholl@termac.com']
    .filter(e => e !== toEmail).join(',');

  // Store in-app notification
  if (typeof _storeInAppNotif === 'function') {
    _storeInAppNotif({
      type:      'hot_lead',
      icon:      '🔥',
      urgent:    true,
      title:     `HOT LEAD — ${biz}`,
      body:      `${source} · ${phone} · ${services}`,
      recipient: rep,
      email:     toEmail,
    });
  }

  // Fire email (mailto now, Brevo at go-live)
  const subject = encodeURIComponent(subjectText);
  const body    = encodeURIComponent(bodyText);
  window.open(`mailto:${toEmail}?cc=${ccEmails}&subject=${subject}&body=${body}`, '_blank');

  // Show toast
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#C8102E;color:#fff;border-radius:10px;padding:14px 22px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:13px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.35);text-align:center;max-width:380px';
  t.innerHTML = `🔥 HOT LEAD — ${biz}<br><span style="font-weight:500;font-size:11px">Notified: ${rep} + Jim Kennedy + Tom Pittakas</span>`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; }, 4000);
  setTimeout(()=> t.remove(), 4500);
}

// ── 2. RECEPTION ZIP ROUTING FIX ─────────────────────────────────────────
// Upgraded rcpLogAndCreateLead — auto-assigns by ZIP, fires universal notification.
function lcRcpCreateLead(call) {
  if (!call) return null;
  // Extract ZIP from phone area code heuristic or notes — best effort
  const zip  = (call.notes||'').match(/\b(\d{5})\b/)?.[1] || '';
  const rep  = zip && typeof getRepForZip === 'function' ? getRepForZip(zip) : 'Unassigned';
  const now  = Date.now();

  const lead = {
    id:          'lead_rcp_' + now,
    name:        call.name || 'Unknown',
    business:    call.company || call.name || '',
    phone:       call.phone || '',
    email:       '',
    address:     '',
    zip:         zip,
    company:     'UniPro',
    services:    [],
    status:      rep !== 'Unassigned' ? 'hot' : 'new',
    score:       7,
    source:      'Inbound Call',
    assignedRep: rep,
    claimedBy:   rep !== 'Unassigned' ? rep : '',
    created:     now,
    updated:     now,
    notes:       `Inbound call ${call.date} ${call.time}. Type: ${call.type}. ${call.notes||''}`,
    activityLog: [{
      ts: now, type:'call', icon:'📞',
      title: 'Inbound Call — Reception',
      note:  call.notes || '',
      who:   call.loggedBy || 'Reception',
    }],
  };

  // Save
  try {
    const leads = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
    leads.unshift(lead);
    localStorage.setItem('termac_crm_leads', JSON.stringify(leads));
  } catch(e) {}

  // Link call to lead
  try {
    const calls = JSON.parse(localStorage.getItem('termac_inbound_calls') || '[]');
    const c = calls.find(x => x.id === call.id);
    if (c) { c.createdLead = true; c.leadId = lead.id; c.assignedRep = rep; }
    localStorage.setItem('termac_inbound_calls', JSON.stringify(calls));
  } catch(e) {}

  // Universal notification
  lcNotifyNewLead(lead, 'Inbound Call');

  return lead;
}

// ── 3. WARM HARVEST → REP TERRITORY BUCKET ────────────────────────────────
// Harvested leads skip DMS and land directly in the rep's "Warm Harvest" queue.
// Called by each harvester after pulling leads.
function lcRouteHarvestedLeads(harvestedLeads, harvesterName) {
  if (!harvestedLeads || !harvestedLeads.length) return 0;
  const now   = Date.now();
  let routed  = 0;
  let notified = {};

  const existingLeads = (() => { try { return JSON.parse(localStorage.getItem('termac_crm_leads')||'[]'); } catch(e){ return []; } })();

  harvestedLeads.forEach(function(raw) {
    const zip = raw.zip || (raw.address||'').match(/\b(\d{5})\b/)?.[1] || '';
    const rep = zip && typeof getRepForZip === 'function' ? getRepForZip(zip) : 'Unassigned';

    // Dedup by phone or business name
    const isDupe = existingLeads.some(function(l) {
      return (raw.phone && l.phone === raw.phone) ||
             ((raw.business||raw.name||'').toLowerCase() === (l.business||l.name||'').toLowerCase() && zip && l.zip === zip);
    });
    if (isDupe) return;

    const lead = {
      id:          'lead_harv_' + now + '_' + Math.random().toString(36).slice(2,6),
      name:        raw.name || raw.business || 'Unknown',
      business:    raw.business || raw.name || '',
      phone:       raw.phone || '',
      email:       raw.email || '',
      address:     raw.address || '',
      zip:         zip,
      company:     raw.division || 'UniPro',
      services:    raw.services || [],
      status:      'warm',              // warm harvest — not yet contacted
      score:       typeof scoreLeadOnArrival === 'function' ? scoreLeadOnArrival(raw) : 6,
      source:      harvesterName || 'Harvest',
      assignedRep: rep,
      isWarmHarvest: true,              // flag for rep dashboard queue
      harvesterSource: harvesterName,
      created:     now,
      updated:     now,
      notes:       raw.notes || '',
      activityLog: [{
        ts: now, type:'harvest', icon:'🌾',
        title: `Harvested — ${harvesterName}`,
        note:  `Auto-routed to ${rep} by ZIP ${zip}`,
        who:   'Lifecycle Engine',
      }],
    };

    existingLeads.unshift(lead);
    routed++;

    // Batch notifications per rep (one email per rep, not per lead)
    if (rep !== 'Unassigned') {
      if (!notified[rep]) notified[rep] = [];
      notified[rep].push(lead);
    }
  });

  localStorage.setItem('termac_crm_leads', JSON.stringify(existingLeads));

  // Send one digest email per rep with all their new harvest leads
  Object.entries(notified).forEach(function([rep, repLeads]) {
    lcNotifyHarvestDigest(rep, repLeads, harvesterName);
  });

  return routed;
}

function lcNotifyHarvestDigest(rep, leads, source) {
  const repInfo = NOTIF_STAFF[rep] || null;
  if (!repInfo) return;
  const biz0    = leads[0]?.business || leads[0]?.name || '—';
  const count   = leads.length;
  const subjectText = `🌾 ${count} New Warm Harvest Lead${count>1?'s':''} — ${source}`;
  const bodyText = [
    `${rep},`,
    '',
    `${count} new lead${count>1?'s have':' has'} been added to your Warm Harvest queue from ${source}. These have been pre-routed to your territory — no DMS step needed.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'YOUR NEW WARM HARVEST LEADS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...leads.slice(0,10).map(function(l,i){ return `${i+1}. ${l.business||l.name} · ${l.address||l.zip} · ${l.phone||'—'}`; }),
    leads.length > 10 ? `... and ${leads.length-10} more in your Lead Pool` : '',
    '',
    'These are addresses/contacts that need a rep visit or initial outreach — not a cold call. Review in your Sales Portal under Warm Harvest queue.',
    '',
    'View in Termac One: https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n');

  const toEmail  = repInfo.email;
  const ccEmails = 'jkennedy@termac.com,tpittakas@termac.com';
  window.open(`mailto:${toEmail}?cc=${ccEmails}&subject=${encodeURIComponent(subjectText)}&body=${encodeURIComponent(bodyText)}`, '_blank');
}

// ── 4. wonLead() — FULL LIFECYCLE TRIGGER ON SIGNATURE ────────────────────
// Called from estSigProceed() after customer signs estimate.
// Creates account, generates job packet, alerts scheduler/warehouse/tech.
function lcWonLead(leadOrAccount, estimateData) {
  const now     = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];
  const biz     = leadOrAccount.business || leadOrAccount.name || 'New Account';
  const rep     = leadOrAccount.assignedRep || estimateData?.rep || 'Unassigned';

  // 4a. Promote lead to account (if record is a lead, not already an account)
  let account = leadOrAccount;
  if (!account.lifecycleStage || account.lifecycleStage === 'lead' || account.lifecycleStage === 'opportunity') {
    account = _lcBuildAccount(leadOrAccount, estimateData, now);
    // Save account
    try {
      const accounts = JSON.parse(localStorage.getItem('termac_crm_accounts') || '[]');
      // Remove from leads
      const leads = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
      const li = leads.findIndex(l => l.id === leadOrAccount.id);
      if (li >= 0) { leads[li].status = 'won'; leads[li].wonDate = dateStr; leads[li].accountId = account.id; }
      localStorage.setItem('termac_crm_leads', JSON.stringify(leads));
      accounts.unshift(account);
      localStorage.setItem('termac_crm_accounts', JSON.stringify(accounts));
    } catch(e) {}
  }

  // 4b. Build job packet
  const jobPacket = _lcBuildJobPacket(account, estimateData, now);
  try {
    const jobs = JSON.parse(localStorage.getItem('unipro_jobs') || '[]');
    jobs.unshift(jobPacket);
    localStorage.setItem('unipro_jobs', JSON.stringify(jobs));
  } catch(e) {}

  // 4c. Scheduler alert
  _lcAlertScheduler(account, jobPacket);

  // 4d. Warehouse pull alert
  _lcAlertWarehouse(account, jobPacket, estimateData);

  // 4e. Tech pre-job brief (queued — tech sees on next portal load)
  _lcQueueTechBrief(account, jobPacket);

  // 4f. Customer confirmation email (Brevo wired — mailto fallback now)
  lcSendCustomerConfirmation(account, jobPacket);

  // 4g. Auto-schedule recurring services
  lcAutoScheduleRecurring(account);

  // 4h. Start cert expiration drip (Campaign 21 — 60-day notice)
  try {
    if (typeof DripEngine !== 'undefined') {
      new DripEngine().checkAndQueue(account);
    }
  } catch(e) {}

  // 4i. Notify management that a deal was won
  _lcNotifyWon(account, estimateData, rep);

  // 4j. Intelligence engine — onboarding loop
  if (typeof TermacIntelligence !== 'undefined') {
    TermacIntelligence.onJobComplete({
      jobId:        jobPacket.id,
      accountId:    account.id,
      accountName:  account.name,
      division:     (account.services||['UniPro'])[0],
      result:       'new_account',
      totalRevenue: estimateData?.total || 0,
      completedAt:  now,
    });
  }

  lcShowWonToast(biz, rep);
  return { account, jobPacket };
}

function _lcBuildAccount(lead, est, now) {
  return {
    id:             'acc_' + now,
    name:           lead.business || lead.name || 'New Account',
    business:       lead.business || lead.name || '',
    contact:        lead.contact || lead.name || '',
    phone:          lead.phone || '',
    email:          lead.email || '',
    address:        lead.address || '',
    zip:            lead.zip || '',
    city:           lead.city || '',
    status:         'active',
    lifecycleStage: 'active',
    services:       lead.services || (est?.divisions) || ['UniPro'],
    assignedRep:    lead.assignedRep || '',
    healthScore:    5,
    openDeficiencies: 0,
    annualValue:    est?.total ? est.total * (est.intervalMonths ? Math.round(12/est.intervalMonths) : 1) : 0,
    estimateAccepted: true,
    estimateDate:   new Date(now).toISOString().split('T')[0],
    sourceLeadId:   lead.id,
    source:         lead.source || 'Sales',
    created:        now,
    updated:        now,
    onboarding: {
      agreementSigned:  new Date(now).toISOString().split('T')[0],
      firstJobScheduled: null,
      firstServiceDone:  null,
      certIssued:        null,
      rep30dCheckin:     null,
    },
    serviceIntervals: lead.serviceIntervals || [],
    activityLog: [{
      ts: now, type:'won', icon:'🏆',
      title: 'Account Created — Estimate Accepted',
      note:  `Converted from lead ${lead.id}. Signed by ${lead.contact||lead.name}.`,
      who:   lead.assignedRep || 'Rep',
    }],
  };
}

function _lcBuildJobPacket(account, est, now) {
  const firstDiv = (account.services||['UniPro'])[0];
  return {
    id:          'job_' + now,
    accountId:   account.id,
    accountName: account.name,
    address:     account.address,
    zip:         account.zip,
    division:    firstDiv,
    serviceType: est?.lineItems?.map(function(li){return li.desc||li.name;}).join(', ') || 'Initial Service',
    status:      'pending_schedule',
    priority:    'high',
    date:        null,           // Scheduler assigns
    time:        null,
    techId:      null,           // Scheduler assigns
    revenue:     est?.total || 0,
    estimateRef: est?.id || null,
    notes:       `NEW ACCOUNT — First job. ${account.notes||''}`,
    created:     now,
    isFirstJob:  true,
  };
}

function _lcAlertScheduler(account, job) {
  try {
    const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
    alerts.unshift({
      id:      'sched_' + Date.now(),
      ts:      Date.now(),
      type:    'new_account_first_job',
      urgent:  true,
      account: account.name,
      address: account.address,
      zip:     account.zip,
      services: account.services,
      jobId:   job.id,
      note:    'New account — schedule first service ASAP. Rep: ' + (account.assignedRep||'—'),
    });
    localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
  } catch(e) {}

  // Email schedulers
  const subj = encodeURIComponent('📅 Schedule Needed — New Account: ' + account.name);
  const body = encodeURIComponent([
    'Aine, Jasmine, Samuel —',
    '',
    'A new account has been signed and needs its first job scheduled immediately.',
    '',
    'Account: ' + account.name,
    'Address: ' + account.address,
    'Services: ' + (account.services||[]).join(', '),
    'Rep: ' + (account.assignedRep||'—'),
    '',
    'Please schedule and confirm with the customer within 24 hours.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n'));
  window.open('mailto:acurran@termac.com,jpaez@termac.com,sholmes@termac.com?subject=' + subj + '&body=' + body, '_blank');
}

function _lcAlertWarehouse(account, job, est) {
  const items = est?.lineItems || [];
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    wa.unshift({
      id:        'wh_' + Date.now(),
      ts:        Date.now(),
      type:      'new_job_pull',
      status:    'pending',         // warehouse sets to 'pulled' or 'ready'
      confirmed: false,
      account:   account.name,
      jobId:     job.id,
      division:  job.division,
      items:     items.map(function(li){ return { name:li.desc||li.name, qty:li.qty||1, unit:li.unit||'ea' }; }),
      note:      'First job for new account — pull and stage before tech dispatch.',
    });
    localStorage.setItem('warehouse_alerts', JSON.stringify(wa));
  } catch(e) {}
}

function _lcQueueTechBrief(account, job) {
  try {
    const briefs = JSON.parse(localStorage.getItem('termac_tech_briefs') || '[]');
    briefs.unshift({
      id:       'brief_' + Date.now(),
      jobId:    job.id,
      account:  account.name,
      address:  account.address,
      zip:      account.zip,
      phone:    account.phone,
      contact:  account.contact,
      services: account.services,
      notes:    'NEW ACCOUNT — First visit. Introduce yourself, confirm scope, walk the property.',
      isFirst:  true,
      read:     false,
      ts:       Date.now(),
    });
    localStorage.setItem('termac_tech_briefs', JSON.stringify(briefs));
  } catch(e) {}
}

function _lcNotifyWon(account, est, rep) {
  const subj = encodeURIComponent('🏆 Deal Won — ' + account.name + ' · $' + (est?.total||0));
  const body = encodeURIComponent([
    'Jim, Tom, Ted —',
    '',
    'A new account was just signed.',
    '',
    'Account: ' + account.name,
    'Address: ' + account.address,
    'Services: ' + (account.services||[]).join(', '),
    'Estimate Total: $' + (est?.total||'—'),
    'Rep: ' + rep,
    'Signed: ' + new Date().toLocaleDateString('en-US'),
    '',
    'First job packet has been sent to scheduling and warehouse.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n'));
  window.open('mailto:jkennedy@termac.com,tpittakas@termac.com,tscholl@termac.com?subject=' + subj + '&body=' + body, '_blank');
}

function lcShowWonToast(biz, rep) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1E7B3C,#065F46);color:#fff;border-radius:12px;padding:18px 28px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:15px;z-index:9999;box-shadow:0 6px 32px rgba(0,0,0,.35);text-align:center;max-width:420px';
  t.innerHTML = `🏆 DEAL WON — ${biz}<br><span style="font-weight:500;font-size:12px">Account created · Scheduler + Warehouse notified · Customer confirmation sent</span>`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .5s'; t.style.opacity='0'; }, 5000);
  setTimeout(()=> t.remove(), 5500);
}

// ── 5. APPOINTMENT / OPPORTUNITY CREATION ────────────────────────────────
function lcSetAppointment(leadId) {
  const leads   = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
  const lead    = leads.find(function(l){ return l.id === leadId; });
  if (!lead) return;

  const dateStr = prompt('Appointment date (YYYY-MM-DD):');
  if (!dateStr) return;
  const timeStr = prompt('Appointment time (e.g. 10:00 AM):') || '';
  const notes   = prompt('Notes for the visit (optional):') || '';

  lead.status            = 'opportunity';
  lead.lifecycleStage    = 'opportunity';
  lead.appointmentDate   = dateStr;
  lead.appointmentTime   = timeStr;
  lead.updated           = Date.now();
  lead.activityLog = lead.activityLog || [];
  lead.activityLog.unshift({
    ts: Date.now(), type:'appointment', icon:'📅',
    title: 'Appointment Set — ' + dateStr + (timeStr?' @ '+timeStr:''),
    note:  notes || 'Site visit / assessment scheduled.',
    who:   (window._currentUser && window._currentUser.name) || 'Rep',
  });

  localStorage.setItem('termac_crm_leads', JSON.stringify(leads));

  // Alert scheduler with pending slot
  try {
    const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
    alerts.unshift({
      id:      'appt_' + Date.now(),
      ts:      Date.now(),
      type:    'appointment_pending',
      account: lead.business || lead.name,
      address: lead.address,
      date:    dateStr,
      time:    timeStr,
      rep:     lead.assignedRep,
      leadId:  leadId,
      note:    notes,
    });
    localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
  } catch(e) {}

  // Notify DMS to stop calling
  try {
    const dms = JSON.parse(localStorage.getItem('dms_coldcall') || '[]');
    const dr  = dms.find(function(r){ return (r.business||r.name||'').toLowerCase() === (lead.business||lead.name||'').toLowerCase(); });
    if (dr) { dr.dmsOutcome = 'appointment_set'; dr.appointmentDate = dateStr; }
    localStorage.setItem('dms_coldcall', JSON.stringify(dms));
  } catch(e) {}

  alert('Appointment set for ' + dateStr + '. Scheduler notified, DMS updated.');
  if (typeof renderCRMView === 'function') renderCRMView();
}

// ── 6. DEFICIENCY → LEXI HIGH-PRIORITY NOTIFICATION ──────────────────────
function lcFlagDeficiency(defData) {
  // defData: { accountId, accountName, address, description, severity, techId, jobId, canFixNow, partsNeeded }
  if (!defData) return;
  const now     = Date.now();
  const isUrgent = defData.severity === 'high' || defData.severity === 'critical';

  // Store deficiency record
  try {
    const defs = JSON.parse(localStorage.getItem('termac_deficiencies') || '[]');
    defs.unshift({
      id:           'def_' + now,
      ts:           now,
      date:         new Date(now).toISOString().split('T')[0],
      accountId:    defData.accountId,
      accountName:  defData.accountName,
      address:      defData.address,
      description:  defData.description,
      severity:     defData.severity || 'normal',
      techId:       defData.techId,
      jobId:        defData.jobId,
      canFixNow:    defData.canFixNow || false,
      partsNeeded:  defData.partsNeeded || '',
      status:       'open',
      quoteId:      null,
      quoteBuilt:   false,
      resolved:     false,
    });
    localStorage.setItem('termac_deficiencies', JSON.stringify(defs));
  } catch(e) {}

  // Update account openDeficiencies count
  try {
    const accounts = JSON.parse(localStorage.getItem('termac_crm_accounts') || '[]');
    const acct = accounts.find(function(a){ return a.id === defData.accountId; });
    if (acct) {
      acct.openDeficiencies = (acct.openDeficiencies || 0) + 1;
      acct.activityLog = acct.activityLog || [];
      acct.activityLog.unshift({
        ts: now, type:'deficiency', icon:'⚠️',
        title: 'Deficiency Flagged — ' + (defData.severity||'normal').toUpperCase(),
        note:  defData.description + (defData.partsNeeded ? ' | Parts: ' + defData.partsNeeded : ''),
        who:   defData.techId || 'Tech',
      });
      localStorage.setItem('termac_crm_accounts', JSON.stringify(accounts));
    }
  } catch(e) {}

  // High-priority notification to Lexi
  const urgLabel = isUrgent ? '🚨 URGENT DEFICIENCY' : '⚠️ Deficiency';
  const subj     = encodeURIComponent(urgLabel + ' — ' + defData.accountName + ' · Quote Needed');
  const bodyText = [
    'Lexi,',
    '',
    (isUrgent ? 'URGENT: ' : '') + 'A deficiency has been flagged during a field inspection and requires a quote.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'DEFICIENCY DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Account:      ' + defData.accountName,
    'Address:      ' + (defData.address||'—'),
    'Severity:     ' + (defData.severity||'Normal').toUpperCase(),
    'Description:  ' + defData.description,
    'Can Fix Now:  ' + (defData.canFixNow ? 'YES — Tech is on site' : 'NO — Return visit needed'),
    'Parts Needed: ' + (defData.partsNeeded || 'None specified'),
    'Tech:         ' + (defData.techId || '—'),
    'Job Ref:      ' + (defData.jobId || '—'),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'ACTION REQUIRED',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    defData.canFixNow
      ? 'Tech is ON SITE and can fix now if parts are available. Contact the tech immediately to confirm and approve.'
      : 'Build a quote for repair and send to the customer. Schedule a return visit.',
    isUrgent ? 'FIRE SAFETY DEFICIENCY — Every hour of delay is a liability. Quote within 2 hours.' : 'Please build and send quote within 48 hours.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n');

  // Email Lexi + CC Jim + Tom for urgent
  const toLexiPlusCC = isUrgent
    ? 'lcranfield@termac.com?cc=jkennedy@termac.com,tpittakas@termac.com,tscholl@termac.com'
    : 'lcranfield@termac.com?cc=tscholl@termac.com';

  window.open('mailto:' + toLexiPlusCC + '&subject=' + subj + '&body=' + encodeURIComponent(bodyText), '_blank');

  // In-app notification
  if (typeof _storeInAppNotif === 'function') {
    _storeInAppNotif({
      type:      isUrgent ? 'urgent_response' : 'deficiency',
      icon:      isUrgent ? '🚨' : '⚠️',
      urgent:    isUrgent,
      title:     urgLabel + ' — ' + defData.accountName,
      body:      defData.description + (defData.canFixNow ? ' · Tech on site — can fix now' : ' · Return visit needed'),
      recipient: 'Lexi Cranfield',
      email:     'lcranfield@termac.com',
    });
  }
}

// ── 7. AUTO-SCHEDULING CADENCE ────────────────────────────────────────────
// Generates the recurring job schedule for an account based on its service intervals.
function lcAutoScheduleRecurring(account) {
  if (!account || !account.serviceIntervals || !account.serviceIntervals.length) return;
  const now     = Date.now();
  const existingJobs = JSON.parse(localStorage.getItem('unipro_jobs') || '[]');

  let added = 0;
  account.serviceIntervals.forEach(function(intervalKey) {
    const def = SERVICE_INTERVALS[intervalKey];
    if (!def) return;

    // Generate next 4 occurrences
    let nextDate = lcIntervalNextDue(intervalKey, new Date());
    for (let i = 0; i < 4; i++) {
      const jobId = 'recur_' + account.id + '_' + intervalKey + '_' + i + '_' + now;
      // Check if already scheduled
      if (existingJobs.some(function(j){ return j.accountId===account.id && j.date===nextDate && j.serviceType===def.label; })) {
        nextDate = lcIntervalNextDue(intervalKey, nextDate);
        continue;
      }
      existingJobs.push({
        id:          jobId,
        accountId:   account.id,
        accountName: account.name,
        address:     account.address,
        zip:         account.zip,
        division:    _lcDivisionFromInterval(intervalKey),
        serviceType: def.label,
        nfpaCode:    def.nfpa || null,
        status:      'pending_schedule',
        date:        nextDate,
        time:        null,
        techId:      null,
        priority:    'normal',
        revenue:     0,
        isRecurring: true,
        intervalKey: intervalKey,
        notes:       def.nfpa ? def.nfpa + ' required' : 'Recurring per site survey agreement.',
        created:     now,
      });
      nextDate = lcIntervalNextDue(intervalKey, nextDate);
      added++;
    }
  });

  localStorage.setItem('unipro_jobs', JSON.stringify(existingJobs));

  // Alert scheduler of new recurring jobs
  if (added > 0) {
    try {
      const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
      alerts.unshift({
        id:      'recur_' + now,
        ts:      now,
        type:    'recurring_jobs_added',
        account: account.name,
        count:   added,
        note:    added + ' recurring jobs auto-scheduled for ' + account.name + '. Assign techs in scheduler.',
      });
      localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
    } catch(e) {}
  }
}

function _lcDivisionFromInterval(key) {
  if (key.startsWith('gto'))        return 'GTO';
  if (key.startsWith('filterman'))  return 'Filter Man';
  if (key.startsWith('termac'))     return 'Termac';
  if (key.startsWith('allpro'))     return 'AllPro';
  return 'UniPro';
}

// ── 8. WAREHOUSE BIDIRECTIONAL CONFIRMATION ────────────────────────────────
// Warehouse portal calls lcWarehouseConfirmPull() when items are staged.
// Tech portal polls lcGetWarehouseStatus() before departing.
function lcWarehouseConfirmPull(alertId, warehouseStaffName, notes) {
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    const alert = wa.find(function(a){ return a.id === alertId; });
    if (!alert) return false;
    alert.status    = 'ready';
    alert.confirmed = true;
    alert.confirmedBy   = warehouseStaffName || 'Warehouse';
    alert.confirmedAt   = Date.now();
    alert.warehouseNotes = notes || '';
    localStorage.setItem('warehouse_alerts', JSON.stringify(wa));

    // Queue a notification for the tech
    try {
      const briefs = JSON.parse(localStorage.getItem('termac_tech_briefs') || '[]');
      const brief  = briefs.find(function(b){ return b.jobId === alert.jobId; });
      if (brief) {
        brief.warehouseReady  = true;
        brief.warehouseNotes  = notes || 'Items pulled and staged.';
        brief.warehouseReadyAt = Date.now();
        localStorage.setItem('termac_tech_briefs', JSON.stringify(briefs));
      }
    } catch(e) {}

    return true;
  } catch(e) { return false; }
}

function lcGetWarehouseStatus(jobId) {
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    const alert = wa.find(function(a){ return a.jobId === jobId; });
    if (!alert) return { status:'no_pull_request', confirmed:false };
    return {
      status:     alert.status || 'pending',
      confirmed:  alert.confirmed || false,
      items:      alert.items || [],
      confirmedBy: alert.confirmedBy || null,
      notes:      alert.warehouseNotes || null,
    };
  } catch(e) { return { status:'error', confirmed:false }; }
}

// ── 9. CUSTOMER-FACING CONFIRMATION EMAIL ─────────────────────────────────
// Brevo-wired. mailto fallback now. Auto-fires on account creation + job schedule.
function lcSendCustomerConfirmation(account, job) {
  if (!account.email) return; // no email on file — skip

  const dateStr = job.date
    ? new Date(job.date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
    : 'as soon as we schedule — our team will call you within 24 hours';
  const timeStr = job.time ? ' at ' + job.time : '';
  const tech    = 'Our certified technician'; // real tech name added when scheduled

  const subj = encodeURIComponent('Your Appointment is Confirmed — ' + (account.services||['UniPro']).join(', '));
  const bodyText = [
    'Dear ' + (account.contact || account.name) + ',',
    '',
    'Thank you for choosing Universal Fire Protection / Termac Family of Companies.',
    'Your service appointment has been confirmed. Here are your details:',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'APPOINTMENT DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Account:   ' + account.name,
    'Address:   ' + account.address,
    'Services:  ' + (account.services||[]).join(', '),
    'Date:      ' + dateStr + timeStr,
    'Tech:      ' + tech,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'WHAT TO EXPECT',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '• Our technician will arrive in a marked Termac vehicle',
    '• Please ensure access to all areas to be inspected',
    '• The inspection typically takes 45-90 minutes depending on scope',
    '• You will receive a detailed service report and certificate upon completion',
    '',
    'Questions? Contact your service rep:',
    'Ted Scholl · tscholl@termac.com · 267-421-6336',
    '',
    'Thank you for your business.',
    '',
    'Universal Fire Protection / Termac Family of Companies',
    'https://coachted-retro.github.io/unipro-sales',
  ].join('\n');

  // TODO at Brevo go-live: replace window.open with Brevo transactional email API call
  // using BREVO_API_KEY and template ID for customer confirmations.
  window.open('mailto:' + encodeURIComponent(account.email) + '?subject=' + subj + '&body=' + encodeURIComponent(bodyText), '_blank');
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
window.TermacLifecycle = {
  notifyNewLead:            lcNotifyNewLead,
  rcpCreateLead:            lcRcpCreateLead,
  routeHarvestedLeads:      lcRouteHarvestedLeads,
  wonLead:                  lcWonLead,
  setAppointment:           lcSetAppointment,
  flagDeficiency:           lcFlagDeficiency,
  autoScheduleRecurring:    lcAutoScheduleRecurring,
  warehouseConfirmPull:     lcWarehouseConfirmPull,
  getWarehouseStatus:       lcGetWarehouseStatus,
  sendCustomerConfirmation: lcSendCustomerConfirmation,
  SERVICE_INTERVALS,
};

console.log('[Termac Lifecycle Engine v1.0] Loaded — 9 lifecycle loops ready');
