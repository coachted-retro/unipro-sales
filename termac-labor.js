/* ============================================================
   Termac One — Shared Labor module
   One rate model for the whole platform. Writes the existing
   termac_labor_ledger (the Labor Cost Dashboard reads it) and
   reads labor cost back by division for the P&L and Margin tab.

   Rate resolution, in order:
     1. HR per tech: termac_hr_users hourlyRate, loaded by burdenRate
     2. General default: termac_labor_rates.general, else $35/hr
   Accuracy improves on its own as HR fills in each staff rate.

   API:
     TermacLabor.record({jobId, techName, division, minutes, revenue})
       -> upserts one ledger entry per job (re-close does not double count)
     TermacLabor.byDivision(startMs, endMs) -> {division: laborCost}
   ============================================================ */
(function(){
  if (window.TermacLabor) return;
  var LEDGER='termac_labor_ledger', HR='termac_hr_users', RATES='termac_labor_rates';

  function ls(k){ try{ return JSON.parse(localStorage.getItem(k)||'[]'); }catch(e){ return []; } }
  function obj(k){ try{ return JSON.parse(localStorage.getItem(k)||'{}')||{}; }catch(e){ return {}; } }
  function generalDefault(){ var r=obj(RATES); return Number(r.general)>0 ? Number(r.general) : 35; }

  // returns { rate (loaded $/hr), isDefault }
  function resolveRate(techName){
    var name=String(techName||'').trim().toLowerCase();
    if(name){
      var users=ls(HR);
      for(var i=0;i<users.length;i++){
        var u=users[i];
        if(String(u.name||'').trim().toLowerCase()===name && Number(u.hourlyRate)>0){
          var burden=Number(u.burdenRate)||0;
          return { rate: Number(u.hourlyRate)*(1+burden/100), isDefault:false };
        }
      }
    }
    return { rate: generalDefault(), isDefault:true };
  }

  function record(o){
    o=o||{};
    var mins=Math.max(0, Number(o.minutes)||0);
    if(!mins) return null;
    var rr=resolveRate(o.techName);
    var entry={
      ts: Date.now(),
      jobId: o.jobId||('lbr_'+Date.now()),
      techName: o.techName||'Unknown',
      division: o.division||'',
      laborMinutes: mins,
      rate: rr.rate,
      isDefault: rr.isDefault,
      totalCost: (mins/60)*rr.rate,
      totalRevenue: Number(o.revenue)||0
    };
    var led=ls(LEDGER);
    // upsert by jobId so re-closing a job does not double count
    var idx=-1; for(var i=0;i<led.length;i++){ if(led[i].jobId===entry.jobId){ idx=i; break; } }
    if(idx>=0) led[idx]=entry; else led.push(entry);
    try{ localStorage.setItem(LEDGER, JSON.stringify(led)); }catch(e){}
    return entry;
  }

  function byDivision(start, end){
    var out={'UniPro':0,'Quality III':0,'GTO':0,'Filter Man':0,'AllPro':0,'Termac':0};
    ls(LEDGER).forEach(function(e){
      var d=e.division; if(!(d in out)) return;
      var ts=Number(e.ts)||0;
      if(start && ts<start) return; if(end && ts>end) return;
      out[d]+=Number(e.totalCost)||0;
    });
    return out;
  }

  window.TermacLabor = { record: record, byDivision: byDivision, resolveRate: resolveRate };
})();
