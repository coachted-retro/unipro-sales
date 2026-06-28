

/* In-app flashing alert banner + badge updater */
function _fireInAppAlertBanner(opts){
  _notifStore_badge();
  if(!document.getElementById('_hotleadBannerStyle')){
    var st=document.createElement('style');st.id='_hotleadBannerStyle';
    st.textContent='@keyframes _hlPulse{0%,100%{opacity:1}50%{opacity:.7}}'
      +'#_hotleadBanner{position:fixed;top:0;left:0;right:0;z-index:999999;background:#C8102E;'
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
  document.body.insertBefore(b,document.body.firstChild);
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
  });
}

