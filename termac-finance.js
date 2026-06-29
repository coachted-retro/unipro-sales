/* ============================================================
   Termac One — Finance helpers (shared, read-only)
   One source of truth for the headline finance numbers so the
   manager dashboard reads exactly what the controller computes.
   Mirrors accounting-portal.html: same AR stores, same aging,
   same gross-margin definition, same cash-on-hand store.

   API (all company-wide, all divisions):
     TermacFinance.dso()          -> integer days, or null if no billings
     TermacFinance.cashOnHand()   -> number (from cash forecast config)
     TermacFinance.jobMarginPct() -> gross margin % over last 90d, or null
     TermacFinance.openAR()       -> number, current open receivables
   Uses window.TermacCOGS and window.TermacLabor if present.
   ============================================================ */
(function(){
  if (window.TermacFinance) return;
  var DIVISIONS=['UniPro','Quality III','GTO','Filter Man','AllPro','Termac'];
  var AR_STORES={
    'UniPro':      ['unipro_jobs','unipro_invoices','quality3_jobs','quality3_invoices'],
    'Quality III': [],
    'GTO':         ['gto_jobs','gto_invoices'],
    'Filter Man':  ['filterman_jobs','filterman_invoices'],
    'AllPro':      ['allpro_jobs','allpro_invoices'],
    'Termac':      ['termac_jobs','termac_invoices','termac_svc_invoices']
  };
  var AP_KEY='termac_payables', CASH_CFG='termac_cash_cfg';
  var D=86400000;

  function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k)||'[]'); }catch(e){ return []; } }
  function amtOf(r){ return Number(r.total||r.revenue||r.amount||r.invoiceAmount||0); }
  function acctOf(r){ return r.accountName||r.biz||r.account||r.customer||r.accountId||'Unknown account'; }
  function isPaid(r){ return r.paymentStatus==='paid' || r.status==='paid' || r.invoicePaid===true || r.paid===true; }
  function dateMs(r){
    if(r.completedAt) return Number(r.completedAt);
    if(r.invoiceDate){ var a=Date.parse(r.invoiceDate); if(!isNaN(a)) return a; }
    if(r.date){ var b=Date.parse(r.date); if(!isNaN(b)) return b; }
    if(r.loggedAt) return Number(r.loggedAt);
    if(r.submittedAt) return Number(r.submittedAt);
    return Date.now();
  }
  function normDiv(d){
    if(!d) return null;
    var s=String(d).toLowerCase().replace(/[^a-z0-9]/g,'');
    if(s.indexOf('quality')>-1||s==='q3'||s==='qiii') return 'Quality III';
    if(s.indexOf('unipro')>-1) return 'UniPro';
    if(s.indexOf('gto')>-1) return 'GTO';
    if(s.indexOf('filter')>-1) return 'Filter Man';
    if(s.indexOf('allpro')>-1) return 'AllPro';
    if(s.indexOf('termac')>-1) return 'Termac';
    return null;
  }
  function loadAR(){
    var out=[], seen={};
    Object.keys(AR_STORES).forEach(function(div){
      AR_STORES[div].forEach(function(key){
        lsGet(key).forEach(function(r){
          var amt=amtOf(r); if(amt<=0) return;
          var id=(r.id||key+'_'+JSON.stringify(r).length)+'';
          if(seen[id]) return; seen[id]=1;
          out.push({ division:normDiv(r.division)||div, account:acctOf(r), amount:amt,
            date:dateMs(r), paid:isPaid(r), paidApplied:Number(r.paidApplied||0) });
        });
      });
    });
    return out;
  }
  function openBal(i){ if(i.paid) return 0; return Math.max(0, i.amount-(i.paidApplied||0)); }
  function fullyPaid(i){ return i.paid || (i.paidApplied||0) >= i.amount-0.01; }
  function loadAP(){ return lsGet(AP_KEY); }
  function apCOGSInPeriod(start,end){
    var out={}; DIVISIONS.forEach(function(d){ out[d]=0; });
    loadAP().forEach(function(b){
      var d=normDiv(b.division); if(!d||!(d in out)) return;
      var t=Number(b.loggedAt||(b.dueDate?Date.parse(b.dueDate):0))||0; if(t<start||t>end) return;
      var s=String(b.category||'').toLowerCase();
      if(/chemical|part|material|filter|fuel|gas|propane|subcontract|equipment|hardware|consumable|inventory|product|cylinder|nozzle|extinguisher/.test(s)) out[d]+=Number(b.amount)||0;
    });
    return out;
  }
  function cashCfg(){ try{ return JSON.parse(localStorage.getItem(CASH_CFG)||'{}')||{}; }catch(e){ return {}; } }

  function openAR(){
    var t=0; loadAR().forEach(function(i){ if(!fullyPaid(i)) t+=openBal(i); }); return t;
  }
  function dso(){
    var now=Date.now(), s90=now-90*D;
    var oar=openAR(), billed90=0;
    loadAR().forEach(function(i){ if(i.date>=s90&&i.date<=now) billed90+=i.amount; });
    return billed90>0 ? Math.round(oar/(billed90/90)) : null;
  }
  function jobMarginPct(){
    var now=Date.now(), s90=now-90*D, rev=0;
    loadAR().forEach(function(i){ if(i.date>=s90&&i.date<=now) rev+=i.amount; });
    if(rev<=0) return null;
    var mat=window.TermacCOGS?TermacCOGS.materialByDivision(s90,now):{};
    var lab=window.TermacLabor?TermacLabor.byDivision(s90,now):{};
    var apc=apCOGSInPeriod(s90,now)||{};
    var cogs=0; DIVISIONS.forEach(function(d){ cogs+=(mat[d]||0)+(lab[d]||0)+(apc[d]||0); });
    return (rev-cogs)/rev*100;
  }
  function cashOnHand(){ var c=cashCfg(); var v=Number(c.onHand); return isNaN(v)?null:v; }

  window.TermacFinance={ dso:dso, cashOnHand:cashOnHand, jobMarginPct:jobMarginPct, openAR:openAR };
})();
