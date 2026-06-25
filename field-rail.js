/* ═══════════════════════════════════════════════════════════════════════════
   TERMAC ONE — FIELD INTELLIGENCE RAIL  (field-rail.js)
   Shared collapsible sidebar for all tech portals.
   Includes: AI Field Assistant · Tag Scanner · Manual Lead · Voice Lead ·
             Next Job Intel · Alerts · Upsell Radar · Quick Tools ·
             Performance Pulse · Referral Bonus Tracker

   Usage: <script src="field-rail.js"></script>
          <script>fieldRailInit({ division:'UniPro', jobsKey:'unipro_jobs' });</script>

   Config object:
     division    — 'UniPro' | 'GTO' | 'Filter Man' | 'AllPro' | 'Termac'
     jobsKey     — localStorage key for today's jobs
     accentColor — hex color for division accent (optional)
     chipPrompts — array of quick-ask strings (optional)
     upsellMap   — { 'Service Type': ['upsell1','upsell2'] } (optional)
     serviceOpts — array of service type strings for manual lead form
     competitors — array of competitor names for tag scan form
═══════════════════════════════════════════════════════════════════════════ */

(function(window) {
'use strict';

// ── DIVISION CONFIGS ────────────────────────────────────────────────────────
const DIVISION_CONFIGS = {
  'UniPro': {
    accent: '#C8102E',
    label: 'Fire Protection',
    chips: ['Prep me for next job','NFPA code lookup','Running late message','Upsell opportunity at this stop','Handle customer objection','End of day summary'],
    upsellMap: {
      'Fire Inspection':   ['Hood Suppression semi-annual check','Extinguisher count audit — are all tagged?','Exit/emergency light survey'],
      'Hood Suppression':  ['Filter Man filter exchange program','GTO grease trap inspection','Extinguisher annual due?'],
      'Extinguisher':      ['Fire alarm inspection overdue?','Hood suppression annual coming up?','Exit lighting compliance'],
      'Fire Alarm':        ['Sprinkler inspection','Exit/emergency lighting','Suppression system check'],
      'Sprinkler':         ['Fire alarm annual','Extinguisher inspection','Suppression system'],
      'Emergency Light':   ['Fire alarm test','Extinguisher annual','Exit sign compliance audit'],
    },
    serviceOpts: ['Fire Extinguisher Inspection','Hood Suppression','Fire Alarm','Sprinkler Inspection','Emergency Lighting','Exit Signs','Kitchen Suppression'],
    competitors: ['Cintas','Amerex','Koorsen','Johnson Controls','Tyco / SimplexGrinnell','National Fire Protection','Other'],
    aiSystem: `You are an expert AI assistant for a UniPro fire protection technician at Termac Family of Companies. You know NFPA 10 (extinguishers), NFPA 96 (hood suppression), NFPA 25 (sprinkler/standpipe), NFPA 72 (fire alarm), NFPA 101 (emergency lighting), and commercial kitchen fire safety. Be concise and field-practical.`,
    tagPrompt: `This is a fire protection inspection tag. Extract: 1) Service company name, 2) Business/location name if visible, 3) Last inspection date, 4) Next inspection due date, 5) Service type (fire extinguisher, hood suppression, sprinkler, fire alarm, etc). Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}`,
    bonusLabel: 'Fire Protection Referral',
    bonusRate: 'Commission on conversion only',
  },
  'GTO': {
    accent: '#6D28D9',
    label: 'Grease Trap Service',
    chips: ['FOG compliance question','Running late message','Customer asking why trap smells','Upsell at this stop','End of day summary'],
    upsellMap: {
      'Grease Trap': ['UniPro fire extinguisher inspection — required in any commercial kitchen','Filter Man hood filter exchange','Chemical treatment program between pumps'],
      'FOG Service':  ['Fire extinguisher compliance check','Hood suppression inspection due?','Filter exchange frequency audit'],
    },
    serviceOpts: ['Grease Trap Pump-Out','FOG Compliance Report','Waste Hauler Certification','Chemical Treatment','Grease Interceptor Install'],
    competitors: ['US LBM','Liquid Environmental Solutions','Clean Harbors','Grease Co','Local hauler','Other'],
    aiSystem: `You are an expert AI assistant for a GTO grease trap service technician at Termac Family of Companies. You know FOG (fats, oils, grease) compliance regulations, municipal pretreatment requirements, grease trap sizing, pump-out frequency, waste hauler certifications, and related commercial kitchen compliance. Be concise and field-practical.`,
    tagPrompt: `This is a grease trap or FOG compliance service record/tag. Extract: 1) Service company name, 2) Business/location name, 3) Last service date, 4) Next service due date, 5) Trap size or service type. Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}`,
    bonusLabel: 'GTO Cross-Division Referral',
    bonusRate: 'Commission on conversion only',
  },
  'Filter Man': {
    accent: '#0D7490',
    label: 'Hood Filter Exchange',
    chips: ['Prep me for this stop','Hood filter frequency question','Running late message','Upsell at this account','NFPA 96 hood requirement','End of day summary'],
    upsellMap: {
      'Hood Filter':    ['GTO grease trap service — FOG compliance bundle','UniPro hood suppression inspection','Degreaser chemical treatment program'],
      'Filter Exchange':['Grease trap inspection overdue?','Hood suppression semi-annual check','Chemical clean between exchanges'],
    },
    serviceOpts: ['Hood Filter Exchange (Standard)','Hood Filter Exchange (Large Kitchen)','Filter Deep Clean','Emergency Filter Replacement','Hood System Inspection','Degreaser Application'],
    competitors: ['Wash Masters','National Filter Service','Local hood cleaning','Other'],
    aiSystem: `You are an expert AI assistant for a Filter Man hood filter exchange technician at Termac Family of Companies. You know commercial kitchen hood systems, NFPA 96 filter exchange frequency requirements, grease accumulation rates, Type I vs Type II hoods, and kitchen exhaust compliance. Be concise and field-practical.`,
    tagPrompt: `This is a hood filter exchange or hood cleaning service record. Extract: 1) Service company name, 2) Business/location name, 3) Last service date, 4) Next service due date, 5) Service frequency or type. Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}`,
    bonusLabel: 'Filter Man Cross-Division Referral',
    bonusRate: 'Commission on conversion only',
  },
  'AllPro': {
    accent: '#065F46',
    label: 'Stainless Fabrication',
    chips: ['Prep me for this job','Customer wants to add scope — how to handle','Running late message','Upsell at this stop','Material question','End of day summary'],
    upsellMap: {
      'Fabrication': ['UniPro fire extinguisher compliance check','Hood suppression system inspection for new hood','Grease trap sizing for new kitchen'],
      'Install':     ['Stainless backsplash while we have access','Shelving units — measure while on site','Hood suppression hookup — coordinate with UniPro'],
    },
    serviceOpts: ['Custom Stainless Fabrication','Stainless Shelving Install','Stainless Work Table Install','Exhaust Hood Install','Stainless Repair/Re-Weld','Polish & Restoration','Backsplash Install'],
    competitors: ['Local fabrication shop','National Restaurant Supply','Hobart','Other'],
    aiSystem: `You are an expert AI assistant for an AllPro stainless fabrication and installation technician at Termac Family of Companies. You know commercial kitchen stainless steel fabrication, NSF/ANSI standards, NFPA 96 hood requirements for new installs, welding specs, and installation best practices. Be concise and field-practical.`,
    tagPrompt: `This is a commercial kitchen equipment or fabrication service tag/label. Extract what you can: 1) Company name, 2) Business/location, 3) Date, 4) Equipment type. Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}`,
    bonusLabel: 'AllPro Cross-Division Referral',
    bonusRate: 'Commission on conversion only',
  },
  'Termac': {
    accent: '#7C3AED',
    label: 'Dish Machine & Chemical',
    chips: ['Prep me for this stop','Chemical reading question','NSF compliance question','Running late message','Upsell at this account','End of day summary'],
    upsellMap: {
      'Dish Machine':   ['UniPro fire extinguisher inspection — required in kitchen','GTO grease trap service bundle','Chemical upgrade for better NSF compliance'],
      'Chemical':       ['Dish machine upgrade or replacement','Filter Man hood filter exchange','Grease trap chemical treatment coordination'],
      'NSF Compliance': ['Suppression system annual coming up?','Grease trap compliance audit','Full kitchen compliance bundle'],
    },
    serviceOpts: ['Dish Machine Service','Chemical Replenishment','NSF Compliance Check','Machine Calibration','Sanitizer Reading','New Machine Install','Chemical System Upgrade'],
    competitors: ['Ecolab','Diversey','Cintas','WAXIE','Other'],
    aiSystem: `You are an expert AI assistant for a Termac dish machine and chemical service technician at Termac Family of Companies. You know commercial warewashing equipment, NSF/ANSI 3 standards, chemical sanitizing systems, detergent and sanitizer PPM readings, temperature requirements (NFPA, health code), and chemical safety. Be concise and field-practical.`,
    tagPrompt: `This is a dish machine service or chemical system tag/label. Extract: 1) Service company name, 2) Business/location, 3) Last service date, 4) Next service due date, 5) Machine type or chemical system. Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}`,
    bonusLabel: 'Termac Cross-Division Referral',
    bonusRate: 'Commission on conversion only',
  },
};

// ── REAL SALES REP TERRITORY MAP ────────────────────────────────────────────
const LEAD_TERRITORY = {
  'PA': { rep:'Ted Scholl',     email:'tscholl@termac.com',     phone:'267-421-6336' },
  'NJ': { rep:'Tom Pittakas',   email:'tpittakas@termac.com',   phone:'' },
  'DE': { rep:'Ted Scholl',     email:'tscholl@termac.com',     phone:'267-421-6336' }, // Quality III territory
  'MD': { rep:'Ted Scholl',     email:'tscholl@termac.com',     phone:'267-421-6336' },
  'DC': { rep:'Ted Scholl',     email:'tscholl@termac.com',     phone:'267-421-6336' },
};

// ── STATE ────────────────────────────────────────────────────────────────────
let _cfg = null;
let _lrailHistory = [];
let _lrailPhotoData = null;
let _lrailAdvHistory = [];
let _railCollapsed = false;
let _voiceText = '';

// ── HELPERS ──────────────────────────────────────────────────────────────────
function escR(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function frGet(key, def) { try { return JSON.parse(localStorage.getItem(key)||JSON.stringify(def)); } catch(e) { return def; } }
function frSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {} }

function getCurrentTechName() {
  // Read from platform identity
  var name = localStorage.getItem('termac_current_user') || '';
  if (!name) {
    try { var u = JSON.parse(sessionStorage.getItem('termac_current_user')||'{}'); name = u.name || ''; } catch(e) {}
  }
  return name || 'Tech';
}

function getTodayJobs() {
  var jobs = frGet(_cfg.jobsKey, []);
  var today = new Date().toISOString().split('T')[0];
  var techName = getCurrentTechName();
  return jobs.filter(function(j) {
    return j.date === today && (
      !techName ||
      j.tech === techName ||
      j.techId === techName ||
      j.techName === techName
    );
  });
}

// ── INJECT CSS ───────────────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('fieldRailCSS')) return;
  var accent = (_cfg && _cfg.accentColor) || '#C8102E';
  var s = document.createElement('style');
  s.id = 'fieldRailCSS';
  s.textContent = `
.fr-rail{width:260px;min-width:260px;background:#0F172A;border-right:1px solid #1E293B;display:flex;flex-direction:column;height:100vh;position:sticky;top:0;overflow:hidden;transition:width .2s,min-width .2s}
.fr-rail.collapsed{width:44px;min-width:44px}
.fr-rail-inner{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:0}
.fr-rail.collapsed .fr-rail-inner{overflow:hidden;opacity:0;pointer-events:none}
.fr-toggle{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #1E293B;flex-shrink:0;cursor:pointer;user-select:none}
.fr-toggle-label{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#94A3B8;white-space:nowrap;overflow:hidden}
.fr-rail.collapsed .fr-toggle-label{opacity:0}
.fr-toggle-btn{background:none;border:1px solid #334155;border-radius:5px;color:#64748B;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:13px;transition:all .15s}
.fr-toggle-btn:hover{border-color:${accent};color:${accent}}
.fr-section{margin-bottom:16px}
.fr-hdr{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#475569;margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid #1E293B;display:flex;align-items:center;justify-content:space-between;cursor:pointer}
.fr-hdr-chevron{color:#334155;font-size:10px;transition:transform .15s}
.fr-section.collapsed .fr-hdr-chevron{transform:rotate(-90deg)}
.fr-section-body{overflow:hidden;transition:max-height .2s}
.fr-section.collapsed .fr-section-body{max-height:0!important}
.fr-card{background:#1E293B;border-radius:8px;padding:10px 12px;margin-bottom:6px;border:1px solid #334155;font-size:11px;color:#CBD5E1;line-height:1.6}
.fr-card.alert{border-color:#EF4444;background:#1F0F0F}
.fr-card.tip{border-color:#F59E0B;background:#1A1500}
.fr-card.green{border-color:#059669;background:#021F14}
.fr-title{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#94A3B8;margin-bottom:5px}
.fr-title.red{color:#F87171}.fr-title.gold{color:#FCD34D}.fr-title.green{color:#6EE7B7}
.fr-btn{display:block;width:100%;margin-top:6px;padding:6px 8px;background:${accent};border:none;border-radius:6px;color:#fff;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;text-align:center;transition:background .12s}
.fr-btn:hover{filter:brightness(1.12)}
.fr-btn.ghost{background:#334155;color:#CBD5E1}.fr-btn.ghost:hover{background:#475569}
.fr-btn.gold{background:#D97706}.fr-btn.green{background:#059669}
.fr-input{width:100%;background:#1E293B;border:1px solid #334155;border-radius:5px;color:#F8FAFC;font-size:11px;padding:5px 8px;outline:none;font-family:Barlow,sans-serif;margin-bottom:4px;box-sizing:border-box}
.fr-input:focus{border-color:${accent}}
.fr-select{width:100%;background:#1E293B;border:1px solid #334155;border-radius:5px;color:#F8FAFC;font-size:11px;padding:5px 8px;outline:none;margin-bottom:4px;box-sizing:border-box}
.fr-chat{background:#0F172A;border-radius:8px;border:1px solid #1E293B;display:flex;flex-direction:column;height:240px}
.fr-chat-msgs{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px}
.fr-msg{font-size:11px;line-height:1.4;padding:6px 8px;border-radius:7px;max-width:95%}
.fr-msg.ai{background:#1E293B;color:#E2E8F0;align-self:flex-start}
.fr-msg.user{background:${accent};color:#fff;align-self:flex-end}
.fr-msg.thinking{color:#475569;font-style:italic;background:none;padding:2px 0}
.fr-chat-inp{display:flex;gap:3px;padding:6px;border-top:1px solid #1E293B}
.fr-chat-inp input{flex:1;background:#1E293B;border:1px solid #334155;border-radius:5px;color:#F8FAFC;font-size:10px;padding:5px 7px;outline:none;font-family:Barlow,sans-serif}
.fr-chat-inp button{background:${accent};border:none;border-radius:5px;color:#fff;width:26px;cursor:pointer;font-size:11px;flex-shrink:0}
.fr-chip{display:inline-block;background:#1E293B;border:1px solid #334155;border-radius:99px;padding:3px 7px;font-size:9px;color:#94A3B8;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:2px;transition:all .1s}
.fr-chip:hover{background:${accent};border-color:${accent};color:#fff}
.fr-mode-bar{display:flex;gap:2px;margin-bottom:6px;background:#0F172A;border-radius:5px;padding:2px}
.fr-mode-btn{flex:1;background:transparent;border:none;color:#64748B;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:4px;border-radius:4px;cursor:pointer;transition:all .1s}
.fr-mode-btn.active{background:${accent};color:#fff}
.fr-adv-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:6px}
.fr-adv-cat{background:#1E293B;border:1px solid #334155;border-radius:5px;color:#94A3B8;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:5px 3px;cursor:pointer;transition:all .1s;text-align:center}
.fr-adv-cat.active{background:${accent};border-color:${accent};color:#fff}
.fr-adv-sub{background:#334155;border:none;border-radius:4px;color:#CBD5E1;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:5px 3px;cursor:pointer;transition:background .1s;text-align:center}
.fr-adv-sub:hover{background:#475569}
.fr-adv-grid-sub{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:4px}
.fr-adv-resp{background:#0F172A;border:1px solid #1E293B;border-radius:7px;padding:10px;font-size:11px;color:#CBD5E1;line-height:1.6;max-height:200px;overflow-y:auto;margin-top:6px;display:none}
.fr-perf-bar{height:4px;background:#1E293B;border-radius:99px;overflow:hidden;margin-top:2px;margin-bottom:6px}
.fr-perf-fill{height:100%;border-radius:99px}
.fr-tag-result{background:#1E293B;border-radius:7px;padding:8px 10px;font-size:11px;margin-top:6px;display:none}
.fr-confirm{display:none;margin-top:6px}
@media(max-width:900px){.fr-rail{display:none}}
  `.trim();
  document.head.appendChild(s);
}

// ── BUILD HTML ────────────────────────────────────────────────────────────────
function buildHTML() {
  var div = _cfg.division;
  var dcfg = DIVISION_CONFIGS[div] || DIVISION_CONFIGS['UniPro'];
  var svcOptions = (dcfg.serviceOpts || []).map(function(s) { return '<option>'+escR(s)+'</option>'; }).join('');
  var compOptions = (dcfg.competitors || []).map(function(c) { return '<option>'+escR(c)+'</option>'; }).join('');

  return `
<div class="fr-rail" id="frRail">
  <!-- TOGGLE BAR -->
  <div class="fr-toggle" onclick="frToggleRail()">
    <span class="fr-toggle-label">🛠 Field Intelligence</span>
    <button class="fr-toggle-btn" id="frToggleBtn" title="Collapse/expand rail">◀</button>
  </div>

  <div class="fr-rail-inner" id="frRailInner">

    <!-- ① AI FIELD ASSISTANT -->
    <div class="fr-section" id="frSec-ai">
      <div class="fr-hdr" onclick="frToggleSec('ai')">🤖 AI Field Assistant <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body">
        <div class="fr-mode-bar">
          <button class="fr-mode-btn active" id="frModeChat" onclick="frSetMode('chat')">💬 Chat</button>
          <button class="fr-mode-btn" id="frModeAdvisor" onclick="frSetMode('advisor')">🔧 Advisor</button>
        </div>
        <!-- CHAT -->
        <div id="frChatMode">
          <div class="fr-chat" id="frChat">
            <div class="fr-chat-msgs" id="frMsgs">
              <div class="fr-msg ai">Hi! Ask me anything — job prep, codes, customer objections, upsell pitches, or how to handle a situation on site.</div>
            </div>
            <div style="padding:4px 6px;border-top:1px solid #1E293B;display:flex;gap:3px;flex-wrap:wrap" id="frChips"></div>
            <div class="fr-chat-inp">
              <input id="frChatInput" placeholder="Ask anything…" onkeydown="if(event.key==='Enter')frChatSend()">
              <button onclick="frChatSend()">➤</button>
            </div>
          </div>
        </div>
        <!-- ADVISOR -->
        <div id="frAdvisorMode" style="display:none">
          <div class="fr-adv-grid">
            <button class="fr-adv-cat active" id="frAdvCat-situation" onclick="frAdvCat('situation')">🚨 Situation</button>
            <button class="fr-adv-cat" id="frAdvCat-equipment" onclick="frAdvCat('equipment')">🔩 Equipment</button>
            <button class="fr-adv-cat" id="frAdvCat-code" onclick="frAdvCat('code')">📋 Code</button>
            <button class="fr-adv-cat" id="frAdvCat-chemical" onclick="frAdvCat('chemical')">🧪 Chemical</button>
          </div>
          <!-- Situation -->
          <div id="frAdvPanel-situation">
            <textarea id="frAdvSitInput" class="fr-input" rows="3" placeholder="Describe what you're seeing or dealing with…" style="resize:none"></textarea>
            <div style="display:flex;gap:4px">
              <button class="fr-btn" style="flex:1" onclick="frAdvSubmit('situation')">⚡ Get Guidance</button>
              <button class="fr-btn ghost" style="width:36px" onclick="frAdvCamera('situation')">📷</button>
            </div>
            <div id="frAdvSitPhoto" style="display:none;margin-top:4px"></div>
            <input type="file" id="frAdvSitFile" accept="image/*" capture="environment" style="display:none" onchange="frAdvPhotoSelected(this,'situation')">
          </div>
          <!-- Equipment -->
          <div id="frAdvPanel-equipment" style="display:none">
            <input id="frAdvEquipInput" class="fr-input" placeholder="Equipment name, model, or part…">
            <div class="fr-adv-grid-sub">
              <button class="fr-adv-sub" onclick="frAdvEquip('specs')">📐 Specs</button>
              <button class="fr-adv-sub" onclick="frAdvEquip('service')">🔧 Service</button>
              <button class="fr-adv-sub" onclick="frAdvEquip('troubleshoot')">🔍 Troubleshoot</button>
              <button class="fr-adv-sub" onclick="frAdvEquip('intervals')">📅 Intervals</button>
            </div>
            <div style="display:flex;gap:4px;margin-top:4px">
              <button class="fr-btn ghost" style="flex:1;font-size:9px" onclick="frAdvCamera('equipment')">📷 Photo ID</button>
            </div>
            <div id="frAdvEquipPhoto" style="display:none;margin-top:4px"></div>
            <input type="file" id="frAdvEquipFile" accept="image/*" capture="environment" style="display:none" onchange="frAdvPhotoSelected(this,'equipment')">
          </div>
          <!-- Code -->
          <div id="frAdvPanel-code" style="display:none">
            <input id="frAdvCodeInput" class="fr-input" placeholder="Code topic, standard, or question…">
            <button class="fr-btn" onclick="frAdvSubmit('code')">⚡ Look Up</button>
          </div>
          <!-- Chemical -->
          <div id="frAdvPanel-chemical" style="display:none">
            <input id="frAdvChemInput" class="fr-input" placeholder="Chemical or product name…">
            <div class="fr-adv-grid-sub">
              <button class="fr-adv-sub" onclick="frAdvChem('mixing')">⚗️ Mixing</button>
              <button class="fr-adv-sub" onclick="frAdvChem('safety')">⚠️ Safety</button>
              <button class="fr-adv-sub" onclick="frAdvChem('application')">🧴 Apply</button>
              <button class="fr-adv-sub" onclick="frAdvChem('alternatives')">🔄 Alt</button>
            </div>
          </div>
          <!-- Response -->
          <div class="fr-adv-resp" id="frAdvResp">
            <div id="frAdvRespText"></div>
            <div style="display:flex;gap:4px;margin-top:8px">
              <button class="fr-btn ghost" style="flex:1;font-size:9px" onclick="frAdvFollowUp()">↩ Follow-up</button>
              <button class="fr-btn ghost" style="width:36px;font-size:9px" onclick="frAdvClear()">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ② NEXT JOB INTEL -->
    <div class="fr-section" id="frSec-nextjob">
      <div class="fr-hdr" onclick="frToggleSec('nextjob')">⚡ Next Job Intel <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body"><div id="frNextJob"><div class="fr-card" style="color:#475569">Loading…</div></div></div>
    </div>

    <!-- ③ ALERTS & FLAGS -->
    <div class="fr-section" id="frSec-alerts">
      <div class="fr-hdr" onclick="frToggleSec('alerts')">🔔 Alerts & Flags <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body"><div id="frAlerts"><div class="fr-card" style="color:#475569">Checking…</div></div></div>
    </div>

    <!-- ④ UPSELL RADAR -->
    <div class="fr-section" id="frSec-upsell">
      <div class="fr-hdr" onclick="frToggleSec('upsell')">💰 Upsell Radar <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body"><div id="frUpsell"><div class="fr-card" style="color:#475569">Loading…</div></div></div>
    </div>

    <!-- ⑤ FIELD LEAD CAPTURE -->
    <div class="fr-section" id="frSec-lead">
      <div class="fr-hdr" onclick="frToggleSec('lead')">🎯 Field Lead Capture <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body">
        <div class="fr-card" style="background:#0F172A;border-color:#334155">
          <div class="fr-mode-bar">
            <button class="fr-mode-btn active" id="frLeadMode-scan" onclick="frLeadSetMode('scan')">📷 Scan</button>
            <button class="fr-mode-btn" id="frLeadMode-manual" onclick="frLeadSetMode('manual')">✏️ Manual</button>
            <button class="fr-mode-btn" id="frLeadMode-voice" onclick="frLeadSetMode('voice')">🎤 Voice</button>
          </div>
          <!-- SCAN -->
          <div id="frLeadPanel-scan">
            <div style="font-size:9px;color:#64748B;margin-bottom:5px">Point camera at inspection tag — AI reads competitor, service, and expiry date</div>
            <button class="fr-btn gold" onclick="frLeadScanTag()">📷 Open Camera</button>
            <input type="file" id="frLeadTagFile" accept="image/*" capture="environment" style="display:none" onchange="frLeadTagSelected(this)">
            <div id="frLeadTagPreview" style="margin-top:6px;display:none"></div>
            <div class="fr-tag-result" id="frLeadTagResult"></div>
          </div>
          <!-- MANUAL -->
          <div id="frLeadPanel-manual" style="display:none">
            <div style="font-size:9px;color:#64748B;margin-bottom:5px">Saw a competitor tag or business that needs service?</div>
            <input id="frLeadBiz" class="fr-input" placeholder="Business name *">
            <input id="frLeadAddr" class="fr-input" placeholder="Address">
            <input id="frLeadPhone" class="fr-input" placeholder="Phone (optional)">
            <select id="frLeadService" class="fr-select"><option value="">Service type…</option>${svcOptions}</select>
            <select id="frLeadCompetitor" class="fr-select"><option value="">Competitor on tag? (optional)</option>${compOptions}</select>
            <input id="frLeadExpiry" type="date" class="fr-input" title="Inspection expiry from tag">
            <div style="font-size:9px;color:#64748B;margin-bottom:4px">Expiry date → 60-day follow-up auto-scheduled</div>
            <button class="fr-btn" onclick="frLeadSubmitManual()">⚡ Submit to Sales Rep</button>
          </div>
          <!-- VOICE -->
          <div id="frLeadPanel-voice" style="display:none">
            <div style="font-size:9px;color:#64748B;margin-bottom:5px">Describe the lead — business, location, what you saw</div>
            <button class="fr-btn" id="frVoiceBtn" onclick="frLeadStartVoice()">🎤 Start Recording</button>
            <div id="frVoiceStatus" style="font-size:9px;color:#64748B;margin-top:4px;min-height:14px"></div>
            <div id="frVoiceTranscript" style="background:#1E293B;border-radius:5px;padding:6px;font-size:10px;color:#E2E8F0;margin-top:4px;min-height:36px;display:none"></div>
            <button id="frVoiceProcess" class="fr-btn gold" style="display:none;margin-top:4px" onclick="frLeadProcessVoice()">⚡ Process Lead</button>
          </div>
        </div>
        <div class="fr-confirm" id="frLeadConfirm"></div>
      </div>
    </div>

    <!-- ⑥ QUICK TOOLS -->
    <div class="fr-section" id="frSec-tools">
      <div class="fr-hdr" onclick="frToggleSec('tools')">🔧 Quick Tools <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body">
        <button class="fr-btn ghost" onclick="frTool('nfpa')">📋 Code / Standards Lookup</button>
        <button class="fr-btn ghost" onclick="frTool('checklist')">✅ Pre-Job Checklist</button>
        <button class="fr-btn ghost" onclick="frTool('late')">📞 Running Late Message</button>
        <button class="fr-btn ghost" onclick="frTool('parts')">🔩 Parts Request Guide</button>
        <button class="fr-btn ghost" onclick="frTool('debrief')">📝 Job Debrief Prompt</button>
      </div>
    </div>

    <!-- ⑦ PERFORMANCE PULSE -->
    <div class="fr-section" id="frSec-perf">
      <div class="fr-hdr" onclick="frToggleSec('perf')">📊 Performance Pulse <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body"><div id="frPerf"><div class="fr-card" style="color:#475569">Loading…</div></div></div>
    </div>

    <!-- ⑧ REFERRAL BONUS TRACKER -->
    <div class="fr-section" id="frSec-bonus">
      <div class="fr-hdr" onclick="frToggleSec('bonus')">💰 Referral Bonus Tracker <span class="fr-hdr-chevron">▾</span></div>
      <div class="fr-section-body"><div id="frBonus"><div class="fr-card" style="color:#475569">Loading…</div></div></div>
    </div>

  </div><!-- /fr-rail-inner -->
</div><!-- /fr-rail -->`;
}

// ── RAIL COLLAPSE ─────────────────────────────────────────────────────────────
window.frToggleRail = function() {
  _railCollapsed = !_railCollapsed;
  var rail = document.getElementById('frRail');
  var btn  = document.getElementById('frToggleBtn');
  if (rail) rail.classList.toggle('collapsed', _railCollapsed);
  if (btn)  btn.textContent = _railCollapsed ? '▶' : '◀';
  localStorage.setItem('fr_rail_collapsed', _railCollapsed ? '1' : '0');
};

window.frToggleSec = function(sec) {
  var el = document.getElementById('frSec-'+sec);
  if (el) el.classList.toggle('collapsed');
};

// ── MODE SWITCHING ────────────────────────────────────────────────────────────
window.frSetMode = function(mode) {
  document.getElementById('frChatMode').style.display    = mode==='chat'    ? 'block' : 'none';
  document.getElementById('frAdvisorMode').style.display = mode==='advisor' ? 'block' : 'none';
  document.getElementById('frModeChat').classList.toggle('active',    mode==='chat');
  document.getElementById('frModeAdvisor').classList.toggle('active', mode==='advisor');
};

window.frLeadSetMode = function(mode) {
  ['scan','manual','voice'].forEach(function(m) {
    document.getElementById('frLeadPanel-'+m).style.display = m===mode ? 'block' : 'none';
    document.getElementById('frLeadMode-'+m).classList.toggle('active', m===mode);
  });
};

window.frAdvCat = function(cat) {
  ['situation','equipment','code','chemical'].forEach(function(c) {
    document.getElementById('frAdvPanel-'+c).style.display = c===cat ? 'block' : 'none';
    document.getElementById('frAdvCat-'+c).classList.toggle('active', c===cat);
  });
  document.getElementById('frAdvResp').style.display = 'none';
};

// ── AI CHAT ───────────────────────────────────────────────────────────────────
window.frChatAsk = function(q) {
  document.getElementById('frChatInput').value = q;
  frChatSend();
};

window.frChatSend = async function() {
  var inp = document.getElementById('frChatInput');
  var q = inp.value.trim();
  if (!q) return;
  inp.value = '';
  var msgs = document.getElementById('frMsgs');
  var div = _cfg.division;
  var dcfg = DIVISION_CONFIGS[div] || DIVISION_CONFIGS['UniPro'];

  var uDiv = document.createElement('div');
  uDiv.className = 'fr-msg user'; uDiv.textContent = q; msgs.appendChild(uDiv);
  var thinkDiv = document.createElement('div');
  thinkDiv.className = 'fr-msg thinking'; thinkDiv.textContent = 'Thinking…'; msgs.appendChild(thinkDiv);
  msgs.scrollTop = msgs.scrollHeight;

  var techName = getCurrentTechName();
  var myJobs = getTodayJobs();
  var system = (dcfg.aiSystem||'You are a helpful field technician assistant for Termac Family of Companies.') +
    '\n\nTECH: ' + techName + ' | DIVISION: ' + div +
    '\nTODAY\'S JOBS:\n' + (myJobs.map(function(j){ return (j.time||'')+ ' ' +(j.biz||j.account||j.accountName||'') +' | '+(j.service||j.serviceType||'') + ' | ' + (j.status||''); }).join('\n') || 'No jobs loaded');

  _lrailHistory.push({role:'user', content:q});
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:400, system, messages:_lrailHistory.slice(-8)})
    });
    var data = await resp.json();
    var reply = (data.content && data.content[0] && data.content[0].text) || 'No response.';
    _lrailHistory.push({role:'assistant', content:reply});
    thinkDiv.className = 'fr-msg ai'; thinkDiv.textContent = reply;
  } catch(e) {
    thinkDiv.className = 'fr-msg ai'; thinkDiv.style.color='#475569'; thinkDiv.textContent = 'Connection error — try again.';
  }
  msgs.scrollTop = msgs.scrollHeight;
};

// ── FIELD ADVISOR ─────────────────────────────────────────────────────────────
async function frAdvCall(userMsg, systemPrompt) {
  var respEl = document.getElementById('frAdvResp');
  var textEl = document.getElementById('frAdvRespText');
  respEl.style.display = 'block'; textEl.innerHTML = '<span style="color:#64748B;font-style:italic">⚡ Analyzing…</span>';
  var messages;
  if (_lrailPhotoData) {
    messages = [{role:'user', content:[{type:'image',source:{type:'base64',media_type:_lrailPhotoData.type,data:_lrailPhotoData.data}},{type:'text',text:userMsg}]}];
  } else {
    messages = [{role:'user', content:userMsg}];
  }
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:600, system:systemPrompt, messages})
    });
    var data = await resp.json();
    var reply = (data.content && data.content[0] && data.content[0].text) || 'No response.';
    var formatted = reply.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n\n/g,'</p><p style="margin-top:6px">').replace(/\n/g,'<br>');
    textEl.innerHTML = '<p>'+formatted+'</p>';
    _lrailAdvHistory = [{role:'user',content:userMsg},{role:'assistant',content:reply}];
    _lrailPhotoData = null;
  } catch(e) {
    textEl.innerHTML = '<span style="color:#EF4444">Connection error — try again.</span>';
  }
}

window.frAdvSubmit = function(type) {
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  var q = '';
  if (type==='situation') q = document.getElementById('frAdvSitInput').value.trim();
  if (type==='code')      q = document.getElementById('frAdvCodeInput').value.trim();
  if (!q) { alert('Please describe the situation or enter a topic.'); return; }
  var prefixes = {
    situation: 'FIELD SITUATION — Tech needs immediate guidance:\n\n',
    code: 'CODE/COMPLIANCE QUESTION:\n\n',
  };
  frAdvCall((prefixes[type]||'')+q, dcfg.aiSystem||'You are a helpful field technician advisor.');
};

window.frAdvEquip = function(action) {
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  var equip = document.getElementById('frAdvEquipInput').value.trim();
  if (!equip) { alert('Enter equipment name or model first.'); return; }
  var actionMap = {
    specs:       'Key technical specifications for: '+equip,
    service:     'Step-by-step service procedure for: '+equip+'. Include tools needed and safety precautions.',
    troubleshoot:'Common failure points and troubleshooting for: '+equip,
    intervals:   'Manufacturer-recommended and regulatory service intervals for: '+equip+'. What must be documented?',
  };
  frAdvCall(actionMap[action], dcfg.aiSystem||'You are an expert field technician advisor.');
};

window.frAdvChem = function(action) {
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  var chem = document.getElementById('frAdvChemInput').value.trim();
  if (!chem) { alert('Enter chemical or product name first.'); return; }
  var actionMap = {
    mixing:      'Correct mixing ratios and dilution for: '+chem,
    safety:      'PPE requirements and safety precautions for handling: '+chem+'. Include first aid steps.',
    application: 'Correct application procedure for: '+chem+' in a commercial setting.',
    alternatives:'Suitable alternatives or substitutes for: '+chem+'. Any compatibility considerations?',
  };
  frAdvCall(actionMap[action], dcfg.aiSystem||'You are a chemical safety and application expert.');
};

window.frAdvCamera = function(ctx) {
  document.getElementById(ctx==='situation' ? 'frAdvSitFile' : 'frAdvEquipFile').click();
};

window.frAdvPhotoSelected = function(input, ctx) {
  var file = input.files[0];
  if (!file) return;
  var photoDiv = document.getElementById(ctx==='situation' ? 'frAdvSitPhoto' : 'frAdvEquipPhoto');
  photoDiv.style.display = 'block';
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result.split(',')[1];
    var mime = file.type || 'image/jpeg';
    _lrailPhotoData = {data:base64, type:mime};
    photoDiv.innerHTML = '<div style="position:relative;display:inline-block;width:100%"><img src="'+e.target.result+'" style="width:100%;border-radius:6px;border:1px solid #334155;max-height:100px;object-fit:cover"><div style="position:absolute;top:3px;right:3px;background:#059669;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:700;color:#fff">📷 READY</div></div><div style="font-size:9px;color:#34D399;margin-top:3px">✅ Photo attached — AI will analyze with your query</div>';
    if (ctx === 'equipment') { frAdvAutoIdentify(base64, mime); }
  };
  reader.readAsDataURL(file);
};

async function frAdvAutoIdentify(base64, mimeType) {
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  var textEl = document.getElementById('frAdvRespText');
  var respEl = document.getElementById('frAdvResp');
  respEl.style.display = 'block';
  textEl.innerHTML = '<span style="color:#64748B;font-style:italic">🔍 Identifying equipment from photo…</span>';
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:400,
        system: dcfg.aiSystem + ' When given a photo, identify the equipment make, model, and any visible serial numbers.',
        messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:mimeType,data:base64}},{type:'text',text:'What equipment is this? Identify make, model, and any visible part/serial numbers. What should I know about servicing it?'}]}]})
    });
    var data = await resp.json();
    var reply = (data.content && data.content[0] && data.content[0].text) || 'Could not identify.';
    var modelMatch = reply.match(/model[:\s]+([A-Z0-9\-]+)/i);
    if (modelMatch) document.getElementById('frAdvEquipInput').value = modelMatch[1];
    var formatted = reply.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n\n/g,'</p><p style="margin-top:6px">').replace(/\n/g,'<br>');
    textEl.innerHTML = '<strong style="color:#FCD34D">📷 AI Equipment ID:</strong><p style="margin-top:4px">'+formatted+'</p>';
    _lrailAdvHistory = [{role:'user',content:'Identify this equipment'},{role:'assistant',content:reply}];
    _lrailPhotoData = {data:base64, type:mimeType};
  } catch(e) {
    textEl.innerHTML = '<span style="color:#EF4444">Could not analyze photo.</span>';
  }
}

window.frAdvFollowUp = function() {
  var q = prompt('Follow-up question:');
  if (!q) return;
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  _lrailAdvHistory.push({role:'user',content:q});
  fetch('https://api.anthropic.com/v1/messages', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:400,system:dcfg.aiSystem,messages:_lrailAdvHistory.slice(-6)})})
  .then(function(r){return r.json();}).then(function(data){
    var reply = (data.content && data.content[0] && data.content[0].text) || '';
    _lrailAdvHistory.push({role:'assistant',content:reply});
    var textEl = document.getElementById('frAdvRespText');
    var formatted = reply.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n\n/g,'</p><p style="margin-top:6px">').replace(/\n/g,'<br>');
    textEl.innerHTML += '<hr style="border-color:#334155;margin:6px 0"><p><strong style="color:#FCD34D">↩ '+escR(q)+'</strong></p><p>'+formatted+'</p>';
    document.getElementById('frAdvResp').scrollTop = 9999;
  });
};

window.frAdvClear = function() {
  document.getElementById('frAdvResp').style.display='none';
  document.getElementById('frAdvRespText').innerHTML='';
  _lrailAdvHistory=[]; _lrailPhotoData=null;
  ['frAdvSitPhoto','frAdvEquipPhoto'].forEach(function(id){var el=document.getElementById(id);if(el){el.style.display='none';el.innerHTML='';}});
};

// ── TAG SCAN ──────────────────────────────────────────────────────────────────
window.frLeadScanTag = function() { document.getElementById('frLeadTagFile').click(); };

window.frLeadTagSelected = function(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var prev = document.getElementById('frLeadTagPreview');
    prev.style.display='block';
    prev.innerHTML='<img src="'+e.target.result+'" style="width:100%;border-radius:5px;max-height:100px;object-fit:cover">';
    frLeadAnalyzeTag(e.target.result.split(',')[1], file.type||'image/jpeg');
  };
  reader.readAsDataURL(file);
};

async function frLeadAnalyzeTag(base64, mimeType) {
  var result = document.getElementById('frLeadTagResult');
  result.style.display='block';
  result.innerHTML='<div style="color:#F59E0B;font-size:10px">🤖 Reading tag…</div>';
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:400,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:mimeType,data:base64}},
          {type:'text',text:dcfg.tagPrompt || 'Extract service info from this tag. Return JSON only: {"company":"","business":"","address":"","lastDate":"","nextDate":"","serviceType":""}'}
        ]}]})
    });
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '{}';
    var parsed = JSON.parse(text.replace(/```json|```/g,'').trim());

    // Calculate 60-day follow-up
    var followUpDate = '';
    if (parsed.nextDate) {
      var next = new Date(parsed.nextDate);
      if (!isNaN(next)) {
        var fu = new Date(next.getTime() - 60*24*60*60*1000);
        followUpDate = fu.toISOString().split('T')[0];
      }
    }
    parsed.followUpDate = followUpDate;

    result.innerHTML =
      '<div style="background:#1E293B;border-radius:6px;padding:8px 10px;font-size:10px">' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:9px;color:#F59E0B;letter-spacing:.08em;margin-bottom:6px">📋 TAG SCANNED</div>' +
      (parsed.company   ? '<div style="color:#94A3B8">Competitor: <span style="color:#F87171;font-weight:700">'+escR(parsed.company)+'</span></div>'    : '') +
      (parsed.business  ? '<div style="color:#94A3B8">Business: <span style="color:#E2E8F0;font-weight:600">'+escR(parsed.business)+'</span></div>'   : '') +
      (parsed.serviceType?'<div style="color:#94A3B8">Service: <span style="color:#E2E8F0">'+escR(parsed.serviceType)+'</span></div>'                 : '') +
      (parsed.nextDate  ? '<div style="color:#94A3B8">Next due: <span style="color:#FCD34D;font-weight:700">'+escR(parsed.nextDate)+'</span></div>'   : '') +
      (followUpDate     ? '<div style="color:#34D399;margin-top:4px;font-size:9px">⏰ Follow-up: '+followUpDate+' (60 days before expiry)</div>'      : '') +
      '</div>' +
      '<button class="fr-btn" style="margin-top:6px" onclick="frLeadSubmitFromTag(\''+escR(JSON.stringify(parsed)).replace(/'/g,"\\'")+'\')">⚡ Send to Sales Rep</button>';

  } catch(e) {
    result.innerHTML='<div style="color:#EF4444;font-size:10px">Could not read tag — try better lighting or manual entry.</div>';
  }
}

window.frLeadSubmitFromTag = function(dataStr) {
  var parsed = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
  var lead = {
    id: 'field_scan_'+Date.now(),
    source: 'Field Scan — Competitor Tag ('+_cfg.division+')',
    business: parsed.business || 'Unknown (from tag)',
    address: parsed.address || '',
    services: [parsed.serviceType || 'Fire Inspection'],
    notes: 'Competitor tag: '+(parsed.company||'Unknown')+'. Next due: '+(parsed.nextDate||'Unknown')+'. Scanned by '+(getCurrentTechName())+' ('+_cfg.division+').',
    referredBy: getCurrentTechName(),
    followUpDate: parsed.followUpDate || '',
    competitorTag: parsed.company || '',
    inspectionExpiry: parsed.nextDate || '',
    sourceDivision: _cfg.division,
    lifecycleStage: 'lead',
    score: parsed.nextDate ? 9 : 7, // Higher score if we have expiry date
    createdAt: Date.now(),
  };
  frLeadRoute(lead);
};

// ── MANUAL LEAD ───────────────────────────────────────────────────────────────
window.frLeadSubmitManual = function() {
  var biz = document.getElementById('frLeadBiz').value.trim();
  if (!biz) { alert('Business name required.'); return; }
  var expiry = document.getElementById('frLeadExpiry').value;
  var followUpDate = '';
  if (expiry) {
    var next = new Date(expiry);
    if (!isNaN(next)) followUpDate = new Date(next.getTime()-60*24*60*60*1000).toISOString().split('T')[0];
  }
  var competitor = document.getElementById('frLeadCompetitor').value;
  var service    = document.getElementById('frLeadService').value;
  var lead = {
    id: 'field_manual_'+Date.now(),
    source: 'Field Manual — Tech Referral ('+_cfg.division+')',
    business: biz,
    address: document.getElementById('frLeadAddr').value,
    phone: document.getElementById('frLeadPhone').value,
    services: service ? [service] : [],
    competitorTag: competitor,
    inspectionExpiry: expiry,
    followUpDate,
    notes: 'Spotted by '+getCurrentTechName()+' ('+_cfg.division+').'+(competitor?' Competitor: '+competitor+'.'+(expiry?' Expires: '+expiry+'.':''):''),
    referredBy: getCurrentTechName(),
    sourceDivision: _cfg.division,
    lifecycleStage: 'lead',
    score: expiry ? 8 : 6,
    createdAt: Date.now(),
  };
  frLeadRoute(lead);
  // Clear form
  ['frLeadBiz','frLeadAddr','frLeadPhone','frLeadExpiry'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  ['frLeadService','frLeadCompetitor'].forEach(function(id){var el=document.getElementById(id);if(el)el.selectedIndex=0;});
};

// ── VOICE LEAD ────────────────────────────────────────────────────────────────
window.frLeadStartVoice = function() {
  var btn = document.getElementById('frVoiceBtn');
  var status = document.getElementById('frVoiceStatus');
  var transcript = document.getElementById('frVoiceTranscript');
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    status.textContent = '⚠️ Use Chrome for voice recording';
    return;
  }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog = new SR();
  recog.continuous=true; recog.interimResults=true; recog.lang='en-US';
  var accum='';
  recog.onstart = function(){ btn.textContent='⏹ Stop'; btn.style.background='#DC2626'; btn.onclick=function(){recog.stop();}; status.textContent='🔴 Recording…'; transcript.style.display='block'; };
  recog.onresult = function(e){ var interim=''; for(var i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)accum+=e.results[i][0].transcript+' ';else interim=e.results[i][0].transcript;} transcript.textContent=accum+interim; };
  recog.onend = function(){
    btn.textContent='🎤 Start Recording'; btn.style.background=''; btn.onclick=frLeadStartVoice;
    status.textContent = accum ? '✅ Recording complete' : 'No speech detected';
    if(accum){document.getElementById('frVoiceProcess').style.display='block'; _voiceText=accum;}
  };
  recog.start();
};

window.frLeadProcessVoice = async function() {
  var text = _voiceText || document.getElementById('frVoiceTranscript').textContent;
  if (!text) return;
  var btn = document.getElementById('frVoiceProcess');
  btn.textContent='⚡ Parsing…'; btn.disabled=true;
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:300,
        messages:[{role:'user',content:'Parse this field voice note into a lead record. Extract business name, address, phone, service needs, competitor name if mentioned, and any inspection expiry dates. Return JSON only: {"business":"","address":"","phone":"","services":[],"competitor":"","notes":"","inspectionExpiry":""}\n\nVoice note: '+text}]})
    });
    var data = await resp.json();
    var parsed = JSON.parse(((data.content && data.content[0] && data.content[0].text)||'{}').replace(/```json|```/g,'').trim());
    var followUpDate = '';
    if (parsed.inspectionExpiry) {
      var next = new Date(parsed.inspectionExpiry);
      if (!isNaN(next)) followUpDate = new Date(next.getTime()-60*24*60*60*1000).toISOString().split('T')[0];
    }
    var lead = {
      id:'field_voice_'+Date.now(), source:'Field Voice — Tech Referral ('+_cfg.division+')',
      business:parsed.business||'Unknown', address:parsed.address||'', phone:parsed.phone||'',
      services:parsed.services||[], notes:(parsed.notes||'')+' Referred by '+getCurrentTechName()+'.',
      competitorTag:parsed.competitor||'', inspectionExpiry:parsed.inspectionExpiry||'', followUpDate,
      referredBy:getCurrentTechName(), sourceDivision:_cfg.division,
      lifecycleStage:'lead', score:7, createdAt:Date.now()
    };
    frLeadRoute(lead);
    btn.textContent='✅ Lead Sent!';
  } catch(e) {
    btn.textContent='⚡ Process Lead'; btn.disabled=false;
    alert('Could not process — check connection.');
  }
};

// ── LEAD ROUTING (the critical path) ─────────────────────────────────────────
function frLeadRoute(lead) {
  // ① Territory routing
  var addr = (lead.address||'').toUpperCase();
  var territory = 'PA';
  if (addr.includes(' NJ')||addr.includes(',NJ'))      territory='NJ';
  else if (addr.includes(' DE')||addr.includes(',DE')) territory='DE';
  else if (addr.includes(' MD')||addr.includes(',MD')) territory='MD';
  else if (addr.includes(' DC')||addr.includes(',DC')) territory='DC';
  var rep = LEAD_TERRITORY[territory] || LEAD_TERRITORY['PA'];
  lead.assignedRep      = rep.rep;
  lead.assignedRepEmail = rep.email;
  lead.territory        = territory;

  // ② Write to canonical CRM leads key
  var leads = frGet('termac_crm_leads', []);
  leads.unshift(lead);
  frSet('termac_crm_leads', leads);

  // ③ Write to intelligence notification feed
  var notifs = frGet('termac_hotlead_notifs', []);
  notifs.unshift({
    id:'n_'+Date.now(), ts:Date.now(), type:'field_referral', icon:'🎯', urgent:false,
    title:'Field Lead — '+lead.business, read:false,
    body:lead.source+' · Assigned to '+rep.rep+' ('+territory+' territory)'+(lead.followUpDate?' · Follow-up: '+lead.followUpDate:''),
    recipient:rep.rep,
    date:new Date().toLocaleDateString('en-US'),
    time:new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})
  });
  frSet('termac_hotlead_notifs', notifs.slice(0,100));

  // ④ Schedule 60-day follow-up drip (writes to Brevo queue)
  if (lead.followUpDate) {
    var drip = frGet('termac_drip_queue', []);
    drip.push({
      id:'drip_'+lead.id,
      leadId:lead.id,
      account:lead.business,
      repEmail:rep.email,
      scheduledDate:lead.followUpDate,
      type:'inspection_expiry_60day',
      status:'pending',
      subject:'Inspection Expiring Soon — '+lead.business,
      bodyPreview:'Following up on the '+lead.inspectionExpiry+' inspection expiry. UniPro can quote and schedule service now.',
      createdAt:Date.now(),
    });
    frSet('termac_drip_queue', drip);
  }

  // ⑤ Track in tech referral ledger (bonus tracking, commission only on conversion)
  var refLedger = frGet('termac_tech_referrals', {});
  var tname = getCurrentTechName();
  if (!refLedger[tname]) refLedger[tname] = {submitted:0, converted:0, bonusEarned:0, pendingBonus:0, history:[]};
  refLedger[tname].submitted = (refLedger[tname].submitted||0)+1;
  refLedger[tname].history.unshift({
    id:lead.id, business:lead.business, services:lead.services||[],
    submittedAt:Date.now(), source:lead.source||'Field Referral',
    competitorTag:lead.competitorTag||'', followUpDate:lead.followUpDate||'',
    status:'pending', bonus:0, division:_cfg.division,
  });
  refLedger[tname].history = refLedger[tname].history.slice(0,50);
  frSet('termac_tech_referrals', refLedger);

  // ⑥ Show confirmation in rail
  var conf = document.getElementById('frLeadConfirm');
  conf.style.display='block';
  conf.innerHTML =
    '<div class="fr-card green" style="margin-top:6px">'+
    '<div class="fr-title green">✅ Lead Routed!</div>'+
    '<div style="font-size:11px;color:#CBD5E1"><strong>'+escR(lead.business)+'</strong> → <strong>'+escR(rep.rep)+'</strong> ('+territory+' territory)</div>'+
    (lead.followUpDate ? '<div style="color:#34D399;font-size:9px;margin-top:3px">⏰ Follow-up: '+lead.followUpDate+'</div>' : '')+
    '<div style="color:#6EE7B7;font-size:9px;margin-top:2px">Commission paid on conversion only</div>'+
    '</div>';
  setTimeout(function(){conf.style.display='none';},6000);

  frRenderBonus(); // refresh bonus tracker
}

// ── RENDER FUNCTIONS ──────────────────────────────────────────────────────────
function frRenderNextJob() {
  var el = document.getElementById('frNextJob');
  if (!el) return;
  var jobs = getTodayJobs().filter(function(j){return j.status!=='complete'&&j.status!=='cancelled';});
  jobs.sort(function(a,b){return (a.time||'')>(b.time||'')?1:-1;});
  var next = jobs[0];
  if (!next) { el.innerHTML='<div class="fr-card" style="color:#34D399">✅ No more jobs today — great work!</div>'; return; }
  var accent = (_cfg && _cfg.accentColor) || '#C8102E';
  el.innerHTML = '<div class="fr-card">'+
    '<div class="fr-title gold">⏰ '+(next.time||'TBD')+' — '+(next.hrs||next.duration||'?')+'h</div>'+
    '<div style="font-weight:700;font-size:12px;color:#E2E8F0;margin-bottom:3px">'+escR(next.biz||next.account||next.accountName||'Account')+'</div>'+
    '<div style="font-size:10px;color:#94A3B8">'+escR(next.addr||next.address||'')+'<br>'+escR(next.service||next.serviceType||next.type||'')+'</div>'+
    (next.notes?'<div style="font-size:9px;color:#F59E0B;margin-top:4px">⚠️ '+escR(next.notes)+'</div>':'')+
    '<button class="fr-btn gold" style="margin-top:6px" onclick="frChatAsk(\'Give me a pre-job brief for '+escR(next.biz||next.account||next.accountName||'this account')+' — '+escR(next.service||next.serviceType||'service')+'\')">⚡ AI Pre-Job Brief</button>'+
    '</div>'+
    (jobs.length>1?'<div style="font-size:9px;color:#475569;text-align:center;margin-top:3px">+'+( jobs.length-1)+' more job'+(jobs.length>2?'s':'')+' today</div>':'');
}

function frRenderAlerts() {
  var el = document.getElementById('frAlerts');
  if (!el) return;
  var jobs = getTodayJobs();
  var alerts = [];
  var now = new Date();
  var curMin = now.getHours()*60+now.getMinutes();

  jobs.forEach(function(j) {
    if (j.urgent) alerts.push({type:'alert', msg:'🔴 URGENT: '+escR(j.biz||j.account||j.accountName)+' — priority attention needed'});
    var parts = (j.time||'00:00').split(':');
    var start = parseInt(parts[0]||0)*60+parseInt(parts[1]||0);
    var dur = (parseFloat(j.hrs||j.duration||1))*60;
    if (j.status!=='complete'&&curMin>start+dur+15) alerts.push({type:'tip',msg:'⏱️ Running late on '+escR(j.biz||j.account||j.accountName||'job')+'— consider calling ahead'});
  });

  // Check warehouse ready
  try {
    var whReady = JSON.parse(localStorage.getItem('termac_warehouse_ready')||'{}');
    Object.values(whReady).forEach(function(k){
      if (k.status==='ready'&&!k.techAcknowledged) alerts.push({type:'green',msg:'✅ WAREHOUSE KIT READY: '+escR(k.account)+'<br><span style="font-size:9px">'+escR((k.items||[]).join(', '))+'</span>'});
    });
  } catch(e) {}

  // Check open deficiencies from last visit
  try {
    var dq = JSON.parse(localStorage.getItem('termac_deficiency_queue')||'[]');
    var myOpen = dq.filter(function(d){return d.status==='fix_now'&&d.techName===getCurrentTechName();});
    if (myOpen.length) alerts.push({type:'alert',msg:'🔴 Lexi says FIX NOW: '+escR(myOpen[0].equipment)+' at '+escR(myOpen[0].account)});
  } catch(e) {}

  if (!alerts.length) { el.innerHTML='<div class="fr-card green">✅ All clear — no active alerts</div>'; return; }
  el.innerHTML = alerts.map(function(a){return '<div class="fr-card '+(a.type==='alert'?'alert':a.type==='tip'?'tip':a.type==='green'?'green':'')+'"><div style="font-size:10px">'+a.msg+'</div></div>';}).join('');
}

function frRenderUpsell() {
  var el = document.getElementById('frUpsell');
  if (!el) return;
  var div = _cfg.division;
  var dcfg = DIVISION_CONFIGS[div] || DIVISION_CONFIGS['UniPro'];
  var upsellMap = _cfg.upsellMap || dcfg.upsellMap || {};
  var jobs = getTodayJobs();
  var upsells = [];

  jobs.forEach(function(j) {
    var svc = j.service||j.serviceType||j.type||'';
    var key = Object.keys(upsellMap).find(function(k){return svc.toLowerCase().includes(k.toLowerCase());});
    if (key) upsellMap[key].forEach(function(u){upsells.push({biz:j.biz||j.account||j.accountName,upsell:u});});
  });

  // Cross-sell from CRM account data
  try {
    var accounts = frGet('termac_crm_accounts',[]);
    jobs.forEach(function(j){
      var acct = accounts.find(function(a){return a.name===(j.biz||j.account||j.accountName||'');});
      if (acct && acct.openDeficiencies && acct.openDeficiencies > 0) {
        upsells.push({biz:acct.name, upsell:'⚠️ '+acct.openDeficiencies+' open deficiencies — remediation quote opportunity'});
      }
    });
  } catch(e) {}

  if (!upsells.length) { el.innerHTML='<div class="fr-card" style="color:#475569;font-size:10px">Load today\'s jobs to see upsell opportunities.</div>'; return; }
  var shown = upsells.slice(0,4);
  el.innerHTML = shown.map(function(u){
    return '<div class="fr-card tip">'+
      '<div class="fr-title gold">💡 At '+escR(u.biz||'this account')+'</div>'+
      '<div style="font-size:10px;color:#CBD5E1">'+escR(u.upsell)+'</div>'+
      '<button class="fr-btn ghost" style="margin-top:4px;font-size:9px" onclick="frChatAsk(\'Give me a 2-sentence pitch for '+escR(u.upsell)+' while at '+escR(u.biz||'this account')+'\')">Get Pitch</button>'+
      '</div>';
  }).join('');
}

function frRenderPerf() {
  var el = document.getElementById('frPerf');
  if (!el) return;
  var tname = getCurrentTechName();
  var refs = frGet('termac_tech_referrals',{});
  var techRef = refs[tname]||{submitted:0,converted:0};
  var jobs = frGet(_cfg.jobsKey||'unipro_jobs',[]);
  var today = new Date().toISOString().split('T')[0];
  var myJobs = jobs.filter(function(j){return j.date===today&&(j.tech===tname||j.techName===tname);});
  var complete = myJobs.filter(function(j){return j.status==='complete';}).length;
  var total = myJobs.length;

  var metrics = [
    {lbl:'Jobs Today',   val:complete+'/'+total,    bar: total?Math.round(complete/total*100):0, color:'#22C55E'},
    {lbl:'Referrals (QTR)', val:techRef.submitted||0, bar:Math.min((techRef.submitted||0)*10,100), color:'#F59E0B'},
    {lbl:'Converted',    val:techRef.converted||0,   bar:techRef.submitted?Math.round((techRef.converted||0)/(techRef.submitted)*100):0, color:'#3B82F6'},
  ];

  el.innerHTML = metrics.map(function(m){
    var pct = typeof m.bar === 'number' ? Math.min(m.bar,100) : 0;
    return '<div style="margin-bottom:8px">'+
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:#94A3B8;margin-bottom:2px">'+
        '<span>'+m.lbl+'</span><span style="color:'+m.color+';font-weight:700">'+m.val+'</span>'+
      '</div>'+
      '<div class="fr-perf-bar"><div class="fr-perf-fill" style="width:'+pct+'%;background:'+m.color+'"></div></div>'+
    '</div>';
  }).join('');
}

function frRenderBonus() {
  var el = document.getElementById('frBonus');
  if (!el) return;
  var tname = getCurrentTechName();
  var refs = frGet('termac_tech_referrals',{});
  var techRef = refs[tname] || {submitted:0,converted:0,bonusEarned:0,history:[]};
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];

  el.innerHTML =
    '<div class="fr-card">'+
    '<div class="fr-title gold">📊 '+escR(tname)+'\'s Referrals</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:8px">'+
      '<div style="text-align:center;background:#0F172A;border-radius:6px;padding:6px 4px">'+
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:20px;color:#F59E0B">'+(techRef.submitted||0)+'</div>'+
        '<div style="font-size:8px;color:#64748B;text-transform:uppercase">Submitted</div></div>'+
      '<div style="text-align:center;background:#0F172A;border-radius:6px;padding:6px 4px">'+
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:20px;color:#22C55E">'+(techRef.converted||0)+'</div>'+
        '<div style="font-size:8px;color:#64748B;text-transform:uppercase">Converted</div></div>'+
      '<div style="text-align:center;background:#0F172A;border-radius:6px;padding:6px 4px">'+
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:20px;color:#34D399">$'+(techRef.bonusEarned||0)+'</div>'+
        '<div style="font-size:8px;color:#64748B;text-transform:uppercase">Earned</div></div>'+
    '</div>'+
    '<div style="font-size:9px;color:#475569;border-top:1px solid #334155;padding-top:6px">'+dcfg.bonusRate+'</div>'+
    ((techRef.history&&techRef.history.length)?
      '<div style="margin-top:8px">'+(techRef.history.slice(0,3).map(function(h){
        var color = h.status==='converted'?'#22C55E':h.status==='lost'?'#EF4444':'#F59E0B';
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1E293B;font-size:9px">'+
          '<div><div style="color:#E2E8F0;font-weight:600">'+escR(h.business)+'</div>'+
          (h.followUpDate?'<div style="color:#64748B">Follow-up: '+h.followUpDate+'</div>':'')+
          '</div><span style="color:'+color+';font-weight:700;font-family:\'Barlow Condensed\',sans-serif;font-size:10px;text-transform:uppercase">'+h.status+'</span></div>';
      }).join(''))+'</div>': '')+
    '</div>';
}

// ── QUICK TOOLS ───────────────────────────────────────────────────────────────
var TOOL_PROMPTS_BASE = {
  checklist: 'Give me a pre-job arrival checklist for a field service technician. Keep it to 8 bullet points.',
  late:      'Write me a professional, friendly 2-sentence message to send a customer when I\'m running 20 minutes late.',
  parts:     'What information do I need to submit a parts request for a field service job? List the key details.',
  debrief:   'Give me a structured job debrief template I can fill out quickly after completing a service call.',
};
var TOOL_PROMPTS_DIV = {
  'UniPro':      { nfpa:'Give me a quick reference for NFPA 10, 96, and 25 key inspection intervals I need to know as a fire protection tech.' },
  'GTO':         { nfpa:'What are the key FOG (fats, oils, grease) compliance regulations and pump-out frequency requirements I need to know as a grease trap service tech?' },
  'Filter Man':  { nfpa:'What does NFPA 96 say about hood filter exchange frequency? What are the key inspection intervals I need to know?' },
  'AllPro':      { nfpa:'What are the NSF/ANSI standards and NFPA 96 requirements I need to know for stainless fabrication and hood installation?' },
  'Termac':      { nfpa:'What are the NSF/ANSI 3 requirements for commercial warewashing? Temperature minimums, sanitizer PPM, and documentation requirements.' },
};

window.frTool = function(tool) {
  var div = _cfg.division;
  var divTools = TOOL_PROMPTS_DIV[div] || {};
  var prompt = divTools[tool] || TOOL_PROMPTS_BASE[tool];
  if (prompt) { frSetMode('chat'); frChatAsk(prompt); }
};

// ── INIT ──────────────────────────────────────────────────────────────────────
window.fieldRailInit = function(cfg) {
  _cfg = Object.assign({ division:'UniPro', jobsKey:'unipro_jobs', accentColor:'#C8102E' }, cfg||{});
  var dcfg = DIVISION_CONFIGS[_cfg.division] || DIVISION_CONFIGS['UniPro'];
  if (!_cfg.accentColor) _cfg.accentColor = dcfg.accent;

  injectCSS();

  // Find injection target
  var target = document.getElementById('frRailMount') || document.querySelector('.tp-layout') || document.querySelector('.tech-layout') || document.body.firstElementChild;
  if (!target) { console.warn('fieldRail: no mount point found'); return; }

  // Inject HTML
  var wrapper = document.createElement('div');
  wrapper.innerHTML = buildHTML();
  var rail = wrapper.firstElementChild;

  if (target.id === 'frRailMount') {
    target.parentNode.insertBefore(rail, target);
    target.remove();
  } else {
    target.insertBefore(rail, target.firstChild);
  }

  // Restore collapse state
  _railCollapsed = localStorage.getItem('fr_rail_collapsed') === '1';
  if (_railCollapsed) {
    var r = document.getElementById('frRail');
    var b = document.getElementById('frToggleBtn');
    if (r) r.classList.add('collapsed');
    if (b) b.textContent = '▶';
  }

  // Populate chips
  var chips = _cfg.chipPrompts || dcfg.chips || [];
  var chipsEl = document.getElementById('frChips');
  if (chipsEl) chipsEl.innerHTML = chips.map(function(c){
    return '<span class="fr-chip" onclick="frChatAsk(\''+escR(c)+'\')" title="'+escR(c)+'">'+escR(c.slice(0,20))+'</span>';
  }).join('');

  // Render all sections
  setTimeout(frRenderNextJob, 300);
  setTimeout(frRenderAlerts,  400);
  setTimeout(frRenderUpsell,  500);
  setTimeout(frRenderPerf,    600);
  setTimeout(frRenderBonus,   700);

  // Auto-refresh every 2 minutes
  setInterval(function(){
    frRenderNextJob(); frRenderAlerts(); frRenderUpsell(); frRenderPerf(); frRenderBonus();
  }, 120000);
};

})(window);
