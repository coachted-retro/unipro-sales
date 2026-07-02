

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
var NOTIFY_WORKER_URL = 'https://termac-notify.tedscholl.workers.dev';
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
    +'<button class="hl-dismiss" id="_hlDismissBtn">× Dismiss</button>'
    +'</div>';
  var _nav=document.querySelector('nav,.trn,.mgr-nav') || document.body.firstElementChild;
  if(_nav&&_nav.parentNode){
    _nav.parentNode.insertBefore(b,_nav.nextSibling);
  } else {
    document.body.insertBefore(b,document.body.firstChild);
  }
  document.getElementById('_hlDismissBtn').onclick=function(){
    var el=document.getElementById('_hotleadBanner'); if(el) el.remove();
  };
  setTimeout(function(){var el=document.getElementById('_hotleadBanner');if(el)el.remove();},30000);
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
if(typeof window!=='undefined'){
  document.addEventListener('DOMContentLoaded',function(){
    _updateNotifBadges();
    setInterval(_updateNotifBadges,30000);
    // Cross-device poll: first check shortly after load, then every 30s
    setTimeout(_notifPollCrossDevice, 4000);
    setInterval(_notifPollCrossDevice, 30000);
  });
}

