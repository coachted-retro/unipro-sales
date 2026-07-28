

/* Store helpers */
function _notifStore_get(){try{return JSON.parse(localStorage.getItem('termac_hotlead_notifs')||'[]');}catch(e){return [];}}
function _notifStore_set(arr){try{localStorage.setItem('termac_hotlead_notifs',JSON.stringify(arr.slice(0,100)));}catch(e){}}
function _notifStore_badge(){var r=_notifStore_get();_notifStore_set(r);}

/* ── CROSS-DEVICE BRIDGE ─────────────────────────────────────────────
   localStorage only lives on one device — a call routed on the
   reception desk's computer would never reach a rep's tablet without
   this. Senders call notifySendCrossDevice(); every portal that loads
   this file polls the Worker for its logged-in user every 30s, merges
   anything new into the local store, and fires the banner. If the
   Worker isn't deployed or is unreachable, everything degrades to the
   original same-device behavior — no errors, nothing breaks. */
var NOTIFY_WORKER_URL = 'https://termac-notify.termac-one.workers.dev';
var _notifWorkerOk = null; // null = unknown, probed on first use

function _notifNormName(s){
  return String(s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z ]/g,'').trim();
}

function _notifCurrentUserName(){
  try { if (typeof _spRep !== 'undefined' && _spRep && _spRep.name) return _spRep.name; } catch(e){}
  try { if (typeof _rcpUser !== 'undefined' && _rcpUser && _rcpUser.name) return _rcpUser.name; } catch(e){}
  try { if (typeof _currentUser !== 'undefined' && _currentUser && _currentUser.name) return _currentUser.name; } catch(e){}
  try {
    var n = localStorage.getItem('termac_current_user') || '';
    return n === 'Team Member' ? '' : n;
  } catch(e){ return ''; }
}

/* Fire-and-forget send to the bridge. Call this alongside the local
   _notifStore_set so the same notification reaches other devices. */
function notifySendCrossDevice(notif){
  if (_notifWorkerOk === false) return;
  try {
    fetch(NOTIFY_WORKER_URL + '/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notif)
    }).then(function(r){ _notifWorkerOk = r.ok; }).catch(function(){ _notifWorkerOk = false; });
  } catch(e) { _notifWorkerOk = false; }
}

/* Poll the bridge for the logged-in user, merge new items into the
   local store, fire the banner for anything unseen. */
function _notifPollCrossDevice(){
  if (_notifWorkerOk === false) return;
  var me = _notifCurrentUserName();
  if (!me) return;
  var since = 0;
  try { since = parseInt(localStorage.getItem('termac_notif_last_poll')||'0',10)||0; } catch(e){}
  try {
    fetch(NOTIFY_WORKER_URL + '/notify?recipient=' + encodeURIComponent(me) + '&since=' + since)
      .then(function(r){ _notifWorkerOk = r.ok; return r.json(); })
      .then(function(data){
        var incoming = (data && data.notifications) || [];
        if (!incoming.length) {
          try { localStorage.setItem('termac_notif_last_poll', String(Date.now())); } catch(e){}
          return;
        }
        var local = _notifStore_get();
        var known = {};
        local.forEach(function(n){ known[n.id] = true; });
        var fresh = incoming.filter(function(n){ return !known[n.id]; });
        if (fresh.length) {
          _notifStore_set(fresh.concat(local));
          _updateNotifBadges();
          // Banner for the newest one only — a stack of six banners helps no one
          var newest = fresh[0];
          _fireInAppAlertBanner({
            recipientName: newest.recipientName, caller: newest.caller,
            company: newest.company, phone: newest.phone, notes: newest.notes,
            source: newest.source, loggedBy: newest.loggedBy
          });
        }
        try { localStorage.setItem('termac_notif_last_poll', String(Date.now())); } catch(e){}
      })
      .catch(function(){ _notifWorkerOk = false; });
  } catch(e) { _notifWorkerOk = false; }
}

/* In-app flashing alert banner + badge updater */
function _fireInAppAlertBanner(opts){
  _notifStore_badge();
  if(!document.getElementById('_hotleadBannerStyle')){
    var st=document.createElement('style');st.id='_hotleadBannerStyle';
    st.textContent='@keyframes _hlPulse{0%,100%{opacity:1}50%{opacity:.7}}'
      +'#_hotleadBanner{position:sticky;top:56px;left:0;right:0;z-index:9999;background:#C8102E;'
      +'color:#fff;font-family:-apple-system,Barlow Condensed,sans-serif;padding:0;'
      +'box-shadow:0 4px 20px rgba(0,0,0,.4);animation:_hlPulse 1.2s ease-in-out 6}'
      +'#_hotleadBanner .hl-inner{display:flex;align-items:center;gap:12px;padding:12px 18px}'
      +'#_hotleadBanner .hl-icon{font-size:24px;flex-shrink:0}'
      +'#_hotleadBanner .hl-body{flex:1;min-width:0}'
      +'#_hotleadBanner .hl-title{font-weight:900;font-size:15px;letter-spacing:.04em;text-transform:uppercase}'
      +'#_hotleadBanner .hl-detail{font-size:12px;opacity:.9;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      +'#_hotleadBanner .hl-source{font-size:10px;opacity:.7;margin-top:2px;text-transform:uppercase;letter-spacing:.06em}'
      +'#_hotleadBanner .hl-dismiss{background:rgba(255,255,255,.2);border:none;border-radius:6px;'
      +'color:#fff;padding:6px 14px;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;flex-shrink:0}';
    document.head.appendChild(st);
  }
  var ex=document.getElementById('_hotleadBanner'); if(ex) ex.remove();
  var b=document.createElement('div'); b.id='_hotleadBanner';
  var caller=opts.caller||opts.company||'Unknown';
  var notes=(opts.notes||'').slice(0,60);
  var source=opts.source||'Termac One';
  var loggedBy=opts.loggedBy||'';
  var recipient=opts.recipientName||'You';
  var phone=opts.phone||'';
  b.innerHTML='<div class="hl-inner">'
    +'<div class="hl-icon">⚠️</div>'
    +'<div class="hl-body">'
    +'<div class="hl-title">HOT LEAD — '+recipient+'</div>'
    +'<div class="hl-detail">'+caller+(phone?' · '+phone:'')+(notes?' · '+notes:'')+'</div>'
    +'<div class="hl-source">via '+source+(loggedBy?' · '+loggedBy:'')+' · '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})+'</div>'
    +'</div>'
    +'<button class="hl-dismiss" id="_hlOnItBtn">On It</button>'
    +'<button class="hl-dismiss" id="_hlOutcomeBtn">Log Outcome</button>'
    +'<button class="hl-dismiss" id="_hlDismissBtn">× Dismiss</button>'
    +'</div>';
  var _nav=document.querySelector('nav,.trn,.mgr-nav') || document.body.firstElementChild;
  if(_nav&&_nav.parentNode){
    _nav.parentNode.insertBefore(b,_nav.nextSibling);
  } else {
    document.body.insertBefore(b,document.body.firstChild);
  }
  // 2026-07-27: markup only had _hlDismissBtn; code wired three ids.
  // _hlOnItBtn was null, .onclick threw, Dismiss handler never attached,
  // 60s auto-remove never set. Banner stuck permanently.
  var _hlAutoDismiss = null;
  function _hlClose() {
    var el = document.getElementById('_hotleadBanner');
    if (el) el.remove();
    if (_hlAutoDismiss) { clearTimeout(_hlAutoDismiss); _hlAutoDismiss = null; }
  }
  function _hlWire(id, fn) {
    var el = document.getElementById(id);
    if (el) el.onclick = fn;
  }
  _hlWire('_hlOnItBtn', function(){
    _notifAcknowledge(_notifId, opts, 'acknowledged', '');
    _hlClose();
  });
  _hlWire('_hlOutcomeBtn', function(){
    _notifOpenOutcomeModal(_notifId, opts);
  });
  _hlWire('_hlDismissBtn', _hlClose);
  _hlAutoDismiss = setTimeout(_hlClose, 60000);
}

function _updateNotifBadges(){
  var unread=_notifStore_get().filter(function(n){return !n.read;}).length;
  ['notifBadge','hotleadBadge','repNotifBadge'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){el.textContent=unread>0?String(unread):'';el.style.display=unread>0?'inline-flex':'none';}
  });
  document.querySelectorAll('[data-badge="notifs"]').forEach(function(el){
    el.setAttribute('data-count',unread>0?String(unread):'');
  });
  return unread;
}

// ── Rep-side outcome logging ─────────────────────────────────────────────────
function _notifAcknowledge(notifId, opts, outcome, notes) {
  var ackedBy = (window._spRep && window._spRep.name) || (window._rcpUser && window._rcpUser.name) || 'Rep';
  try {
    var cbq = JSON.parse(localStorage.getItem('termac_callback_queue')||'[]');
    var found = false;
    cbq.forEach(function(c){
      if (c.id === notifId || c.caller === (opts&&opts.caller)) {
        c.status = outcome === 'spoke' ? 'resolved' : 'followup';
        c.resolvedAt = Date.now(); c.resolvedBy = ackedBy;
        var lbl = {spoke:'Spoke with someone',voicemail:'Left voicemail','no-answer':'No answer',acknowledged:'Acknowledged'};
        c.lastOutcome = { outcome:outcome, notes:notes||'', by:ackedBy, ts:Date.now(), outcomeLabel:lbl[outcome]||outcome };
        if (outcome !== 'spoke') { c.followupAt = Date.now()+(outcome==='voicemail'?86400000:7200000); c.escalated=false; c.escalated2=false; }
        found = true;
      }
    });
    if (!found && outcome !== 'acknowledged') {
      cbq.unshift({ id:notifId, status:outcome==='spoke'?'resolved':'followup',
        caller:opts&&opts.caller, company:opts&&opts.company, phone:opts&&opts.phone,
        routedTo:ackedBy, ts:(opts&&opts.ts)||Date.now(), resolvedAt:Date.now(), resolvedBy:ackedBy,
        lastOutcome:{outcome:outcome, notes:notes||'', by:ackedBy, ts:Date.now()} });
    }
    localStorage.setItem('termac_callback_queue', JSON.stringify(cbq.slice(0,200)));
  } catch(e){}
  try { fetch('https://termac-notify.termac-one.workers.dev/acknowledge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:notifId,outcome:outcome,notes:notes||'',ackedAt:Date.now(),ackedBy:ackedBy})}).catch(function(){}); } catch(e){}

  // Write rep_action_at to D1 so the escalation worker stops the clock.
  // Without this the worker never knows the rep acted and keeps sending
  // management emails even after On It or Log Outcome is clicked.
  var leadId = (opts && opts.lead_id) || (opts && opts.record_id) || notifId;
  if (leadId) {
    var actionLabels = {
      spoke: 'Spoke with customer',
      voicemail: 'Left voicemail',
      'no-answer': 'No answer',
      acknowledged: 'Acknowledged'
    };
    try {
      fetch('https://unipro-ai-proxy.termac-one.workers.dev/db/leads/' + encodeURIComponent(leadId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-API-Secret': 'termac2026' },
        body: JSON.stringify({
          rep_action: actionLabels[outcome] || outcome,
          rep_action_by: ackedBy,
          rep_action_at: Date.now(),
          first_contacted_at: Date.now(),
          is_new_lead: 0,
          updated_at: Date.now()
        })
      }).catch(function(){});
    } catch(e2) {}
  }
}

function _notifOpenOutcomeModal(notifId, opts) {
  var old = document.getElementById('_repOutcomeModal'); if (old) old.remove();
  var m = document.createElement('div');
  m.id = '_repOutcomeModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Barlow,system-ui,sans-serif';
  var tiles = [
    {val:'phone',    label:'Phone Call',  icon:'📞', color:'#16A34A'},
    {val:'email',    label:'Email',       icon:'✉️',  color:'#2563EB'},
    {val:'text',     label:'Text',        icon:'💬', color:'#7C3AED'},
    {val:'stopped-in',label:'Stopped In', icon:'🚗', color:'#D97706'},
  ].map(function(o){
    return '<button data-outcome="'+o.val+'" onclick="_repSelectOutcome(this)" '
      +'style="border:2px solid #E5E7EB;border-radius:10px;padding:12px 8px;text-align:center;cursor:pointer;background:#fff;font-family:inherit">'
      +'<div style="font-size:22px;margin-bottom:4px">'+o.icon+'</div>'
      +'<div style="font-size:11px;font-weight:700;color:'+o.color+'">'+o.label+'</div>'
      +'</button>';
  }).join('');
  var optsEnc = encodeURIComponent(JSON.stringify(opts||{}));
  m.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:22px;box-shadow:0 8px 32px rgba(0,0,0,.2)">'
    +'<div style="font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:15px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Log Call Outcome</div>'
    +'<div style="font-size:12px;color:#6B7280;margin-bottom:16px">'+((opts&&opts.caller)||'Unknown')+' \u00b7 '+((opts&&opts.phone)||'')+'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">'+tiles+'</div>'
    +'<textarea id="_repOutcomeNotes" placeholder="Notes on what was discussed, next steps..." '
    +'style="width:100%;border:1.5px solid #E5E7EB;border-radius:8px;padding:10px;font-size:13px;font-family:inherit;height:80px;resize:vertical;margin-bottom:12px;box-sizing:border-box"></textarea>'
    +'<div style="display:flex;gap:8px">'
    +'<button onclick="_repSubmitOutcome(\''+notifId+'\',\''+optsEnc+'\')" '
    +'style="flex:1;background:#1B5FA8;color:#fff;border:none;border-radius:8px;padding:11px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:13px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer">Complete</button>'
    +'<button onclick="document.getElementById(\'_repOutcomeModal\').remove()" '
    +'style="background:#F3F4F6;border:none;border-radius:8px;padding:11px 16px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:12px;cursor:pointer;color:#374151">Cancel</button>'
    +'</div></div>';
  document.body.appendChild(m);
}

function _repSelectOutcome(btn) {
  var modal = document.getElementById('_repOutcomeModal'); if (!modal) return;
  modal.querySelectorAll('button[data-outcome]').forEach(function(b){ b.style.borderColor='#E5E7EB'; b.style.background='#fff'; });
  btn.style.borderColor='#1B5FA8'; btn.style.background='#EFF6FF';
}

function _repSubmitOutcome(notifId, optsEnc) {
  var sel = document.querySelector('#_repOutcomeModal button[data-outcome][style*="1B5FA8"]');
  if (!sel) { alert('Select an outcome first.'); return; }
  var outcome = sel.dataset.outcome;
  var notes = (document.getElementById('_repOutcomeNotes')||{}).value||'';
  var opts = {}; try { opts = JSON.parse(decodeURIComponent(optsEnc)); } catch(e){}

  // Labels matching the four tiles
  var labels = {
    'phone':      '📞 Phone Call',
    'email':      '✉️ Email',
    'text':       '💬 Text',
    'stopped-in': '🚗 Stopped In'
  };
  var label = labels[outcome] || outcome;
  var now = new Date();
  var ts = (now.getMonth()+1)+'/'+now.getDate()+'/'+now.getFullYear()+' '
    +now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true});

  // Write to D1
  _notifAcknowledge(notifId, opts, outcome, notes);

  // Close the modal and banner
  var m = document.getElementById('_repOutcomeModal'); if (m) m.remove();
  var el = document.getElementById('_hotleadBanner'); if (el) el.remove();

  // Show a persistent green confirmation card -- stays until rep closes it
  var card = document.createElement('div');
  card.id = '_repCompleteCard';
  card.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
    +'background:#fff;border:2.5px solid #16A34A;border-radius:14px;padding:20px 24px;'
    +'min-width:300px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.18);'
    +'z-index:10001;font-family:Barlow,system-ui,sans-serif;text-align:center';
  card.innerHTML = '<div style="font-size:36px;margin-bottom:8px">✅</div>'
    +'<div style="font-family:Barlow Condensed,sans-serif;font-weight:900;font-size:18px;'
    +'color:#15803D;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">Task Completed</div>'
    +'<div style="font-size:15px;font-weight:700;color:#1A1D21;margin-bottom:4px">'+label+'</div>'
    +'<div style="font-size:12px;color:#6B7280;margin-bottom:'+(notes?'8px':'14px')+'">'+ts+'</div>'
    +(notes ? '<div style="font-size:13px;color:#374151;background:#F0FDF4;border-radius:8px;'
      +'padding:8px 12px;margin-bottom:14px;text-align:left">'+notes+'</div>' : '')
    +'<button onclick="_repCloseCompleteCard()" '
    +'style="background:#16A34A;color:#fff;border:none;border-radius:8px;padding:10px 28px;'
    +'font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:14px;'
    +'letter-spacing:.06em;text-transform:uppercase;cursor:pointer">Got It</button>';
  document.body.appendChild(card);
}


function _repCloseCompleteCard() {
  var c = document.getElementById('_repCompleteCard');
  if (c) c.remove();
}

if(typeof window!=='undefined'){
  document.addEventListener('DOMContentLoaded',function(){
    _updateNotifBadges();
    setInterval(_updateNotifBadges,30000);
    // Cross-device poll: first check shortly after load, then every 30s
    setTimeout(_notifPollCrossDevice, 4000);
    setInterval(_notifPollCrossDevice, 30000);
  });
}

