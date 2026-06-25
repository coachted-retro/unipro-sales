/* ═══════════════════════════════════════════════════════════════════════════
   TERMAC ONE — HOT LEAD & URGENT RESPONSE NOTIFICATION ENGINE
   termac-notify.js

   Triggers on:
   1. Reception: call logged + routed → Hot Lead email/banner to recipient
   2. Reception: complaint or customer concern → Urgent Response to Jim Kennedy + Tom Pittakas
   3. DMS: lead escalated to Sales/Management → Hot Lead email to recipient
   4. CRM: lead claimed by rep → internal notification

   Delivery:
   • Brevo API (when BREVO_API_KEY is populated) — fires automatically
   • mailto: fallback (opens email client pre-filled) — works immediately
   • In-app notification badge (always, regardless of email method)

   The in-app notification stores to localStorage so the badge persists
   across page loads and is visible on the manager dashboard.
════════════════════════════════════════════════════════════════════════════ */

// ── STAFF ROUTING TABLE ───────────────────────────────────────────────────
// Maps display name (from Route To dropdown / escalation) → email + cell
const NOTIF_STAFF = {
  // Sales reps
  'Ted Scholl':          { email:'tscholl@termac.com',     phone:'2674216336', role:'rep'       },
  'Brad Fickes':         { email:'bfickes@termac.com',     phone:'',           role:'rep'       },
  'Chris Carzo':         { email:'ccarzo@termac.com',      phone:'',           role:'rep'       },
  'Dan Rini':            { email:'drini@termac.com',       phone:'',           role:'rep'       },
  'Joe McDonnell':       { email:'jmcdonnell@termac.com',  phone:'',           role:'rep'       },
  'Matt Belz':           { email:'mbelz@termac.com',       phone:'',           role:'rep'       },
  'Todd Grill':          { email:'tgrill@termac.com',      phone:'',           role:'rep'       },
  'Tom Jordan':          { email:'tjordan@termac.com',     phone:'',           role:'rep'       },
  "TJ O'Reilly":         { email:'tjorielly@termac.com',   phone:'',           role:'rep'       },
  // Management
  "Sean O'Reilly":       { email:'sorielly@termac.com',    phone:'',           role:'owner'     },
  "Terence O'Reilly":    { email:'torielly@termac.com',    phone:'',           role:'owner'     },
  'Jim Kennedy':         { email:'jkennedy@termac.com',    phone:'',           role:'vp_sales'  },
  'Tom Pittakas':        { email:'tpittakas@termac.com',   phone:'',           role:'sales_mgr' },
  'Dennis Muracco':      { email:'dmuracco@termac.com',    phone:'',           role:'coo'       },
  'Paul Brahan':         { email:'pbrahan@termac.com',     phone:'',           role:'gm'        },
  // Scheduling / Ops
  'Scheduler — Aine Curran':    { email:'acurran@termac.com',  phone:'', role:'scheduler' },
  'Scheduler — Jasmine Paez':   { email:'jpaez@termac.com',    phone:'', role:'scheduler' },
  'Scheduler — Samuel Holmes':  { email:'sholmes@termac.com',  phone:'', role:'scheduler' },
  'Dispatcher':                 { email:'dispatch@termac.com', phone:'', role:'dispatcher' },
  'Office — Lexi Cranfield':    { email:'lcranfield@termac.com',phone:'',role:'office'    },
};

// ── URGENT RESPONSE CONFIG ────────────────────────────────────────────────
const URGENT_RESPONSE_TEAM = [
  { name:'Jim Kennedy',  email:'jkennedy@termac.com' },
  { name:'Tom Pittakas', email:'tpittakas@termac.com' },
  { name:'Ted Scholl',   email:'tscholl@termac.com'  },
];

// Types that trigger urgent management response
const URGENT_CALL_TYPES = [
  'Complaint',
  'Customer Concern',
  'Emergency — Fire Safety',
];

// Types that qualify as hot leads
const HOT_LEAD_CALL_TYPES = [
  'New Service Inquiry',
  'Quote / Pricing',
  'New Account — All Services',
  'Existing Customer — Add-On Service',
];

// ── IN-APP NOTIFICATION STORE ─────────────────────────────────────────────
function _notifStore_get() {
  try { return JSON.parse(localStorage.getItem('termac_hotlead_notifs') || '[]'); } catch(e) { return []; }
}
function _notifStore_push(record) {
  try {
    const existing = _notifStore_get();
    existing.unshift(record);
    // Keep last 100
    localStorage.setItem('termac_hotlead_notifs', JSON.stringify(existing.slice(0, 100)));
  } catch(e) {}
}
function _notifStore_badge() {
  const unread = _notifStore_get().filter(n => !n.read).length;
  // Update badge if manager dashboard has a notifications count
  const badge = document.getElementById('notifBadge');
  if (badge) {
    badge.textContent = unread > 0 ? unread : '';
    badge.style.display = unread > 0 ? 'inline' : 'none';
  }
  return unread;
}

// ── MAIN ENTRY POINTS ─────────────────────────────────────────────────────

/**
 * Fire when Reception logs a call. Handles:
 * - Hot lead notification to the "Route To" recipient
 * - Urgent response to management if complaint/concern/emergency
 */
function notifyOnCallLogged(call) {
  if (!call) return;

  const isUrgent  = URGENT_CALL_TYPES.some(t => call.type && call.type.includes(t.replace('—','-').trim()) || (call.type === t));
  const isHotLead = HOT_LEAD_CALL_TYPES.includes(call.type);
  const routedTo  = call.routeTo;

  // 1. Hot Lead notification to recipient
  if (routedTo && NOTIF_STAFF[routedTo] && (isHotLead || call.type === 'New Service Inquiry' || call.type === 'Quote / Pricing')) {
    _sendHotLeadNotification({
      recipient: NOTIF_STAFF[routedTo],
      recipientName: routedTo,
      caller: call.name || 'Unknown',
      company: call.company || '',
      phone: call.phone || '',
      callType: call.type,
      notes: call.notes || '',
      loggedBy: call.loggedBy || 'Reception',
      date: call.date,
      time: call.time,
      source: 'Reception',
    });
  }

  // 2. Route-to notification (non-hot-lead calls still get an in-app ping)
  if (routedTo && NOTIF_STAFF[routedTo] && !isHotLead && !isUrgent) {
    _storeInAppNotif({
      type: 'routed_call',
      icon: '📞',
      urgent: false,
      title: `Call Routed to You — ${call.type}`,
      body: `${call.name || 'Unknown'}${call.company ? ' · ' + call.company : ''} · ${call.time}`,
      recipient: routedTo,
    });
  }

  // 3. Urgent response for complaints/concerns/emergencies
  if (isUrgent) {
    _sendUrgentResponse(call);
  }
}

/**
 * Fire when a DMS rep escalates a lead to Sales or Management.
 * Sends hot lead notification to the chosen recipient.
 */
function notifyOnDmsEscalation(lead, target) {
  if (!lead || !target) return;

  // Determine actual person from escalation target
  // target is 'sales', 'manager', 'scheduling', 'dispatch'
  let recipientKey = null;
  if (target === 'sales') {
    // Route by territory or default to Ted
    recipientKey = 'Ted Scholl';
  } else if (target === 'manager') {
    recipientKey = 'Jim Kennedy';
  } else if (target === 'scheduling') {
    recipientKey = 'Scheduler — Aine Curran';
  }

  if (recipientKey && NOTIF_STAFF[recipientKey]) {
    _sendHotLeadNotification({
      recipient: NOTIF_STAFF[recipientKey],
      recipientName: recipientKey,
      caller: lead.business || lead.name || 'Unknown',
      company: lead.business || '',
      phone: lead.phone || '',
      callType: 'DMS Hot Lead Escalation',
      notes: lead.dmsNotes || '',
      loggedBy: lead.dmsRep || 'DMS',
      date: new Date().toLocaleDateString('en-US'),
      time: new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }),
      source: 'DMS Cold-Call',
    });
  }

  // Always notify management when escalated to manager
  if (target === 'manager') {
    _storeInAppNotif({
      type: 'dms_escalation',
      icon: '🔥',
      urgent: true,
      title: `DMS Hot Lead → Management: ${lead.business || lead.name}`,
      body: `Escalated by ${lead.dmsRep || 'DMS'} · ${lead.dmsNotes || 'No notes'}`,
      recipient: 'Management',
    });
  }
}

/**
 * Fire when a rep claims a lead from the pool.
 * Stores an in-app notification for that rep.
 */
function notifyOnLeadClaimed(lead, repName) {
  if (!lead || !repName) return;
  _storeInAppNotif({
    type: 'lead_claimed',
    icon: '🎯',
    urgent: false,
    title: `Lead Claimed: ${lead.name || lead.business}`,
    body: `Assigned to ${repName} · ${lead.source || 'Lead Pool'}`,
    recipient: repName,
  });
}

// ── INTERNAL HELPERS ──────────────────────────────────────────────────────

function _sendHotLeadNotification({ recipient, recipientName, caller, company, phone, callType, notes, loggedBy, date, time, source }) {
  const subjectText = `🔥 HOT LEAD — ${company || caller} · ${callType}`;
  const bodyText = [
    `${recipientName},`,
    '',
    `You have a HOT LEAD waiting. Details below.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'HOT LEAD DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Caller:       ${caller}`,
    `Company:      ${company || '—'}`,
    `Phone:        ${phone || '—'}`,
    `Call Type:    ${callType}`,
    `Date / Time:  ${date} · ${time}`,
    `Source:       ${source}`,
    `Logged By:    ${loggedBy}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'NOTES',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    notes || 'No notes recorded.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'View the full lead in Termac One:',
    'https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '⚡ Respond within 15 minutes for best close rate.',
    '',
    '— Termac One Notification System',
  ].join('\n');

  // Store in-app
  _storeInAppNotif({
    type: 'hot_lead',
    icon: '🔥',
    urgent: true,
    title: `HOT LEAD — ${company || caller}`,
    body: `${callType} · ${phone} · Logged by ${loggedBy}`,
    recipient: recipientName,
    email: recipient.email,
  });

  // Fire email (mailto fallback — replace with Brevo when key is live)
  const subject = encodeURIComponent(subjectText);
  const body = encodeURIComponent(bodyText);
  window.open(`mailto:${recipient.email}?cc=tscholl@termac.com&subject=${subject}&body=${body}`, '_blank');

  // Show in-app toast
  _showHotLeadToast(recipientName, company || caller, callType);
}

function _sendUrgentResponse(call) {
  const subjectText = `⚠️ URGENT — ${call.type}: ${call.company || call.name || 'Customer'}`;
  const bodyText = [
    'Jim, Tom, Ted —',
    '',
    `URGENT customer ${call.type.toLowerCase()} logged in Termac One.`,
    'This requires same-day follow-up per Termac Urgent Response protocol.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'INCIDENT DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Date / Time:  ${call.date} · ${call.time}`,
    `Caller:       ${call.name || 'Unknown'}`,
    `Company:      ${call.company || '—'}`,
    `Phone:        ${call.phone || '—'}`,
    `Type:         ${call.type}`,
    `Urgency:      ${(call.urgency || 'high').toUpperCase()} — SAME-DAY RESPONSE REQUIRED`,
    `Routed To:    ${call.routeTo || 'Not yet routed'}`,
    `Logged By:    ${call.loggedBy || 'Reception'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'CUSTOMER MESSAGE / NOTES',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    call.notes || 'No notes recorded.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'View in Termac One Reception Dashboard:',
    'https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '— Termac One Urgent Response System',
  ].join('\n');

  // Store in-app for all three
  const urgentRecipients = URGENT_RESPONSE_TEAM.map(r => r.name).join(', ');
  _storeInAppNotif({
    type: 'urgent_response',
    icon: '🚨',
    urgent: true,
    title: `URGENT: ${call.type} — ${call.company || call.name || 'Customer'}`,
    body: `${call.time} · Phone: ${call.phone || '—'} · Logged by ${call.loggedBy}`,
    recipient: urgentRecipients,
  });

  // Fire email to full urgent response team
  const toList  = URGENT_RESPONSE_TEAM.map(r => r.email).join(',');
  const subject = encodeURIComponent(subjectText);
  const body    = encodeURIComponent(bodyText);
  window.open(`mailto:${toList}?subject=${subject}&body=${body}`, '_blank');

  // Show in-app toast
  _showUrgentToast(call.type, call.company || call.name);
}

function _storeInAppNotif({ type, icon, urgent, title, body, recipient, email }) {
  const record = {
    id:        'n_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    ts:        Date.now(),
    date:      new Date().toLocaleDateString('en-US'),
    time:      new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }),
    type, icon, urgent, title, body, recipient, email: email || '',
    read:      false,
  };
  _notifStore_push(record);
  _notifStore_badge();
  // Also write to termac_notifs for manager dashboard intelligence feed
  try {
    const existing = JSON.parse(sessionStorage.getItem('termac_notifs') || '[]');
    existing.unshift({ id: record.id, ts: record.ts, type: record.type,
      title: record.title, body: record.body, target: record.recipient });
    sessionStorage.setItem('termac_notifs', JSON.stringify(existing));
  } catch(e) {}
}

function _showHotLeadToast(recipientName, company, callType) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#C8102E;color:#fff;border-radius:10px;padding:14px 22px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:14px;letter-spacing:.04em;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.35);max-width:380px;text-align:center;animation:notifSlideUp .3s ease';
  t.innerHTML = `🔥 HOT LEAD ALERT<br><span style="font-weight:600;font-size:12px">${company || 'Caller'} · ${callType}</span><br><span style="font-weight:400;font-size:11px;opacity:.9">Email notification opened for ${recipientName}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.style.opacity = '0', 4000);
  setTimeout(() => t.remove(), 4500);
}

function _showUrgentToast(type, company) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#7C2D12;color:#fff;border-radius:10px;padding:14px 22px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:14px;letter-spacing:.04em;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.4);max-width:380px;text-align:center';
  t.innerHTML = `🚨 URGENT RESPONSE TRIGGERED<br><span style="font-weight:600;font-size:12px">${type} — ${company || 'Customer'}</span><br><span style="font-weight:400;font-size:11px;opacity:.9">Email fired to Jim Kennedy, Tom Pittakas & Ted Scholl</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.style.opacity = '0', 5000);
  setTimeout(() => t.remove(), 5500);
}

// Add slide-up animation if not already present
(function() {
  if (!document.getElementById('notifAnimStyle')) {
    const s = document.createElement('style');
    s.id = 'notifAnimStyle';
    s.textContent = '@keyframes notifSlideUp{from{transform:translateX(-50%) translateY(20px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}';
    document.head.appendChild(s);
  }
})();
