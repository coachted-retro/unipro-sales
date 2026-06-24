/**
 * TERMAC INTELLIGENCE ENGINE v1.0
 * Shared closed-loop intelligence layer across all Termac One portals.
 * 
 * Handles:
 *   Loop 1 — Job completion → account feedback (lastService, churn reset, next interval, rep credit)
 *   Loop 2 — Cross-division upsell auto-lead creation + rep notification
 *   Loop 3 — HR cert gating → scheduler eligibility + scorecard → HR coaching flag
 *   Loop 4 — Predictive scheduling alerts from service interval data
 *   Loop 5 — Warehouse parts → job COGS deduction + margin calculation
 *   Loop 6 — DMS objection aggregation → pricing/positioning intelligence
 *   Loop 7 — Learning Center completions → HR cert records + scheduler eligibility
 * 
 * All functions are safe to call from any portal — they read/write only
 * to shared localStorage keys and never depend on portal-specific globals.
 */

(function(global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // SHARED STORAGE HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  function tiRead(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch(e) { return fallback; }
  }
  function tiWrite(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch(e) { console.warn('[TI] Write failed:', key, e); return false; }
  }
  function tiLog(msg) { console.log('[Termac Intelligence]', msg); }

  // ─────────────────────────────────────────────────────────────────────────
  // NOTIFICATION QUEUE — cross-portal alert system
  // Any portal can push a notification; manager dashboard reads them
  // ─────────────────────────────────────────────────────────────────────────
  function tiNotify(notification) {
    // notification: { type, title, body, accountId, repName, division, priority, ts, action }
    const queue = tiRead('termac_ti_notifications', []);
    queue.unshift({
      id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      ts: Date.now(),
      read: false,
      ...notification
    });
    // Keep last 100
    if (queue.length > 100) queue.splice(100);
    tiWrite('termac_ti_notifications', queue);
    tiLog(`Notification queued: ${notification.title}`);
  }

  function tiGetNotifications(unreadOnly) {
    const q = tiRead('termac_ti_notifications', []);
    return unreadOnly ? q.filter(n => !n.read) : q;
  }

  function tiMarkRead(id) {
    const q = tiRead('termac_ti_notifications', []);
    const n = q.find(n => n.id === id);
    if (n) { n.read = true; tiWrite('termac_ti_notifications', q); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 1 — JOB COMPLETION → ACCOUNT FEEDBACK
  // Call this when a work order is marked complete in the tech portal.
  // ─────────────────────────────────────────────────────────────────────────
  function tiOnJobComplete(jobData) {
    /*
      jobData: {
        jobId, accountName, accountId (optional), address, zip,
        division,     // 'unipro' | 'gto' | 'filterman' | 'allpro' | 'termac' | 'quality3'
        serviceType,  // 'inspection' | 'service' | 'estimate'
        techName, techId,
        assignedRep,
        result,       // 'pass' | 'pass_deficiency' | 'fail' | 'completed'
        totalRevenue, // invoice total
        deficiencies, // array of deficiency strings
        partsUsed,    // array of { sku, name, qty, unitCost }
        completedAt,  // timestamp
        nfpaCode,     // e.g. 'NFPA 10' | 'NFPA 96' | 'GTO'
        nextIntervalMonths, // e.g. 12 for annual, 6 for semi-annual, 1 for monthly
      }
    */
    tiLog(`Loop 1: Job complete — ${jobData.accountName} / ${jobData.division}`);

    const now = Date.now();
    const completedAt = jobData.completedAt || now;
    const nextDue = jobData.nextIntervalMonths
      ? new Date(completedAt + jobData.nextIntervalMonths * 30.44 * 86400000).toISOString().split('T')[0]
      : null;

    // ── 1a: Update account record ──────────────────────────────────────────
    const accounts = tiRead('termac_crm_accounts', []);
    let account = accounts.find(a =>
      a.id === jobData.accountId ||
      (a.name || a.business || '').toLowerCase() === (jobData.accountName || '').toLowerCase()
    );

    if (account) {
      // Update service dates
      account.lastService = new Date(completedAt).toISOString().split('T')[0];
      account.lastServiceTs = completedAt;
      if (nextDue) account.nextDue = nextDue;

      // Reset health score on successful service (churn goes down after a visit)
      if (jobData.result === 'pass' || jobData.result === 'completed') {
        account.healthScore = Math.min((account.healthScore || 3) + 2, 10);
        account.lastCheckin = now;
      }

      // Update open deficiencies count
      if (jobData.deficiencies && jobData.deficiencies.length > 0) {
        account.openDeficiencies = (account.openDeficiencies || 0) + jobData.deficiencies.length;
      } else if (jobData.result === 'pass' || jobData.result === 'completed') {
        // Clear deficiencies if job passed clean
        account.openDeficiencies = 0;
      }

      // Append to service history
      if (!account.serviceHistory) account.serviceHistory = [];
      account.serviceHistory.unshift({
        date: new Date(completedAt).toISOString().split('T')[0],
        division: jobData.division,
        service: jobData.serviceType || jobData.division,
        tech: jobData.techName,
        result: jobData.result === 'pass' ? 'Passed' : jobData.result === 'pass_deficiency' ? 'Passed with Deficiencies' : 'Completed',
        nextDue,
        revenue: jobData.totalRevenue || 0
      });
      // Keep last 24 service history entries
      if (account.serviceHistory.length > 24) account.serviceHistory.splice(24);

      // Update annual value estimate based on actuals
      if (jobData.totalRevenue && jobData.totalRevenue > 0) {
        const history = account.serviceHistory.slice(0, 12);
        const totalRevLY = history.reduce((s, h) => s + (h.revenue || 0), 0);
        if (totalRevLY > 0) account.annualValue = Math.round(totalRevLY);
      }

      // Update cert status for fire inspections
      if (nextDue && (jobData.nfpaCode || '').includes('NFPA') && jobData.result !== 'fail') {
        account.certStatus = {
          issuedDate: new Date(completedAt).toISOString().split('T')[0],
          expiryDate: nextDue,
          pendingAHJ: true // office needs to submit
        };
      }

      tiWrite('termac_crm_accounts', accounts);
      tiLog(`Loop 1a: Account updated — ${account.name}, nextDue: ${nextDue}`);
    } else {
      tiLog(`Loop 1a: Account not found for "${jobData.accountName}" — skipping account update`);
    }

    // ── 1b: Schedule next service reminder ────────────────────────────────
    if (nextDue) {
      const reminders = tiRead('termac_service_reminders', []);
      // Remove old reminder for same account+division
      const filtered = reminders.filter(r =>
        !(r.accountName === jobData.accountName && r.division === jobData.division)
      );
      filtered.push({
        id: 'rem_' + now,
        accountName: jobData.accountName,
        accountId: jobData.accountId || (account && account.id),
        address: jobData.address,
        zip: jobData.zip,
        division: jobData.division,
        nfpaCode: jobData.nfpaCode,
        nextDue,
        assignedRep: jobData.assignedRep,
        techName: jobData.techName,
        createdAt: now
      });
      tiWrite('termac_service_reminders', filtered);
      tiLog(`Loop 1b: Service reminder set for ${jobData.accountName} → ${nextDue}`);
    }

    // ── 1c: Credit rep performance metrics ────────────────────────────────
    if (jobData.assignedRep && jobData.totalRevenue > 0) {
      const repMetrics = tiRead('termac_rep_metrics', {});
      const rep = repMetrics[jobData.assignedRep] || {
        name: jobData.assignedRep,
        jobsCompleted: 0,
        totalRevenue: 0,
        deficienciesFound: 0,
        crossSellsCreated: 0,
        accountsServiced: []
      };
      rep.jobsCompleted = (rep.jobsCompleted || 0) + 1;
      rep.totalRevenue = (rep.totalRevenue || 0) + (jobData.totalRevenue || 0);
      rep.deficienciesFound = (rep.deficienciesFound || 0) + (jobData.deficiencies || []).length;
      if (account && !rep.accountsServiced.includes(account.id)) {
        rep.accountsServiced.push(account.id);
      }
      rep.lastActivity = now;
      repMetrics[jobData.assignedRep] = rep;
      tiWrite('termac_rep_metrics', repMetrics);
      tiLog(`Loop 1c: Rep metrics updated for ${jobData.assignedRep}`);
    }

    // ── 1d: Route deficiencies to office queue ────────────────────────────
    if (jobData.deficiencies && jobData.deficiencies.length > 0) {
      const defQueue = tiRead('termac_deficiency_queue', []);
      jobData.deficiencies.forEach(def => {
        defQueue.push({
          id: 'def_' + now + '_' + Math.random().toString(36).slice(2,5),
          accountName: jobData.accountName,
          accountId: jobData.accountId || (account && account.id),
          address: jobData.address,
          division: jobData.division,
          techName: jobData.techName,
          deficiency: def,
          jobId: jobData.jobId,
          status: 'pending_quote',
          createdAt: now,
          assignedRep: jobData.assignedRep
        });
      });
      tiWrite('termac_deficiency_queue', defQueue);

      tiNotify({
        type: 'deficiency',
        title: `${jobData.deficiencies.length} deficiencie${jobData.deficiencies.length > 1 ? 's' : ''} logged — ${jobData.accountName}`,
        body: `${jobData.techName} flagged ${jobData.deficiencies.length} item${jobData.deficiencies.length > 1 ? 's' : ''} at ${jobData.accountName}. Quote required.`,
        accountId: account && account.id,
        division: jobData.division,
        priority: 'high',
        action: 'ops_deficiency'
      });
      tiLog(`Loop 1d: ${jobData.deficiencies.length} deficiencies routed to office`);
    }

    // ── 1e: AHJ submission flag for compliance forms ──────────────────────
    if (jobData.complianceFormSubmitted && jobData.nfpaCode) {
      const certQueue = tiRead('termac_cert_ahj_queue', []);
      certQueue.push({
        id: 'cert_' + now,
        accountName: jobData.accountName,
        accountId: account && account.id,
        address: jobData.address,
        nfpaCode: jobData.nfpaCode,
        issuedDate: new Date(completedAt).toISOString().split('T')[0],
        expiryDate: nextDue,
        techName: jobData.techName,
        status: 'pending_ahj',
        createdAt: now
      });
      tiWrite('termac_cert_ahj_queue', certQueue);
      tiLog(`Loop 1e: Cert queued for AHJ submission — ${jobData.accountName}`);
    }

    return { success: true, account, nextDue };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 2 — CROSS-DIVISION UPSELL AUTO-LEAD + REP NOTIFICATION
  // Call when tech observes a cross-sell opportunity OR when account
  // analysis detects missing services.
  // ─────────────────────────────────────────────────────────────────────────
  function tiCreateCrossSellLead(data) {
    /*
      data: {
        accountName, accountId, address, zip,
        currentDivision,   // what they already have
        targetDivision,    // what they need
        observation,       // what the tech saw / reason for flag
        techName,
        assignedRep,       // who to route to
        urgency            // 'hot' | 'warm' | 'cold'
      }
    */
    tiLog(`Loop 2: Cross-sell lead — ${data.accountName} → ${data.targetDivision}`);

    const divLabel = {
      unipro: 'UniPro — Fire Protection',
      filterman: 'Filter Man — Hood Filters',
      gto: 'GTO — Grease Trap',
      allpro: 'AllPro — Stainless Fabrication',
      quality3: 'Quality III — Fire (DE)',
      termac: 'Termac — Dish Machine & Supplies'
    };

    const now = Date.now();
    const leads = tiRead('termac_leads', []);

    // Dedup — don't create if same account+division already has an open lead
    const existing = leads.find(l =>
      (l.business || l.name || '').toLowerCase() === (data.accountName || '').toLowerCase() &&
      (l.services || []).includes(data.targetDivision) &&
      l.status !== 'lost' && l.status !== 'disqualified'
    );
    if (existing) {
      tiLog(`Loop 2: Duplicate suppressed — lead already exists for ${data.accountName} / ${data.targetDivision}`);
      return { duplicate: true, existingId: existing.id };
    }

    const newLead = {
      id: 'XS_' + now,
      name: data.accountName,
      business: data.accountName,
      address: data.address || '',
      zip: data.zip || '',
      services: [data.targetDivision],
      status: data.urgency || 'hot',
      score: data.urgency === 'hot' ? 9 : data.urgency === 'warm' ? 7 : 5,
      source: 'Tech Cross-Sell',
      sourceDetail: `${data.techName} observed during ${data.currentDivision} service visit`,
      assignedRep: data.assignedRep || 'Unassigned',
      notes: data.observation || `Cross-sell opportunity: ${divLabel[data.targetDivision] || data.targetDivision} needed`,
      crossSellFrom: data.currentDivision,
      existingAccountId: data.accountId,
      created: now,
      updated: now
    };

    leads.unshift(newLead);
    tiWrite('termac_leads', leads);

    // Also write to crm_leads for sales portal
    const crmLeads = tiRead('crm_leads', []);
    crmLeads.unshift(newLead);
    tiWrite('crm_leads', crmLeads);

    // Notify assigned rep
    tiNotify({
      type: 'cross_sell',
      title: `🔥 Cross-sell lead: ${data.accountName}`,
      body: `${data.techName} flagged ${divLabel[data.targetDivision] || data.targetDivision} opportunity. ${data.observation || ''}`,
      accountId: data.accountId,
      repName: data.assignedRep,
      division: data.targetDivision,
      priority: data.urgency === 'hot' ? 'high' : 'medium',
      action: 'leads'
    });

    tiLog(`Loop 2: Lead created — ${data.accountName} → ${data.targetDivision}, assigned to ${data.assignedRep}`);
    return { success: true, leadId: newLead.id };
  }

  // Run account analysis to auto-detect cross-sell gaps
  function tiAnalyzeCrossSellGaps() {
    const accounts = tiRead('termac_crm_accounts', []);
    const gaps = [];
    const allDivisions = ['unipro', 'gto', 'filterman'];

    accounts.filter(a => a.status === 'active').forEach(account => {
      const has = (account.services || []).map(s => s.toLowerCase());
      // GTO customer without UniPro — most common cross-sell
      if (has.includes('gto') && !has.includes('unipro')) {
        gaps.push({ account, missing: 'unipro', reason: 'GTO customer — extinguisher inspection cross-sell' });
      }
      // Filter Man without GTO — hood filter + grease trap bundle
      if (has.includes('filterman') && !has.includes('gto')) {
        gaps.push({ account, missing: 'gto', reason: 'Filter Man customer — grease trap bundle opportunity' });
      }
      // UniPro without Filter Man — fire inspection customer likely has commercial kitchen
      if (has.includes('unipro') && !has.includes('filterman') && has.length === 1) {
        gaps.push({ account, missing: 'filterman', reason: 'UniPro-only — likely has hood filters needing exchange' });
      }
    });

    tiWrite('termac_ti_xsell_gaps', { gaps, analyzedAt: Date.now() });
    tiLog(`Loop 2: Cross-sell gap analysis — ${gaps.length} opportunities found`);
    return gaps;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 3 — HR CERT GATING + SCORECARD → COACHING FLAG
  // ─────────────────────────────────────────────────────────────────────────

  // Job types that require specific certifications
  var JOB_CERT_REQUIREMENTS = {
    'nfpa10':   ['NICET Fire Protection', 'NICET Level I', 'NICET Level II', 'Fire Extinguisher Cert'],
    'nfpa96':   ['NICET Fire Protection', 'NICET Level II', 'Hood Suppression Cert'],
    'nfpa25':   ['NICET Level II', 'NICET Level III', 'Sprinkler Inspection'],
    'nfpa72':   ['NICET Fire Alarm', 'Fire Alarm Inspector'],
    'gto':      ['DOT/CDL', 'FOG Handler Cert'],
    'cdl':      ['DOT/CDL', 'CDL Class B'],
    'firstaid': ['First Aid/CPR/AED']
  };

  function tiCheckTechEligibility(techName, jobType) {
    /*
      Returns { eligible: bool, missingCerts: [], expiredCerts: [] }
    */
    const certs = tiRead('termac_hr_certs', []);
    const users = tiRead('termac_hr_users', []);
    const user = users.find(u => u.name === techName);
    if (!user) return { eligible: true, missingCerts: [], expiredCerts: [], noRecord: true };

    const required = JOB_CERT_REQUIREMENTS[jobType] || [];
    if (!required.length) return { eligible: true, missingCerts: [], expiredCerts: [] };

    const techCerts = certs.filter(c => c.userId === user.id);
    const today = new Date();
    const missing = [];
    const expired = [];

    required.forEach(req => {
      const match = techCerts.find(c => (c.name || '').includes(req.split(' ')[0]));
      if (!match) {
        missing.push(req);
      } else if (match.expiry) {
        const expDate = new Date(match.expiry);
        if (expDate < today) expired.push({ cert: req, expiredOn: match.expiry });
      }
    });

    return {
      eligible: missing.length === 0 && expired.length === 0,
      missingCerts: missing,
      expiredCerts: expired
    };
  }

  function tiCheckScorecardCoachingFlags() {
    // Reads tech scorecard data and flags declining performers to HR
    const scorecards = tiRead('termac_tech_scorecards', []);
    const flags = [];

    scorecards.forEach(tech => {
      const score = tech.score || tech.qScore || 0;
      const ftfr = tech.ftfr || 0;
      const satisfaction = tech.satisfaction || 0;

      if (score < 75 || ftfr < 75 || satisfaction < 4.0) {
        flags.push({
          techName: tech.name,
          techId: tech.id,
          score,
          ftfr,
          satisfaction,
          flagReason: score < 75 ? 'Overall score below threshold' : ftfr < 75 ? 'First-time fix rate low' : 'Customer satisfaction declining',
          flaggedAt: Date.now()
        });
      }
    });

    if (flags.length > 0) {
      tiWrite('termac_hr_coaching_flags', flags);
      flags.forEach(f => {
        tiNotify({
          type: 'coaching_flag',
          title: `📉 Coaching flag: ${f.techName}`,
          body: `${f.flagReason}. Score: ${f.score}, FTFR: ${f.ftfr}%, Satisfaction: ${f.satisfaction}/5`,
          priority: 'medium',
          action: 'hr_coaching'
        });
      });
      tiLog(`Loop 3: ${flags.length} coaching flags written to HR`);
    }

    return flags;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 4 — PREDICTIVE SCHEDULING ALERTS
  // Run this daily (on scheduler portal load) to surface accounts with
  // upcoming service intervals and no job scheduled.
  // ─────────────────────────────────────────────────────────────────────────
  function tiGetSchedulingAlerts(daysAhead) {
    daysAhead = daysAhead || 30;
    const accounts = tiRead('termac_crm_accounts', []);
    const schedulerEvents = tiRead('termac_scheduler_events', []);
    const reminders = tiRead('termac_service_reminders', []);
    const today = new Date();
    const cutoff = new Date(today.getTime() + daysAhead * 86400000);
    const alerts = [];

    // Check accounts with nextDue within window
    accounts.filter(a => a.status === 'active' && a.nextDue).forEach(account => {
      const due = new Date(account.nextDue);
      if (due <= cutoff && due >= today) {
        // Check if already scheduled
        const scheduled = schedulerEvents.some(e =>
          (e.account || '').toLowerCase().includes((account.name || account.business || '').toLowerCase().split(' ')[0]) &&
          new Date(e.date || e.start) >= today
        );

        if (!scheduled) {
          const daysUntilDue = Math.round((due - today) / 86400000);
          alerts.push({
            accountId: account.id,
            accountName: account.name || account.business,
            address: account.address || account.city,
            assignedRep: account.assignedRep,
            services: account.services || [],
            nextDue: account.nextDue,
            daysUntilDue,
            urgency: daysUntilDue <= 7 ? 'critical' : daysUntilDue <= 14 ? 'high' : 'medium',
            annualValue: account.annualValue || 0
          });
        }
      }
    });

    // Sort by urgency then days until due
    alerts.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

    tiWrite('termac_ti_scheduling_alerts', { alerts, generatedAt: Date.now(), daysAhead });
    tiLog(`Loop 4: ${alerts.length} scheduling alerts generated (${daysAhead}-day window)`);
    return alerts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 5 — WAREHOUSE PARTS → JOB COGS + MARGIN
  // Call when a work order is completed with parts used.
  // ─────────────────────────────────────────────────────────────────────────
  function tiDeductPartsFromInventory(partsUsed, jobId, accountName) {
    /*
      partsUsed: [{ sku, name, qty, unitCost }]
    */
    if (!partsUsed || !partsUsed.length) return { success: true, totalCogs: 0 };
    tiLog(`Loop 5: Deducting ${partsUsed.length} part types for job ${jobId}`);

    const inventory = tiRead('termac_wms_inventory', []);
    let totalCogs = 0;
    const deductions = [];
    const notFound = [];

    partsUsed.forEach(part => {
      const item = inventory.find(i =>
        i.sku === part.sku ||
        (i.name || '').toLowerCase().includes((part.name || '').toLowerCase().split(' ')[0])
      );
      if (item) {
        const qtyBefore = item.qoh || item.qty || 0;
        item.qoh = Math.max(0, qtyBefore - (part.qty || 1));
        item.qty = item.qoh;
        const cogs = (part.qty || 1) * (part.unitCost || item.unitCost || item.cost || 0);
        totalCogs += cogs;
        deductions.push({ sku: item.sku, name: item.name, qty: part.qty, cogs, qohBefore: qtyBefore, qohAfter: item.qoh });

        // Reorder alert if below reorder point
        if (item.qoh <= (item.reorderPoint || item.minQty || 0)) {
          tiNotify({
            type: 'reorder_alert',
            title: `📦 Reorder needed: ${item.name}`,
            body: `QOH dropped to ${item.qoh} after job at ${accountName}. Reorder point: ${item.reorderPoint || 0}.`,
            priority: 'medium',
            action: 'warehouse_reorder'
          });
        }
      } else {
        notFound.push(part.name || part.sku);
      }
    });

    tiWrite('termac_wms_inventory', inventory);

    // Record job COGS
    const jobCogs = tiRead('termac_job_cogs', []);
    jobCogs.push({
      jobId, accountName, partsUsed: deductions,
      totalCogs, recordedAt: Date.now()
    });
    tiWrite('termac_job_cogs', jobCogs);

    tiLog(`Loop 5: COGS $${totalCogs.toFixed(2)} recorded for job ${jobId}`);
    return { success: true, totalCogs, deductions, notFound };
  }

  function tiGetJobMargin(jobId, revenue) {
    const jobCogs = tiRead('termac_job_cogs', []);
    const record = jobCogs.find(j => j.jobId === jobId);
    const cogs = record ? record.totalCogs : 0;
    const margin = revenue - cogs;
    const marginPct = revenue > 0 ? Math.round((margin / revenue) * 100) : 0;
    return { cogs, margin, marginPct, hasData: !!record };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 6 — DMS OBJECTION AGGREGATION → PRICING INTELLIGENCE
  // Call after every DMS call log save.
  // ─────────────────────────────────────────────────────────────────────────
  function tiLogDMSOutcome(callData) {
    /*
      callData: {
        leadId, leadName, outcome, objectionReason, notes,
        division, zip, repName, ts
      }
    */
    const log = tiRead('termac_dms_intelligence', { calls: [], objections: {}, outcomes: {} });

    // Track outcome distribution
    const outcome = callData.outcome || 'unknown';
    log.outcomes[outcome] = (log.outcomes[outcome] || 0) + 1;

    // Aggregate objections
    if (callData.objectionReason) {
      const obj = callData.objectionReason;
      log.objections[obj] = (log.objections[obj] || 0) + 1;
    }

    // Tag pricing objections specifically
    const notes = (callData.notes || '').toLowerCase();
    const isPricingObjection = notes.includes('price') || notes.includes('too expensive') ||
      notes.includes('cheaper') || notes.includes('competitor') || notes.includes('lower');

    if (isPricingObjection) {
      if (!log.pricingObjections) log.pricingObjections = [];
      log.pricingObjections.push({
        leadName: callData.leadName,
        division: callData.division,
        zip: callData.zip,
        notes: callData.notes,
        ts: callData.ts || Date.now()
      });
      // Keep last 50
      if (log.pricingObjections.length > 50) log.pricingObjections.splice(50);
    }

    // Append to call log
    log.calls.push({
      ...callData,
      isPricingObjection,
      loggedAt: Date.now()
    });
    // Keep last 500
    if (log.calls.length > 500) log.calls.splice(500);

    log.lastUpdated = Date.now();
    tiWrite('termac_dms_intelligence', log);

    // Generate pricing signal if pricing objections spike
    const recentPricingObj = (log.pricingObjections || []).filter(
      p => p.ts > Date.now() - 30 * 86400000
    );
    if (recentPricingObj.length >= 5) {
      const divCounts = {};
      recentPricingObj.forEach(p => { divCounts[p.division] = (divCounts[p.division] || 0) + 1; });
      const topDiv = Object.entries(divCounts).sort((a,b) => b[1]-a[1])[0];
      tiNotify({
        type: 'pricing_signal',
        title: `💰 Pricing pressure detected — ${topDiv ? topDiv[0] : 'multiple divisions'}`,
        body: `${recentPricingObj.length} pricing objections in the last 30 days. DMS team flagging cost as primary barrier. Review bundle pricing or competitive positioning.`,
        priority: 'medium',
        action: 'dms_intelligence'
      });
    }

    tiLog(`Loop 6: DMS outcome logged — ${outcome}, pricing objection: ${isPricingObjection}`);
  }

  function tiGetDMSIntelligence() {
    const log = tiRead('termac_dms_intelligence', { calls: [], objections: {}, outcomes: {} });
    const last30 = log.calls.filter(c => (c.loggedAt || 0) > Date.now() - 30 * 86400000);
    const pricingObjRate = last30.length > 0
      ? Math.round((last30.filter(c => c.isPricingObjection).length / last30.length) * 100)
      : 0;

    return {
      totalCalls: log.calls.length,
      last30Days: last30.length,
      outcomes: log.outcomes,
      topObjections: Object.entries(log.objections).sort((a,b) => b[1]-a[1]).slice(0, 5),
      pricingObjectionRate: pricingObjRate,
      recentPricingObjections: (log.pricingObjections || []).slice(0, 10)
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOOP 7 — LEARNING CENTER COMPLETION → HR CERT + SCHEDULER ELIGIBILITY
  // Call when a Learning Center quiz is passed.
  // ─────────────────────────────────────────────────────────────────────────

  // Maps Learning Center module IDs to HR cert types
  var LC_TO_CERT_MAP = {
    'safety_firstaid':   { name: 'First Aid/CPR/AED', validMonths: 24 },
    'safety_osha10':     { name: 'OSHA 10', validMonths: 60 },
    'safety_ppe':        { name: 'PPE Training', validMonths: 12 },
    'safety_nfpa10':     { name: 'NFPA 10 — Fire Extinguisher', validMonths: 12 },
    'safety_nfpa96':     { name: 'NFPA 96 — Hood Suppression', validMonths: 12 },
    'safety_nfpa25':     { name: 'NFPA 25 — Sprinkler', validMonths: 12 },
    'unipro1':           { name: 'UniPro Service Training', validMonths: 12 },
    'gto1':              { name: 'GTO Service Training', validMonths: 12 },
    'filterman1':        { name: 'Filter Man Training', validMonths: 12 },
    'termac1':           { name: 'Termac Equipment Training', validMonths: 12 },
    'safety_dot':        { name: 'DOT Safety Training', validMonths: 12 },
    'corp_compliance':   { name: 'Corporate Compliance', validMonths: 12 },
  };

  function tiOnLCModuleComplete(userId, userName, moduleId, score, pct) {
    tiLog(`Loop 7: LC module complete — ${userName} / ${moduleId} (${score}%)`);

    const mapping = LC_TO_CERT_MAP[moduleId];
    if (!mapping) {
      tiLog(`Loop 7: No cert mapping for module "${moduleId}" — skipping HR update`);
      return { mapped: false };
    }

    const now = Date.now();
    const expiryDate = new Date(now + mapping.validMonths * 30.44 * 86400000);

    // Write to HR certs
    const certs = tiRead('termac_hr_certs', []);
    const existing = certs.findIndex(c => c.userId === userId && c.name === mapping.name);

    const certRecord = {
      id: existing >= 0 ? certs[existing].id : ('lc_cert_' + now),
      userId,
      userName,
      name: mapping.name,
      type: 'Learning Center',
      source: 'Learning Center — Module: ' + moduleId,
      score: score || pct,
      issued: new Date(now).toISOString().split('T')[0],
      expiry: expiryDate.toISOString().split('T')[0],
      updatedAt: now
    };

    if (existing >= 0) {
      certs[existing] = certRecord;
      tiLog(`Loop 7: Updated existing cert — ${mapping.name} for ${userName}`);
    } else {
      certs.push(certRecord);
      tiLog(`Loop 7: New cert written — ${mapping.name} for ${userName}`);
    }

    tiWrite('termac_hr_certs', certs);

    // Update scheduler eligibility cache
    const eligibility = tiRead('termac_scheduler_eligibility', {});
    if (!eligibility[userId]) eligibility[userId] = { userId, userName, certs: [] };
    const elCerts = eligibility[userId].certs;
    const elIdx = elCerts.findIndex(c => c.name === mapping.name);
    if (elIdx >= 0) {
      elCerts[elIdx] = { name: mapping.name, expiry: certRecord.expiry, valid: true };
    } else {
      elCerts.push({ name: mapping.name, expiry: certRecord.expiry, valid: true });
    }
    eligibility[userId].lastUpdated = now;
    tiWrite('termac_scheduler_eligibility', eligibility);

    // Notify HR of new cert earned
    tiNotify({
      type: 'cert_earned',
      title: `🎓 ${userName} completed: ${mapping.name}`,
      body: `Passed Learning Center module "${moduleId}" with ${score || pct}%. Cert valid until ${certRecord.expiry}.`,
      priority: 'low',
      action: 'hr_certdash'
    });

    return { mapped: true, certRecord };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DAILY INTELLIGENCE RUN
  // Call once on manager dashboard load to refresh all signals
  // ─────────────────────────────────────────────────────────────────────────
  function tiRunDailyIntelligence() {
    const last = tiRead('termac_ti_last_daily_run', 0);
    const now = Date.now();
    // Only run once per hour max
    if (now - last < 3600000) {
      tiLog('Daily intelligence: skipped (ran < 1hr ago)');
      return;
    }
    tiWrite('termac_ti_last_daily_run', now);
    tiLog('Running daily intelligence pass...');

    tiGetSchedulingAlerts(30);
    tiAnalyzeCrossSellGaps();
    tiCheckScorecardCoachingFlags();

    tiLog('Daily intelligence pass complete');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────
  global.TermacIntelligence = {
    // Loop 1
    onJobComplete:           tiOnJobComplete,
    // Loop 2
    createCrossSellLead:     tiCreateCrossSellLead,
    analyzeCrossSellGaps:    tiAnalyzeCrossSellGaps,
    // Loop 3
    checkTechEligibility:    tiCheckTechEligibility,
    checkScorecardFlags:     tiCheckScorecardCoachingFlags,
    // Loop 4
    getSchedulingAlerts:     tiGetSchedulingAlerts,
    // Loop 5
    deductPartsFromInventory: tiDeductPartsFromInventory,
    getJobMargin:            tiGetJobMargin,
    // Loop 6
    logDMSOutcome:           tiLogDMSOutcome,
    getDMSIntelligence:      tiGetDMSIntelligence,
    // Loop 7
    onLCModuleComplete:      tiOnLCModuleComplete,
    // Notifications
    notify:                  tiNotify,
    getNotifications:        tiGetNotifications,
    markRead:                tiMarkRead,
    // Utility
    runDailyIntelligence:    tiRunDailyIntelligence,
    JOB_CERT_REQUIREMENTS,
    LC_TO_CERT_MAP,
    VERSION: '1.0.0'
  };

  tiLog('v1.0.0 loaded — 7 intelligence loops ready');

})(typeof window !== 'undefined' ? window : global);
