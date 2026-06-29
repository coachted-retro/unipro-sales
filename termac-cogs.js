/* ============================================================
   Termac One — Shared Material COGS helper (read-only)
   Values real warehouse consumption by division and period.

   Source of truth (written by warehouse kitting + use/deduct,
   NOT modified here): each division warehouse store keeps a
   per-SKU txns ledger: { onHand, unitCost?, txns:[{type:'use',
   qty, ts, reason, ref}] }. Unit cost comes from termac_wh_cogs
   (with the per-stock unitCost set by the AP invoice scan as a
   fallback). Vans (wh_vans_v1) are nested per-tech without this
   ledger, so they are intentionally excluded.

   API:
     TermacCOGS.materialByDivision(startMs, endMs) -> {division: cost}
     TermacCOGS.detail(startMs, endMs) -> {byDiv, lines[]}
   Pass 0/undefined for start or end to leave that bound open.
   ============================================================ */
(function(){
  if (window.TermacCOGS) return;

  // Each division warehouse maps to the division its consumption books to.
  // UniPro warehouse covers UniPro and the Quality III crews that share it,
  // consistent with Quality III booking to the UniPro ledger on the AR side.
  var WH_DIV = { 'wh_termac_v1':'Termac', 'wh_unipro_v1':'UniPro', 'wh_allpro_v1':'AllPro' };
  var COGS_KEY = 'termac_wh_cogs';

  function lsObj(k){ try { return JSON.parse(localStorage.getItem(k)||'{}') || {}; } catch(e){ return {}; } }
  function unitCost(sku, rec, cm){
    if (cm[sku] && cm[sku].unitCost) return Number(cm[sku].unitCost)||0;
    if (rec && rec.unitCost) return Number(rec.unitCost)||0;
    return 0;
  }
  function nameOf(sku, rec, cm){
    if (cm[sku] && cm[sku].name) return cm[sku].name;
    if (rec && rec.name) return rec.name;
    return sku;
  }
  function scan(start, end, collectLines){
    var cm = lsObj(COGS_KEY);
    var byDiv = {'UniPro':0,'Quality III':0,'GTO':0,'Filter Man':0,'AllPro':0,'Termac':0};
    var lines = [];
    Object.keys(WH_DIV).forEach(function(key){
      var div = WH_DIV[key], store = lsObj(key);
      Object.keys(store).forEach(function(sku){
        var rec = store[sku];
        if (!rec || !rec.txns || !rec.txns.length) return;
        var uc = unitCost(sku, rec, cm);
        rec.txns.forEach(function(t){
          if (t.type !== 'use') return;
          var ts = Number(t.ts)||0;
          if (start && ts < start) return;
          if (end && ts > end) return;
          var qty = Number(t.qty)||0, cost = qty * uc;
          byDiv[div] += cost;
          if (collectLines && qty) lines.push({ division:div, sku:sku, name:nameOf(sku,rec,cm), qty:qty, unitCost:uc, cost:cost, ts:ts, ref:t.ref||'' });
        });
      });
    });
    return collectLines ? { byDiv:byDiv, lines:lines } : byDiv;
  }

  window.TermacCOGS = {
    materialByDivision: function(start, end){ return scan(start, end, false); },
    detail: function(start, end){ return scan(start, end, true); }
  };
})();
