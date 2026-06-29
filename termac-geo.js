/* ============================================================
   Termac One — Shared Geo-Assist (foreground arrival + timing)
   One implementation, driven by a per-portal config, so the
   tech portal and the delivery portal behave identically.

   It detects when the person is at one of their open stops,
   asks them to confirm the exact address (never auto-starts,
   lists every nearby stop so a strip-mall block can't cross
   wires), supports "Not yet, I'll be back" with re-prompt on
   return, and stamps on-site start/end timing. It only calls
   the host portal's existing start and complete functions and
   adds onSite* fields — it writes no status that dispatch or
   scheduling read. Foreground only (browser limitation); the
   portal's manual arrival action stays as the fallback.

   TermacGeo.init({
     label,                 // text for the status chip
     list()  -> array,      // all stops/jobs
     save(arr),             // persist the array
     done(item) -> bool,    // completed/cancelled (excluded)
     idOf(item), addressOf(item), nameOf(item),
     onArrive(id),          // host start action (arriveJob / openDelivery)
     activeId() -> id|null,  // host's current active stop id
     endStamp(item) -> ms,  // completion time (closedAt / deliveredAt)
     wrapName               // global completion fn to wrap (re-arm + end stamp)
   });
   ============================================================ */
(function(){
  if (window.TermacGeo) return;

  var RADIUS_MI = 0.075;   // ~120m geofence — errs toward showing one extra nearby stop (address is confirmed anyway)
  var RADIUS_LEAVE = 0.11; // ~177m — once this far from a deferred stop, treat it as "left" so a return re-prompts
  var ACC_OK_M = 60;       // flag GPS as approximate above this (meters)

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function haversine(a,b){ var R=3958.8,dLat=(b[0]-a[0])*Math.PI/180,dLng=(b[1]-a[1])*Math.PI/180,l1=a[0]*Math.PI/180,l2=b[0]*Math.PI/180;var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(l1)*Math.cos(l2)*Math.sin(dLng/2)*Math.sin(dLng/2);return 2*R*Math.asin(Math.sqrt(h)); }

  function init(cfg){
    var ROUTE_PROXY='https://ors-route-proxy.tedscholl.workers.dev';
    var geo={}, watchId=null, _promptKey=null, snoozed={};
    try{ geo=JSON.parse(localStorage.getItem('termac_geocode_cache')||'{}'); }catch(e){ geo={}; }
    function saveGeo(){ try{ localStorage.setItem('termac_geocode_cache',JSON.stringify(geo)); }catch(e){} }

    function openItems(){ return cfg.list().filter(function(it){ return cfg.addressOf(it) && !cfg.done(it); }); }
    function findItem(id){ var l=cfg.list(); for(var i=0;i<l.length;i++){ if(cfg.idOf(l[i])===id) return l[i]; } return null; }
    function inProgress(){
      var a = cfg.activeId ? cfg.activeId() : null;
      if(a){ var it=findItem(a); if(it && !cfg.done(it)) return true; }
      return openItems().some(function(it){ return it.onSiteStart && !it.onSiteEnd; });
    }
    async function geocode(addr){
      if(!addr) return null; if(geo[addr]) return geo[addr];
      try{ var r=await fetch(ROUTE_PROXY+'/geocode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:addr})});
        if(r.ok){ var d=await r.json(); if(typeof d.lat==='number'){ geo[addr]=[d.lat,d.lng]; saveGeo(); return geo[addr]; } } }catch(e){}
      return null;
    }
    function nextItem(){ var l=openItems().slice(); l.sort(function(a,b){ return String(a.time||'').localeCompare(String(b.time||'')); }); return l[0]||null; }
    function ind(txt,on){ var el=document.getElementById('geoAssistInd'); if(el) el.innerHTML=(on?'🟢 ':'⚪ ')+esc(txt); }
    function arm(){ var nj=nextItem(); if(nj){ geocode(cfg.addressOf(nj)); ind('Auto-arrival on · next: '+cfg.nameOf(nj),true); } else ind('No more stops',false); }
    function nearby(here){
      return openItems().map(function(it){ var c=geo[cfg.addressOf(it)]; return c?{it:it,d:haversine(here,c)}:null; })
        .filter(function(x){ return x && x.d<=RADIUS_MI; }).sort(function(a,b){ return a.d-b.d; });
    }
    function onPos(pos){
      if(inProgress()){ ind('On stop · timing in progress',true); dismiss(); return; }
      var here=[pos.coords.latitude,pos.coords.longitude];
      openItems().forEach(function(it){ if(!geo[cfg.addressOf(it)]) geocode(cfg.addressOf(it)); });
      Object.keys(snoozed).forEach(function(id){ var it=findItem(id); var c=it&&geo[cfg.addressOf(it)]; if(!c || haversine(here,c)>RADIUS_LEAVE) delete snoozed[id]; });
      var near=nearby(here).filter(function(x){ return !snoozed[cfg.idOf(x.it)]; });
      if(!near.length){ if(_promptKey) dismiss(); var def=Object.keys(snoozed).length; if(def) ind('Deferred '+def+' stop'+(def>1?'s':'')+' · will re-prompt on return',true); else arm(); return; }
      var key=near.map(function(x){return cfg.idOf(x.it);}).join(',');
      if(key===_promptKey) return;
      showPrompt(near, pos.coords.accuracy||999);
    }
    function showPrompt(near, accuracy){
      _promptKey=near.map(function(x){return cfg.idOf(x.it);}).join(',');
      var ex=document.getElementById('geoArrivePrompt'); if(ex) ex.remove();
      var multi=near.length>1;
      var head=multi?('📍 You\'re near '+near.length+' of your stops. Confirm which address you\'re actually at.')
                    :('📍 Confirm you\'re at this address to start.');
      var acc=(accuracy>ACC_OK_M)?'<div style="font-size:11px;color:#FCA5A5;margin-top:4px">GPS here is approximate. Pick the exact address.</div>':'';
      var rows=near.map(function(x){ var it=x.it;
        return '<button class="geoPick" data-id="'+esc(cfg.idOf(it))+'" style="display:block;width:100%;text-align:left;background:#13351F;border:1.5px solid #2C5E3D;border-radius:9px;padding:11px 13px;margin-bottom:8px;color:#fff;cursor:pointer;font-family:Barlow,sans-serif">'+
          '<div style="font-weight:800;font-size:14px;font-family:Barlow Condensed,sans-serif">'+esc(cfg.nameOf(it))+'</div>'+
          '<div style="font-size:12px;color:#A7F3D0;margin-top:2px">'+esc(cfg.addressOf(it)||'')+'</div>'+
          '</button>';
      }).join('');
      var bar=document.createElement('div'); bar.id='geoArrivePrompt';
      bar.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#0F2A1A;color:#fff;padding:14px 16px 16px;box-shadow:0 -4px 24px rgba(0,0,0,.45);font-family:Barlow,sans-serif;max-height:70vh;overflow-y:auto';
      bar.innerHTML='<div style="max-width:560px;margin:0 auto">'+
        '<div style="font-size:14px;margin-bottom:10px">'+head+acc+'</div>'+rows+
        '<button id="geoNotYet" style="width:100%;background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.3);border-radius:9px;padding:10px;font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-top:2px">Not yet — leaving, I\'ll be back</button>'+
        '<div style="font-size:11px;color:#94A3B8;text-align:center;margin-top:7px">Leaving without starting is fine. This clears when you drive away and asks again when you return.</div>'+
        '</div>';
      document.body.appendChild(bar);
      Array.prototype.forEach.call(bar.querySelectorAll('.geoPick'),function(btn){ btn.onclick=function(){ doStart(btn.getAttribute('data-id')); }; });
      document.getElementById('geoNotYet').onclick=function(){ near.forEach(function(x){ snoozed[cfg.idOf(x.it)]=true; }); dismiss(); ind('Deferred this stop · will re-prompt when you return',true); };
    }
    function dismiss(){ _promptKey=null; var b=document.getElementById('geoArrivePrompt'); if(b)b.remove(); }
    function doStart(id){
      dismiss(); if(inProgress()) return;
      var arr=cfg.list(), it=null; for(var i=0;i<arr.length;i++){ if(cfg.idOf(arr[i])===id){ it=arr[i]; break; } }
      if(it && !it.onSiteStart){ it.onSiteStart=Date.now(); try{ cfg.save(arr); }catch(e){} }
      if(typeof cfg.onArrive==='function') cfg.onArrive(id);   // host start: notification / open delivery
      var nm=it?cfg.nameOf(it):'in progress'; ind('On stop: '+nm,true);
    }
    function finalizeStop(id){
      if(!id) return;
      var arr=cfg.list(), it=null; for(var i=0;i<arr.length;i++){ if(cfg.idOf(arr[i])===id){ it=arr[i]; break; } }
      if(it && it.onSiteStart && !it.onSiteEnd){ it.onSiteEnd=(cfg.endStamp?cfg.endStamp(it):0)||Date.now(); it.onSiteMinutes=Math.max(0,Math.round((it.onSiteEnd-it.onSiteStart)/60000)); try{ cfg.save(arr); }catch(e){} }
      arm();
    }
    function wrapComplete(){
      var name=cfg.wrapName; if(!name) return;
      if(typeof window[name]!=='function'){ setTimeout(wrapComplete,500); return; }
      if(window[name].__geoWrapped) return;
      var orig=window[name];
      window[name]=function(){ var closing=cfg.activeId?cfg.activeId():null; var r=orig.apply(this,arguments); try{ finalizeStop(closing); }catch(e){} return r; };
      window[name].__geoWrapped=true;
    }
    function boot(){
      if(!document.getElementById('geoAssistInd')){
        var chip=document.createElement('div'); chip.id='geoAssistInd';
        chip.style.cssText='position:fixed;left:12px;bottom:12px;z-index:9000;background:#fff;border:1.5px solid #D7DBE0;border-radius:99px;padding:6px 12px;font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:11px;color:#475569;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:62vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        chip.textContent='⚪ Auto-arrival starting…';
        document.body.appendChild(chip);
      }
      wrapComplete();
      if(!('geolocation' in navigator)){ ind('Auto-arrival off (no GPS) · use manual arrival',false); return; }
      (async function(){ var l=openItems(); for(var i=0;i<l.length;i++){ if(!geo[cfg.addressOf(l[i])]) await geocode(cfg.addressOf(l[i])); } arm(); })();
      try{ watchId=navigator.geolocation.watchPosition(onPos,function(){ ind('Auto-arrival paused · use manual arrival',false); },{enableHighAccuracy:true,maximumAge:8000,timeout:20000}); }
      catch(e){ ind('Auto-arrival off · use manual arrival',false); }
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ setTimeout(boot,1200); });
    else setTimeout(boot,1200);
  }

  window.TermacGeo = { init: init };
})();
