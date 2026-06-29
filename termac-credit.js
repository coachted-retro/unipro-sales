/* ============================================================
   Termac One — Credit Hold engine (shared)
   Additive only. Stores a hold flag per account, renders a badge,
   and gates new-work creation with a warn + manager-PIN override.
   Does not touch dispatch/scheduler status flow or any job record.

   API:
     TermacCredit.isHeld(acct)      -> hold record or null
     TermacCredit.setHold(acct, reason, by)
     TermacCredit.release(acct, by)
     TermacCredit.list()            -> [held records]
     TermacCredit.badgeHTML(acct)   -> red CREDIT HOLD span or ''
     TermacCredit.guard(acct, onProceed)
         not held -> onProceed() immediately
         held     -> warn modal; onProceed() only after valid manager PIN
   acct may be a name string or an object with name/account/accountName/id.
   ============================================================ */
(function(){
  if (window.TermacCredit) return;
  var HOLDS='termac_credit_holds', LOG='termac_credit_overrides';
  // Manager PINs (placeholder gate until Azure SSO, mirrors the platform PIN set)
  var PINS={ '8031':'Sean O\u2019Reilly','2100':'Terence O\u2019Reilly','3525':'Jim Kennedy','7430':'Dennis Muracco','6730':'Paul Brahan','6336':'Ted Scholl','7467':'Tom Pittakas' };

  function norm(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]/g,''); }
  function keyOf(a){ if(a==null) return ''; if(typeof a==='string') return norm(a); return norm(a.name||a.account||a.accountName||a.id||''); }
  function nameOf(a){ if(a==null) return ''; if(typeof a==='string') return a; return a.name||a.account||a.accountName||String(a.id||''); }
  function loadH(){ try{ return JSON.parse(localStorage.getItem(HOLDS)||'{}')||{}; }catch(e){ return {}; } }
  function saveH(h){ try{ localStorage.setItem(HOLDS, JSON.stringify(h)); }catch(e){} }

  function isHeld(a){ var k=keyOf(a); if(!k) return null; var rec=loadH()[k]; return (rec&&rec.held)?rec:null; }
  function setHold(a, reason, by){ var k=keyOf(a); if(!k) return; var h=loadH(); h[k]={ held:true, name:nameOf(a), reason:reason||'Past due', by:by||'Controller', at:Date.now() }; saveH(h); }
  function release(a, by){ var k=keyOf(a); var h=loadH(); if(h[k]){ h[k].held=false; h[k].releasedBy=by||'Controller'; h[k].releasedAt=Date.now(); saveH(h); } }
  function list(){ var h=loadH(), out=[]; Object.keys(h).forEach(function(k){ if(h[k]&&h[k].held) out.push(h[k]); }); return out; }
  function badgeHTML(a){ return isHeld(a) ? '<span style="display:inline-block;background:#B91C1C;color:#fff;font-weight:800;font-size:10px;letter-spacing:.04em;padding:2px 7px;border-radius:4px;margin-left:6px;vertical-align:middle">CREDIT HOLD</span>' : ''; }
  function logOverride(rec){ try{ var l=JSON.parse(localStorage.getItem(LOG)||'[]'); l.push(rec); localStorage.setItem(LOG, JSON.stringify(l)); }catch(e){} }

  function ensureModal(){
    if(document.getElementById('tcreditModal')) return;
    var d=document.createElement('div'); d.id='tcreditModal';
    d.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:99999;font-family:Arial,Helvetica,sans-serif';
    d.innerHTML='<div style="background:#fff;border-radius:12px;max-width:380px;width:92%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35)">'+
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:22px">\u26A0\uFE0F</span><span style="font-weight:800;font-size:16px;color:#B91C1C">Account on Credit Hold</span></div>'+
      '<div id="tcreditMsg" style="font-size:13px;color:#334155;line-height:1.5;margin-bottom:12px"></div>'+
      '<label style="display:block;font-size:11px;color:#64748b;margin-bottom:4px">Manager PIN to override</label>'+
      '<input id="tcreditPin" type="password" inputmode="numeric" autocomplete="off" style="width:100%;padding:9px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:15px;letter-spacing:3px;box-sizing:border-box" placeholder="\u2022\u2022\u2022\u2022">'+
      '<div id="tcreditErr" style="color:#B91C1C;font-size:12px;height:16px;margin-top:4px"></div>'+
      '<div style="display:flex;gap:8px;margin-top:8px">'+
        '<button id="tcreditCancel" style="flex:1;padding:10px;border:1px solid #cbd5e1;background:#fff;border-radius:7px;font-weight:700;cursor:pointer">Cancel</button>'+
        '<button id="tcreditOk" style="flex:1;padding:10px;border:0;background:#B91C1C;color:#fff;border-radius:7px;font-weight:700;cursor:pointer">Override &amp; Proceed</button>'+
      '</div></div>';
    document.body.appendChild(d);
  }
  function guard(a, onProceed){
    var rec=isHeld(a);
    if(!rec){ if(typeof onProceed==='function') onProceed(); return; }
    ensureModal();
    var m=document.getElementById('tcreditModal');
    document.getElementById('tcreditMsg').innerHTML='<strong>'+nameOf(rec.name||a)+'</strong> is on credit hold'+(rec.reason?' ('+String(rec.reason).replace(/[<>&]/g,'')+')':'')+'. A manager PIN is required to create new work for this account.';
    var pin=document.getElementById('tcreditPin'), err=document.getElementById('tcreditErr');
    pin.value=''; err.textContent=''; m.style.display='flex'; setTimeout(function(){ try{pin.focus();}catch(e){} },50);
    function close(){ m.style.display='none'; ok.onclick=null; cancel.onclick=null; pin.onkeydown=null; }
    var ok=document.getElementById('tcreditOk'), cancel=document.getElementById('tcreditCancel');
    cancel.onclick=close;
    function attempt(){ var p=(pin.value||'').trim(); if(PINS[p]){ logOverride({ account:nameOf(rec.name||a), reason:rec.reason||'', overrideBy:PINS[p], at:Date.now() }); close(); if(typeof onProceed==='function') onProceed(); } else { err.textContent='Invalid manager PIN.'; } }
    ok.onclick=attempt;
    pin.onkeydown=function(e){ if(e.key==='Enter') attempt(); };
  }

  window.TermacCredit={ isHeld:isHeld, setHold:setHold, release:release, list:list, badgeHTML:badgeHTML, guard:guard, keyOf:keyOf };
})();
