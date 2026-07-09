
// ── TERMAC ONE: localStorage key migration ─────────────────────────────────
// Canonical keys: termac_crm_accounts, termac_crm_leads
// Run once per session to merge any data written under legacy key names.
(function termacKeyMigration() {
  try {
    var OLD_ACCOUNT_KEYS = ['crm_accounts', 'accounts'];
    var OLD_LEAD_KEYS    = ['leads', 'termac_leads', 'crm_leads', 'termac_crm_leads'];
    var CANONICAL_ACCTS  = 'termac_crm_accounts';
    var CANONICAL_LEADS  = 'termac_crm_leads';

    function mergeArrays(a, b, idField) {
      // b wins on conflict (newer write)
      var map = {};
      (a||[]).forEach(function(x){ if(x && x[idField]) map[x[idField]] = x; });
      (b||[]).forEach(function(x){ if(x && x[idField]) map[x[idField]] = x; });
      return Object.values(map);
    }

    // Accounts
    var canonical = JSON.parse(localStorage.getItem(CANONICAL_ACCTS) || '[]');
    OLD_ACCOUNT_KEYS.forEach(function(k) {
      var old = JSON.parse(localStorage.getItem(k) || '[]');
      if (old.length) {
        canonical = mergeArrays(canonical, old, 'id');
        localStorage.removeItem(k);
      }
    });
    if (canonical.length) localStorage.setItem(CANONICAL_ACCTS, JSON.stringify(canonical));

    // Leads
    var canonicalLeads = JSON.parse(localStorage.getItem(CANONICAL_LEADS) || '[]');
    OLD_LEAD_KEYS.forEach(function(k) {
      if (k === CANONICAL_LEADS) return;
      var old = JSON.parse(localStorage.getItem(k) || '[]');
      if (old.length) {
        canonicalLeads = mergeArrays(canonicalLeads, old, 'id');
        localStorage.removeItem(k);
      }
    });
    if (canonicalLeads.length) localStorage.setItem(CANONICAL_LEADS, JSON.stringify(canonicalLeads));

  } catch(e) { console.warn('Key migration error:', e); }
})();
// ── END KEY MIGRATION ───────────────────────────────────────────────────────

/* ═══════════════════════════════════════════════════════════════════════════
   TERMAC ONE — LIFECYCLE ENGINE v1.0
   termac-lifecycle.js

   Closes every gap in the lead → account → job → invoice → recurring lifecycle.

   SYSTEMS:
   1. Universal Lead Notification — every source, same chain, CC Jim + Tom
   2. Reception ZIP routing — auto-assigns rep on lead creation
   3. Warm Harvest Queue — harvesters → rep territory bucket (bypass DMS)
   4. wonLead() — signature triggers full account + job packet + notifications
   5. Appointment/Opportunity creation — one-click from lead card
   6. Deficiency → Lexi high-priority notification + quote workflow
   7. Auto-scheduling cadence — NFPA + division service intervals
   8. Warehouse bidirectional — pull confirmation back to tech
   9. Customer-facing confirmation — Brevo-wired appointment confirmation
═══════════════════════════════════════════════════════════════════════════ */

// ── SERVICE INTERVAL REGISTRY ─────────────────────────────────────────────
// Source of truth for all recurring service cadences.
// Used by: wonLead(), auto-scheduler, cert expiry drip triggers.
const SERVICE_INTERVALS = {
  // UniPro / Quality III — NFPA governed
  'nfpa10_annual':       { label:'NFPA 10 — Extinguisher Annual',          months: 12,  nfpa:'NFPA 10 §7.3'   },
  'nfpa10_6year':        { label:'NFPA 10 — 6-Year Maintenance',            months: 72,  nfpa:'NFPA 10 §7.5'   },
  'nfpa96_semiannual':   { label:'NFPA 96 — Hood Suppression Semi-Annual',  months: 6,   nfpa:'NFPA 96 §11'    },
  'nfpa96_annual':       { label:'NFPA 96 — Hood Suppression Annual',       months: 12,  nfpa:'NFPA 96 §11'    },
  'exitlights_annual':   { label:'Exit/Emergency Lights Annual',             months: 12,  nfpa:'NFPA 101 §7.9'  },
  'sprinkler_annual':    { label:'Sprinkler System Annual',                  months: 12,  nfpa:'NFPA 25'        },
  'sprinkler_5year':     { label:'Sprinkler System 5-Year',                  months: 60,  nfpa:'NFPA 25 §5.3'   },
  // GTO — site-survey defined frequency
  'gto_monthly':         { label:'Grease Trap — Monthly',                    months: 1,   nfpa:null             },
  'gto_bimonthly':       { label:'Grease Trap — Bi-Monthly (every 2mo)',    months: 2,   nfpa:null             },
  'gto_quarterly':       { label:'Grease Trap — Quarterly',                  months: 3,   nfpa:null             },
  'gto_semiannual':      { label:'Grease Trap — Semi-Annual',                months: 6,   nfpa:null             },
  // Filter Man — site-survey defined frequency
  'filterman_weekly':    { label:'Hood Filters — Weekly',                    weeks: 1,    nfpa:null             },
  'filterman_biweekly':  { label:'Hood Filters — Bi-Weekly (every 2wk)',    weeks: 2,    nfpa:null             },
  'filterman_4week':     { label:'Hood Filters — Every 4 Weeks',            weeks: 4,    nfpa:null             },
  'filterman_6week':     { label:'Hood Filters — Every 6 Weeks',            weeks: 6,    nfpa:null             },
  'filterman_monthly':   { label:'Hood Filters — Monthly',                   months: 1,   nfpa:null             },
  // Termac — dish machine
  'termac_monthly':      { label:'Dish Machine Service — Monthly',           months: 1,   nfpa:null             },
  'termac_quarterly':    { label:'Dish Machine Service — Quarterly',         months: 3,   nfpa:null             },
  // AllPro — project-based, no recurring
};

function lcIntervalNextDue(intervalKey, fromDate) {
  const def = SERVICE_INTERVALS[intervalKey];
  if (!def) return null;
  const base = fromDate ? new Date(fromDate) : new Date();
  if (def.weeks) {
    base.setDate(base.getDate() + def.weeks * 7);
  } else if (def.months) {
    base.setMonth(base.getMonth() + def.months);
  }
  return base.toISOString().split('T')[0];
}

// ── 0. STAFF DIRECTORY + ZIP-BASED TERRITORY ROUTING ──────────────────────
// This was the actual root cause of notifications silently never sending:
// NOTIF_STAFF was referenced below on every notification call but never
// defined ANYWHERE in the codebase, so every call to lcNotifyNewLead threw
// an uncaught ReferenceError before it ever got to building the email --
// nothing sent, no error visible unless you had devtools open. Built here
// from the real roster in termac-os.html's TERMAC_USERS so every division
// and every page that loads this file shares one source of truth.
const NOTIF_STAFF = {
  "Ted Scholl": {
    "email": "tscholl@termac.com"
  },
  "Sean O'Reilly": {
    "email": "sorielly@termac.com"
  },
  "Terence O'Reilly": {
    "email": "torielly@termac.com"
  },
  "Jim Kennedy": {
    "email": "jkennedy@termac.com"
  },
  "Dennis Muracco": {
    "email": "dmuracco@termac.com"
  },
  "Paul Brahan": {
    "email": "pbrahan@termac.com"
  },
  "Tom Pittakas": {
    "email": "tpittakas@termac.com"
  },
  "Aine Curran": {
    "email": "acurran@termac.com"
  },
  "Jasmine Paez": {
    "email": "jpaez@termac.com"
  },
  "Samuel Holmes": {
    "email": "sholmes@termac.com"
  },
  "Chrystal Bush": {
    "email": "cbush@termac.com"
  },
  "Tara Colona": {
    "email": "tcolona@termac.com"
  },
  "Amanda McGowan": {
    "email": "amcgowan@termac.com"
  },
  "Gina Kluge": {
    "email": "gkluge@termac.com"
  },
  "Kim Reinhart": {
    "email": "kreinhart@termac.com"
  },
  "Donna Meyer": {
    "email": "donna@termac.com"
  },
  "Lexi Cranfield": {
    "email": "lcranfield@termac.com"
  },
  "Demo User": {
    "email": "demo@termac.com"
  },
  "Receptionist": {
    "email": "receptionists@termac.com"
  },
  "UniPro Office": {
    "email": "unipro@termac.com"
  },
  "GTO Office": {
    "email": "gto@termac.com"
  },
  "Filter Man Office": {
    "email": "thefilterman@termac.com"
  },
  "ALLPro Office": {
    "email": "allpro@termac.com"
  },
  "Brad Fickes": {
    "email": "bfickes@termac.com"
  },
  "Chris Carzo": {
    "email": "ccarzo@termac.com"
  },
  "Dan Rini": {
    "email": "drini@termac.com"
  },
  "Joe McDonnell": {
    "email": "jmcdonnell@termac.com"
  },
  "Matt Belz": {
    "email": "mbelz@termac.com"
  },
  "Todd Grill": {
    "email": "tgrill@termac.com"
  },
  "Tom Jordan": {
    "email": "tjordan@termac.com"
  },
  "TJ O'Reilly": {
    "email": "tjoreilly@termac.com"
  }
};

// Fine-grained per-rep territory (exact 5-digit ZIPs), same data as
// TERMAC_USERS in termac-os.html.
const TERMAC_REP_TERRITORY = {"Tom Pittakas":["07823","07828","07830","07838","07840","07853","07863","07865","07880","07882","07921","07934","07979","08559","08801","08802","08804","08809","08822","08825","08826","08827","08829","08833","08848","08865","08867","08886","08889","18013","18015","18017","18020","18034","18040","18042","18045","18055","18063","18064","18072","18077","18081","18083","18085","18091","18343","18351","18914","18917","18920","18923","18927","18930","18932","18942","18944","18947","18951","18955","18960","18972"],"Brad Fickes":["07821","07825","07832","07843","07850","07851","07856","07857","07860","07874","12770","17026","17038","17048","17815","17820","17824","17832","17834","17840","17851","17866","17872","17878","17888","17901","17920","17921","17922","17923","17925","17929","17930","17931","17933","17934","17935","17936","17938","17941","17943","17945","17948","17949","17952","17953","17954","17957","17959","17960","17961","17963","17964","17965","17967","17968","17970","17972","17974","17976","17978","17979","17980","17981","17982","17983","17985","18014","18018","18030","18032","18035","18037","18038","18052","18053","18058","18059","18065","18066","18067","18069","18071","18078","18079","18080","18086","18088","18102","18103","18104","18109","18201","18202","18210","18211","18214","18216","18218","18219","18220","18221","18222","18224","18225","18229","18230","18231","18232","18234","18235","18237","18240","18241","18242","18244","18245","18246","18248","18249","18250","18252","18254","18255","18256","18301","18302","18320","18321","18322","18323","18324","18325","18326","18327","18328","18330","18331","18332","18333","18334","18336","18337","18340","18344","18346","18347","18349","18350","18353","18354","18355","18357","18360","18370","18371","18372","18403","18405","18407","18411","18413","18414","18415","18416","18417","18419","18420","18421","18424","18425","18426","18427","18428","18430","18431","18433","18434","18435","18436","18438","18439","18440","18441","18443","18444","18445","18446","18447","18451","18452","18453","18456","18458","18460","18463","18464","18466","18469","18470","18471","18472","18473","18503","18504","18505","18507","18508","18509","18510","18512","18515","18517","18518","18519","18602","18603","18610","18612","18615","18617","18618","18621","18622","18624","18631","18634","18635","18636","18640","18641","18642","18643","18644","18651","18654","18655","18656","18657","18660","18661","18701","18702","18704","18705","18706","18707","18708","18709","18711","18765","18824","18826","19529","19534","19549"],"Chris Carzo":["19003","19004","19008","19010","19013","19014","19015","19017","19018","19022","19023","19026","19029","19032","19033","19035","19036","19041","19043","19050","19060","19061","19063","19064","19066","19070","19072","19073","19074","19076","19078","19079","19081","19082","19083","19085","19086","19087","19094","19096","19113","19301","19311","19312","19317","19319","19333","19342","19348","19350","19352","19355","19363","19373","19374","19380","19382","19383","19390","19401","19403","19405","19406","19428","19444","19462","19701","19702","19703","19707","19709","19711","19713","19720","19731","19734","19801","19802","19803","19804","19805","19806","19807","19808","19809","19810","19884","19901","19902","19904","19930","19933","19934","19938","19939","19940","19941","19943","19944","19945","19946","19947","19950","19951","19952","19953","19954","19956","19958","19960","19961","19962","19963","19964","19966","19968","19970","19971","19973","19975","19977","19979"],"Dan Rini":["07001","07002","07003","07004","07005","07006","07008","07009","07010","07011","07012","07013","07014","07016","07017","07018","07020","07021","07022","07023","07024","07026","07027","07028","07029","07030","07031","07032","07033","07034","07035","07036","07039","07040","07041","07042","07043","07044","07045","07046","07047","07050","07052","07054","07055","07057","07058","07059","07060","07062","07063","07064","07065","07066","07067","07068","07069","07070","07071","07072","07073","07074","07075","07076","07077","07078","07079","07080","07081","07082","07083","07086","07087","07088","07090","07092","07093","07094","07095","07097","07099","07102","07103","07104","07105","07106","07107","07108","07109","07110","07111","07112","07114","07201","07202","07203","07204","07205","07206","07208","07302","07304","07305","07306","07307","07310","07311","07401","07403","07405","07407","07410","07416","07417","07418","07419","07420","07421","07422","07423","07424","07430","07432","07435","07436","07438","07439","07440","07442","07444","07446","07450","07452","07456","07457","07458","07460","07461","07462","07463","07465","07470","07480","07481","07495","07501","07502","07503","07504","07505","07506","07508","07512","07513","07514","07522","07524","07601","07603","07604","07605","07606","07607","07608","07620","07621","07624","07626","07627","07628","07630","07631","07632","07640","07641","07642","07643","07644","07645","07646","07647","07648","07649","07650","07652","07656","07657","07660","07661","07662","07663","07666","07670","07675","07676","07677","07701","07702","07703","07704","07711","07712","07716","07717","07718","07719","07720","07721","07722","07723","07724","07727","07730","07732","07733","07734","07735","07737","07738","07739","07740","07746","07747","07748","07750","07751","07753","07755","07756","07757","07758","07760","07762","07764","07801","07803","07822","07826","07827","07834","07836","07847","07848","07849","07852","07866","07869","07871","07876","07878","07885","07901","07920","07922","07924","07926","07927","07928","07930","07931","07932","07933","07935","07936","07940","07945","07946","07950","07960","07974","07976","07980","07981","08502","08720","08730","08736","08742","08750","08805","08807","08812","08816","08817","08820","08823","08824","08830","08832","08835","08836","08837","08840","08844","08846","08850","08853","08854","08857","08859","08861","08863","08869","08872","08873","08876","08879","08880","08882","08884","08887","08899","08901","08902","08904","10301","10302","10303","10304","10305","10306","10307","10308","10309","10310","10311","10312","10314","10901","10913","10925","10931","10952","10954","10962","10964","10965","10969","10974","10976","10977","10983","10987","10990","10994","10998","12771"],"Joe McDonnell":["07726","07728","07731","08001","08002","08003","08004","08005","08006","08007","08008","08009","08010","08012","08014","08015","08016","08019","08020","08021","08022","08023","08026","08027","08028","08029","08030","08031","08032","08033","08034","08035","08036","08037","08038","08039","08041","08043","08045","08046","08048","08049","08050","08051","08052","08053","08054","08055","08056","08057","08059","08060","08061","08062","08063","08065","08066","08067","08068","08069","08070","08071","08072","08075","08077","08078","08079","08080","08081","08083","08084","08085","08086","08087","08088","08089","08090","08091","08092","08093","08094","08096","08097","08098","08102","08103","08104","08105","08106","08107","08108","08109","08110","08201","08202","08203","08204","08205","08210","08212","08214","08215","08221","08223","08224","08225","08226","08230","08232","08234","08240","08241","08242","08243","08244","08245","08247","08251","08260","08270","08302","08310","08311","08312","08314","08315","08316","08317","08318","08319","08321","08322","08323","08324","08326","08327","08328","08329","08330","08332","08340","08341","08343","08344","08345","08346","08348","08349","08350","08352","08353","08360","08361","08401","08402","08403","08406","08501","08505","08510","08511","08512","08514","08515","08520","08525","08527","08528","08530","08533","08534","08535","08536","08540","08542","08550","08551","08553","08555","08558","08560","08561","08562","08609","08610","08611","08618","08619","08620","08628","08629","08638","08640","08641","08648","08690","08691","08701","08721","08722","08723","08724","08731","08732","08733","08734","08735","08738","08740","08741","08751","08752","08753","08755","08757","08758","08759","08810","08828","08831","08852"],"Matt Belz":["18901","18902","18925","18929","18933","18938","18940","18954","18966","18974","18976","18977","19001","19002","19006","19007","19009","19012","19020","19021","19025","19027","19030","19031","19034","19038","19040","19044","19046","19047","19053","19054","19055","19056","19057","19067","19075","19090","19095","19111","19114","19115","19116","19135","19136","19149","19152","19154","19422"],"Todd Grill":["17039","17042","17046","17067","17073","17087","17088","17501","17505","17507","17508","17509","17516","17517","17519","17520","17522","17527","17529","17532","17535","17536","17538","17540","17543","17545","17551","17555","17557","17560","17562","17565","17566","17569","17572","17576","17578","17579","17581","17584","17601","17602","17603","18011","18031","18036","18041","18046","18049","18051","18054","18056","18062","18070","18073","18074","18076","18087","18092","18106","18915","18936","18964","18969","19310","19316","19320","19330","19335","19341","19343","19344","19365","19372","19421","19425","19426","19435","19438","19440","19446","19453","19454","19460","19464","19465","19468","19473","19475","19492","19501","19503","19504","19505","19506","19507","19508","19510","19511","19512","19518","19519","19520","19522","19523","19525","19526","19530","19533","19535","19536","19539","19540","19541","19543","19544","19547","19550","19551","19555","19560","19562","19565","19567","19601","19602","19604","19605","19606","19607","19608","19609","19610","19611"],"Tom Jordan":["19106","19107","19112","19120","19122","19123","19124","19125","19133","19134","19137","19147","19148"],"TJ O'Reilly":["19102","19103","19104","19118","19119","19121","19127","19128","19129","19130","19131","19132","19138","19139","19142","19143","19144","19145","19146","19150","19151","19153"]};

// Coarse 3-digit-prefix fallback for ZIPs not in any rep's exact list.
const TERRITORY_REPS = {
  '189': 'Ted Scholl', '190': 'Ted Scholl', '191': 'Ted Scholl',
  '080': 'Ted Scholl', '081': 'Ted Scholl', '082': 'Ted Scholl',
  '083': 'Ted Scholl', '084': 'Ted Scholl', '085': 'Ted Scholl',
  '086': 'Ted Scholl', '087': 'Ted Scholl', '088': 'Ted Scholl',
};

function getRepForZip(zip) {
  if (!zip) return 'Unassigned';
  const z = String(zip).trim().substring(0,5);
  for (const [name, zips] of Object.entries(TERMAC_REP_TERRITORY)) {
    if (zips.includes(z)) return name;
  }
  return TERRITORY_REPS[z.substring(0,3)] || TERRITORY_REPS[z.substring(0,2)] || 'Unassigned';
}

// ── 1. UNIVERSAL LEAD NOTIFICATION ────────────────────────────────────────
// Every new lead fires this regardless of source.
// CC: Jim Kennedy + Tom Pittakas always.
function lcNotifyNewLead(lead, source) {
  if (!lead) return;
  const rep        = lead.assignedRep || lead.claimedBy || 'Unassigned';
  const repInfo    = NOTIF_STAFF[rep] || null;
  const now        = new Date();
  const dateStr    = now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const timeStr    = now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  const biz        = lead.business || lead.name || 'Unknown';
  const phone      = lead.phone || '—';
  const addr       = lead.address || lead.zip || '—';
  const services   = (lead.services||[]).join(', ') || lead.company || 'UniPro';
  const score      = lead.score || '—';
  // DMS call-sheet notes are saved under dmsNotes, not notes — the two
  // forms use different field names for what's conceptually the same
  // thing. Falling back through both means notes actually make it into
  // the email regardless of which portal the lead came from.
  const notes      = lead.notes || lead.dmsNotes || '';

  const subjectText = `🔥 HOT LEAD — ${biz} · ${source}`;
  const bodyLines = [
    rep !== 'Unassigned' ? `${rep},` : 'Team,',
    '',
    `A new hot lead has been assigned${rep !== 'Unassigned' ? ' to you' : ''} from ${source}. Details below.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'LEAD DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Business:     ${biz}`,
    `Phone:        ${phone}`,
    `Address:      ${addr}`,
    `Services:     ${services}`,
    `Lead Score:   ${score}/10`,
    `Source:       ${source}`,
    `Assigned To:  ${rep}`,
    `Date / Time:  ${dateStr} · ${timeStr}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'NOTES',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    notes || 'No notes recorded.',
    '',
    '⚡ Respond within 15 minutes for best close rate.',
    '',
    'View in Termac One: https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '— Termac One Lifecycle Engine',
  ];
  const bodyText = bodyLines.join('\n');

  // Build TO and CC lists
  const toEmail  = repInfo ? repInfo.email : 'tscholl@termac.com';
  const ccEmails = ['jkennedy@termac.com','tpittakas@termac.com','tscholl@termac.com']
    .filter(e => e !== toEmail).join(',');

  // Store in-app notification
  if (typeof _storeInAppNotif === 'function') {
    _storeInAppNotif({
      type:      'hot_lead',
      icon:      '🔥',
      urgent:    true,
      title:     `HOT LEAD — ${biz}`,
      body:      `${source} · ${phone} · ${services}`,
      recipient: rep,
      email:     toEmail,
    });
  }

  // Fire email (mailto now, Brevo at go-live)
  const subject = encodeURIComponent(subjectText);
  const body    = encodeURIComponent(bodyText);
  window.open(`mailto:${toEmail}?cc=${ccEmails}&subject=${subject}&body=${body}`, '_blank');

  // Show toast
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#C8102E;color:#fff;border-radius:10px;padding:14px 22px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:13px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,.35);text-align:center;max-width:380px';
  t.innerHTML = `🔥 HOT LEAD — ${biz}<br><span style="font-weight:500;font-size:11px">Notified: ${rep} + Jim Kennedy + Tom Pittakas</span>`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; }, 4000);
  setTimeout(()=> t.remove(), 4500);
}

// ── 2. RECEPTION ZIP ROUTING FIX ─────────────────────────────────────────
// Upgraded rcpLogAndCreateLead — auto-assigns by ZIP, fires universal notification.
function lcRcpCreateLead(call) {
  if (!call) return null;
  // Extract ZIP from phone area code heuristic or notes — best effort
  const zip  = (call.notes||'').match(/\b(\d{5})\b/)?.[1] || '';
  const rep  = zip && typeof getRepForZip === 'function' ? getRepForZip(zip) : 'Unassigned';
  const now  = Date.now();

  const lead = {
    id:          'lead_rcp_' + now,
    name:        call.name || 'Unknown',
    business:    call.company || call.name || '',
    phone:       call.phone || '',
    email:       '',
    address:     '',
    zip:         zip,
    company:     'UniPro',
    services:    [],
    status:      rep !== 'Unassigned' ? 'hot' : 'new',
    score:       7,
    source:      'Inbound Call',
    assignedRep: rep,
    claimedBy:   rep !== 'Unassigned' ? rep : '',
    created:     now,
    updated:     now,
    notes:       `Inbound call ${call.date} ${call.time}. Type: ${call.type}. ${call.notes||''}`,
    activityLog: [{
      ts: now, type:'call', icon:'📞',
      title: 'Inbound Call — Reception',
      note:  call.notes || '',
      who:   call.loggedBy || 'Reception',
    }],
  };

  // Save
  try {
    const leads = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
    leads.unshift(lead);
    localStorage.setItem('termac_crm_leads', JSON.stringify(leads));
  } catch(e) {}

  // Link call to lead
  try {
    const calls = JSON.parse(localStorage.getItem('termac_inbound_calls') || '[]');
    const c = calls.find(x => x.id === call.id);
    if (c) { c.createdLead = true; c.leadId = lead.id; c.assignedRep = rep; }
    localStorage.setItem('termac_inbound_calls', JSON.stringify(calls));
  } catch(e) {}

  // Universal notification
  lcNotifyNewLead(lead, 'Inbound Call');

  return lead;
}

// ── 3. WARM HARVEST → REP TERRITORY BUCKET ────────────────────────────────
// Harvested leads skip DMS and land directly in the rep's "Warm Harvest" queue.
// Called by each harvester after pulling leads.
function lcRouteHarvestedLeads(harvestedLeads, harvesterName) {
  if (!harvestedLeads || !harvestedLeads.length) return 0;
  const now   = Date.now();
  let routed  = 0;
  let notified = {};

  const existingLeads = (() => { try { return JSON.parse(localStorage.getItem('termac_crm_leads')||'[]'); } catch(e){ return []; } })();

  harvestedLeads.forEach(function(raw) {
    const zip = raw.zip || (raw.address||'').match(/\b(\d{5})\b/)?.[1] || '';
    const rep = zip && typeof getRepForZip === 'function' ? getRepForZip(zip) : 'Unassigned';

    // Dedup by phone or business name
    const isDupe = existingLeads.some(function(l) {
      return (raw.phone && l.phone === raw.phone) ||
             ((raw.business||raw.name||'').toLowerCase() === (l.business||l.name||'').toLowerCase() && zip && l.zip === zip);
    });
    if (isDupe) return;

    const lead = {
      id:          'lead_harv_' + now + '_' + Math.random().toString(36).slice(2,6),
      name:        raw.name || raw.business || 'Unknown',
      business:    raw.business || raw.name || '',
      phone:       raw.phone || '',
      email:       raw.email || '',
      address:     raw.address || '',
      zip:         zip,
      company:     raw.division || 'UniPro',
      services:    raw.services || [],
      status:      'warm',              // warm harvest — not yet contacted
      score:       typeof scoreLeadOnArrival === 'function' ? scoreLeadOnArrival(raw) : 6,
      source:      harvesterName || 'Harvest',
      assignedRep: rep,
      isWarmHarvest: true,              // flag for rep dashboard queue
      harvesterSource: harvesterName,
      created:     now,
      updated:     now,
      notes:       raw.notes || '',
      activityLog: [{
        ts: now, type:'harvest', icon:'🌾',
        title: `Harvested — ${harvesterName}`,
        note:  `Auto-routed to ${rep} by ZIP ${zip}`,
        who:   'Lifecycle Engine',
      }],
    };

    existingLeads.unshift(lead);
    routed++;

    // Batch notifications per rep (one email per rep, not per lead)
    if (rep !== 'Unassigned') {
      if (!notified[rep]) notified[rep] = [];
      notified[rep].push(lead);
    }
  });

  localStorage.setItem('termac_crm_leads', JSON.stringify(existingLeads));

  // Send one digest email per rep with all their new harvest leads
  Object.entries(notified).forEach(function([rep, repLeads]) {
    lcNotifyHarvestDigest(rep, repLeads, harvesterName);
  });

  return routed;
}

function lcNotifyHarvestDigest(rep, leads, source) {
  const repInfo = NOTIF_STAFF[rep] || null;
  if (!repInfo) return;
  const biz0    = leads[0]?.business || leads[0]?.name || '—';
  const count   = leads.length;
  const subjectText = `🌾 ${count} New Warm Harvest Lead${count>1?'s':''} — ${source}`;
  const bodyText = [
    `${rep},`,
    '',
    `${count} new lead${count>1?'s have':' has'} been added to your Warm Harvest queue from ${source}. These have been pre-routed to your territory — no DMS step needed.`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'YOUR NEW WARM HARVEST LEADS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...leads.slice(0,10).map(function(l,i){ return `${i+1}. ${l.business||l.name} · ${l.address||l.zip} · ${l.phone||'—'}`; }),
    leads.length > 10 ? `... and ${leads.length-10} more in your Lead Pool` : '',
    '',
    'These are addresses/contacts that need a rep visit or initial outreach — not a cold call. Review in your Sales Portal under Warm Harvest queue.',
    '',
    'View in Termac One: https://coachted-retro.github.io/unipro-sales/termac-os.html',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n');

  const toEmail  = repInfo.email;
  const ccEmails = 'jkennedy@termac.com,tpittakas@termac.com';
  window.open(`mailto:${toEmail}?cc=${ccEmails}&subject=${encodeURIComponent(subjectText)}&body=${encodeURIComponent(bodyText)}`, '_blank');
}

// ── 4. wonLead() — FULL LIFECYCLE TRIGGER ON SIGNATURE ────────────────────
// Called from estSigProceed() after customer signs estimate.
// Creates account, generates job packet, alerts scheduler/warehouse/tech.
// Maps an account's division name to the correct tech-portal jobs key.
// Must match DIV.jobsKey in tech-portal-unified.html exactly, or a job
// packet lands in the wrong division's queue and no tech ever sees it.
var LC_DIVISION_JOBS_KEY = {
  'UniPro':      'unipro_jobs',
  'GTO':         'gto_jobs',
  'Filter Man':  'filterman_jobs',
  'Termac':      'termac_jobs',
  'AllPro':      'allpro_jobs',
  'Quality III': 'quality3_jobs',
};
function lcJobsKeyForDivision(division) {
  return LC_DIVISION_JOBS_KEY[division] || 'unipro_jobs';
}

function lcWonLead(leadOrAccount, estimateData) {
  const now     = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];
  const biz     = leadOrAccount.business || leadOrAccount.name || 'New Account';
  const rep     = leadOrAccount.assignedRep || estimateData?.rep || 'Unassigned';

  // 4a. Promote lead to account (if record is a lead, not already an account)
  let account = leadOrAccount;
  if (!account.lifecycleStage || account.lifecycleStage === 'lead' || account.lifecycleStage === 'opportunity') {
    account = _lcBuildAccount(leadOrAccount, estimateData, now);
    // Save account
    try {
      const accounts = JSON.parse(localStorage.getItem('termac_crm_accounts') || '[]');
      // Remove from leads
      const leads = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
      const li = leads.findIndex(l => l.id === leadOrAccount.id);
      if (li >= 0) { leads[li].status = 'won'; leads[li].wonDate = dateStr; leads[li].accountId = account.id; }
      localStorage.setItem('termac_crm_leads', JSON.stringify(leads));
      accounts.unshift(account);
      localStorage.setItem('termac_crm_accounts', JSON.stringify(accounts));
    } catch(e) {}
  }

  // 4b. Build job packet
  const jobPacket = _lcBuildJobPacket(account, estimateData, now);
  try {
    const jk = lcJobsKeyForDivision(jobPacket.division);
    const jobs = JSON.parse(localStorage.getItem(jk) || '[]');
    jobs.unshift(jobPacket);
    localStorage.setItem(jk, JSON.stringify(jobs));
  } catch(e) {}

  // 4c. Scheduler alert
  _lcAlertScheduler(account, jobPacket);

  // 4d. Warehouse pull alert
  _lcAlertWarehouse(account, jobPacket, estimateData);

  // 4e. Tech pre-job brief (queued — tech sees on next portal load)
  _lcQueueTechBrief(account, jobPacket);

  // 4f. Customer confirmation email (Brevo wired — mailto fallback now)
  lcSendCustomerConfirmation(account, jobPacket);

  // 4g. Auto-schedule recurring services
  lcAutoScheduleRecurring(account);

  // 4h. Start cert expiration drip (Campaign 21 — 60-day notice)
  try {
    if (typeof DripEngine !== 'undefined') {
      new DripEngine().checkAndQueue(account);
    }
  } catch(e) {}

  // 4i. Notify management that a deal was won
  _lcNotifyWon(account, estimateData, rep);

  // 4j. Intelligence engine — onboarding loop
  if (typeof TermacIntelligence !== 'undefined') {
    TermacIntelligence.onJobComplete({
      jobId:        jobPacket.id,
      accountId:    account.id,
      accountName:  account.name,
      division:     (account.services||['UniPro'])[0],
      result:       'new_account',
      totalRevenue: estimateData?.total || 0,
      completedAt:  now,
    });
  }

  // 4k. Create the real invoice record — this is the actual AR source of
  // truth, tied to this account so any rep/receptionist/accounting staff
  // with account access can find and resend it. Per-visit customers get
  // auto-paid same day off the card on file; contract accounts get a due
  // date on their own billing cadence and genuinely need follow-up.
  if (typeof TermacInvoices !== 'undefined') {
    try { TermacInvoices.create(account, jobPacket, estimateData); } catch(e) {}
  }

  lcShowWonToast(biz, rep);
  return { account, jobPacket };
}

function _lcBuildAccount(lead, est, now) {
  return {
    id:             'acc_' + now,
    name:           lead.business || lead.name || 'New Account',
    business:       lead.business || lead.name || '',
    contact:        lead.contact || lead.name || '',
    phone:          lead.phone || '',
    email:          lead.email || '',
    address:        lead.address || '',
    zip:            lead.zip || '',
    city:           lead.city || '',
    status:         'active',
    lifecycleStage: 'active',
    services:       lead.services || (est?.divisions) || ['UniPro'],
    assignedRep:    lead.assignedRep || '',
    healthScore:    5,
    openDeficiencies: 0,
    annualValue:    est?.total ? est.total * (est.intervalMonths ? Math.round(12/est.intervalMonths) : 1) : 0,
    estimateAccepted: true,
    estimateDate:   new Date(now).toISOString().split('T')[0],
    sourceLeadId:   lead.id,
    source:         lead.source || 'Sales',
    created:        now,
    updated:        now,
    onboarding: {
      agreementSigned:  new Date(now).toISOString().split('T')[0],
      firstJobScheduled: null,
      firstServiceDone:  null,
      certIssued:        null,
      rep30dCheckin:     null,
    },
    serviceIntervals: lead.serviceIntervals || [],
    activityLog: [{
      ts: now, type:'won', icon:'🏆',
      title: 'Account Created — Estimate Accepted',
      note:  `Converted from lead ${lead.id}. Signed by ${lead.contact||lead.name}.`,
      who:   lead.assignedRep || 'Rep',
    }],
  };
}

function _lcBuildJobPacket(account, est, now) {
  const firstDiv = (account.services||['UniPro'])[0];
  return {
    id:          'job_' + now,
    accountId:   account.id,
    accountName: account.name,
    address:     account.address,
    zip:         account.zip,
    division:    firstDiv,
    serviceType: est?.lineItems?.map(function(li){return li.desc||li.name;}).join(', ') || 'Initial Service',
    status:      'pending_schedule',
    priority:    'high',
    date:        null,           // Scheduler assigns
    time:        null,
    techId:      null,           // Scheduler assigns
    revenue:     est?.total || 0,
    estimateRef: est?.id || null,
    notes:       `NEW ACCOUNT — First job. ${account.notes||''}`,
    created:     now,
    isFirstJob:  true,
  };
}

function _lcAlertScheduler(account, job) {
  // scheduler-v2.html's "New Account Inbox" reads termac_scheduler_queue,
  // not termac_scheduler_alerts -- this used to write to the wrong key
  // entirely, so a signed estimate's first job never actually reached the
  // scheduler's screen even though the code "fired" without error.
  try {
    const queue = JSON.parse(localStorage.getItem('termac_scheduler_queue') || '[]');
    queue.unshift({
      id:            account.id,
      business:      account.name,
      name:          account.name,
      address:       account.address,
      phone:         account.phone,
      contact:       account.contact,
      services:      account.services,
      rep:           account.assignedRep || '',
      billingCadence:account.billingCadence || 'per_visit',
      accountNumber: account.accountNumber || '',
      acceptedAt:    Date.now(),
      status:        'needs_scheduling',
      firstServiceScheduled: false,
      jobId:         job.id,
    });
    localStorage.setItem('termac_scheduler_queue', JSON.stringify(queue));
  } catch(e) {}

  // Also keep the urgent-alerts feed for anything else that watches it
  try {
    const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
    alerts.unshift({
      id:      'sched_' + Date.now(),
      ts:      Date.now(),
      type:    'new_account_first_job',
      urgent:  true,
      account: account.name,
      address: account.address,
      zip:     account.zip,
      services: account.services,
      jobId:   job.id,
      note:    'New account — schedule first service ASAP. Rep: ' + (account.assignedRep||'—'),
    });
    localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
  } catch(e) {}

  // Email schedulers
  const subj = encodeURIComponent('📅 Schedule Needed — New Account: ' + account.name);
  const body = encodeURIComponent([
    'Aine, Jasmine, Samuel —',
    '',
    'A new account has been signed and needs its first job scheduled immediately.',
    '',
    'Account: ' + account.name,
    'Address: ' + account.address,
    'Services: ' + (account.services||[]).join(', '),
    'Rep: ' + (account.assignedRep||'—'),
    '',
    'Please schedule and confirm with the customer within 24 hours.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n'));
  window.open('mailto:acurran@termac.com,jpaez@termac.com,sholmes@termac.com?subject=' + subj + '&body=' + body, '_blank');
}

function _lcAlertWarehouse(account, job, est) {
  const items = est?.lineItems || [];
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    wa.unshift({
      id:        'wh_' + Date.now(),
      ts:        Date.now(),
      type:      'new_job_pull',
      status:    'pending',         // warehouse sets to 'pulled' or 'ready'
      confirmed: false,
      account:   account.name,
      jobId:     job.id,
      division:  job.division,
      items:     items.map(function(li){ return { name:li.desc||li.name, qty:li.qty||1, unit:li.unit||'ea' }; }),
      note:      'First job for new account — pull and stage before tech dispatch.',
    });
    localStorage.setItem('warehouse_alerts', JSON.stringify(wa));
  } catch(e) {}
}

function _lcQueueTechBrief(account, job) {
  try {
    const briefs = JSON.parse(localStorage.getItem('termac_tech_briefs') || '[]');
    briefs.unshift({
      id:       'brief_' + Date.now(),
      jobId:    job.id,
      division: job.division,
      account:  account.name,
      address:  account.address,
      zip:      account.zip,
      phone:    account.phone,
      contact:  account.contact,
      services: account.services,
      notes:    'NEW ACCOUNT — First visit. Introduce yourself, confirm scope, walk the property.',
      isFirst:  true,
      read:     false,
      ts:       Date.now(),
    });
    localStorage.setItem('termac_tech_briefs', JSON.stringify(briefs));
  } catch(e) {}
}

function _lcNotifyWon(account, est, rep) {
  const subj = encodeURIComponent('🏆 Deal Won — ' + account.name + ' · $' + (est?.total||0));
  const body = encodeURIComponent([
    'Jim, Tom, Ted —',
    '',
    'A new account was just signed.',
    '',
    'Account: ' + account.name,
    'Address: ' + account.address,
    'Services: ' + (account.services||[]).join(', '),
    'Estimate Total: $' + (est?.total||'—'),
    'Rep: ' + rep,
    'Signed: ' + new Date().toLocaleDateString('en-US'),
    '',
    'First job packet has been sent to scheduling and warehouse.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n'));
  window.open('mailto:jkennedy@termac.com,tpittakas@termac.com,tscholl@termac.com?subject=' + subj + '&body=' + body, '_blank');
}

function lcShowWonToast(biz, rep) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1E7B3C,#065F46);color:#fff;border-radius:12px;padding:18px 28px;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:15px;z-index:9999;box-shadow:0 6px 32px rgba(0,0,0,.35);text-align:center;max-width:420px';
  t.innerHTML = `🏆 DEAL WON — ${biz}<br><span style="font-weight:500;font-size:12px">Account created · Scheduler + Warehouse notified · Customer confirmation sent</span>`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .5s'; t.style.opacity='0'; }, 5000);
  setTimeout(()=> t.remove(), 5500);
}

// ── 5. APPOINTMENT / OPPORTUNITY CREATION ────────────────────────────────
function lcSetAppointment(leadId) {
  const leads   = JSON.parse(localStorage.getItem('termac_crm_leads') || '[]');
  const lead    = leads.find(function(l){ return l.id === leadId; });
  if (!lead) return;

  const dateStr = prompt('Appointment date (YYYY-MM-DD):');
  if (!dateStr) return;
  const timeStr = prompt('Appointment time (e.g. 10:00 AM):') || '';
  const notes   = prompt('Notes for the visit (optional):') || '';

  lead.status            = 'opportunity';
  lead.lifecycleStage    = 'opportunity';
  lead.appointmentDate   = dateStr;
  lead.appointmentTime   = timeStr;
  lead.updated           = Date.now();
  lead.activityLog = lead.activityLog || [];
  lead.activityLog.unshift({
    ts: Date.now(), type:'appointment', icon:'📅',
    title: 'Appointment Set — ' + dateStr + (timeStr?' @ '+timeStr:''),
    note:  notes || 'Site visit / assessment scheduled.',
    who:   (window._currentUser && window._currentUser.name) || 'Rep',
  });

  localStorage.setItem('termac_crm_leads', JSON.stringify(leads));

  // Alert scheduler with pending slot
  try {
    const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
    alerts.unshift({
      id:      'appt_' + Date.now(),
      ts:      Date.now(),
      type:    'appointment_pending',
      account: lead.business || lead.name,
      address: lead.address,
      date:    dateStr,
      time:    timeStr,
      rep:     lead.assignedRep,
      leadId:  leadId,
      note:    notes,
    });
    localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
  } catch(e) {}

  // Notify DMS to stop calling
  try {
    const dms = JSON.parse(localStorage.getItem('dms_coldcall') || '[]');
    const dr  = dms.find(function(r){ return (r.business||r.name||'').toLowerCase() === (lead.business||lead.name||'').toLowerCase(); });
    if (dr) { dr.dmsOutcome = 'appointment_set'; dr.appointmentDate = dateStr; }
    localStorage.setItem('dms_coldcall', JSON.stringify(dms));
  } catch(e) {}

  alert('Appointment set for ' + dateStr + '. Scheduler notified, DMS updated.');
  if (typeof renderCRMView === 'function') renderCRMView();
}

// ── 6. DEFICIENCY → LEXI HIGH-PRIORITY NOTIFICATION ──────────────────────
function lcFlagDeficiency(defData) {
  // defData: { accountId, accountName, address, description, severity, techId, jobId, canFixNow, partsNeeded }
  if (!defData) return;
  const now     = Date.now();
  const isUrgent = defData.severity === 'high' || defData.severity === 'critical';

  // Store deficiency record
  try {
    const defs = JSON.parse(localStorage.getItem('termac_deficiencies') || '[]');
    defs.unshift({
      id:           'def_' + now,
      ts:           now,
      date:         new Date(now).toISOString().split('T')[0],
      accountId:    defData.accountId,
      accountName:  defData.accountName,
      address:      defData.address,
      description:  defData.description,
      severity:     defData.severity || 'normal',
      techId:       defData.techId,
      jobId:        defData.jobId,
      canFixNow:    defData.canFixNow || false,
      partsNeeded:  defData.partsNeeded || '',
      status:       'open',
      quoteId:      null,
      quoteBuilt:   false,
      resolved:     false,
    });
    localStorage.setItem('termac_deficiencies', JSON.stringify(defs));
  } catch(e) {}

  // Update account openDeficiencies count
  try {
    const accounts = JSON.parse(localStorage.getItem('termac_crm_accounts') || '[]');
    const acct = accounts.find(function(a){ return a.id === defData.accountId; });
    if (acct) {
      acct.openDeficiencies = (acct.openDeficiencies || 0) + 1;
      acct.activityLog = acct.activityLog || [];
      acct.activityLog.unshift({
        ts: now, type:'deficiency', icon:'⚠️',
        title: 'Deficiency Flagged — ' + (defData.severity||'normal').toUpperCase(),
        note:  defData.description + (defData.partsNeeded ? ' | Parts: ' + defData.partsNeeded : ''),
        who:   defData.techId || 'Tech',
      });
      localStorage.setItem('termac_crm_accounts', JSON.stringify(accounts));
    }
  } catch(e) {}

  // High-priority notification to Lexi
  const urgLabel = isUrgent ? '🚨 URGENT DEFICIENCY' : '⚠️ Deficiency';
  const subj     = encodeURIComponent(urgLabel + ' — ' + defData.accountName + ' · Quote Needed');
  const bodyText = [
    'Lexi,',
    '',
    (isUrgent ? 'URGENT: ' : '') + 'A deficiency has been flagged during a field inspection and requires a quote.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'DEFICIENCY DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Account:      ' + defData.accountName,
    'Address:      ' + (defData.address||'—'),
    'Severity:     ' + (defData.severity||'Normal').toUpperCase(),
    'Description:  ' + defData.description,
    'Can Fix Now:  ' + (defData.canFixNow ? 'YES — Tech is on site' : 'NO — Return visit needed'),
    'Parts Needed: ' + (defData.partsNeeded || 'None specified'),
    'Tech:         ' + (defData.techId || '—'),
    'Job Ref:      ' + (defData.jobId || '—'),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'ACTION REQUIRED',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    defData.canFixNow
      ? 'Tech is ON SITE and can fix now if parts are available. Contact the tech immediately to confirm and approve.'
      : 'Build a quote for repair and send to the customer. Schedule a return visit.',
    isUrgent ? 'FIRE SAFETY DEFICIENCY — Every hour of delay is a liability. Quote within 2 hours.' : 'Please build and send quote within 48 hours.',
    '',
    '— Termac One Lifecycle Engine',
  ].join('\n');

  // Email Lexi + CC Jim + Tom for urgent
  const toLexiPlusCC = isUrgent
    ? 'lcranfield@termac.com?cc=jkennedy@termac.com,tpittakas@termac.com,tscholl@termac.com'
    : 'lcranfield@termac.com?cc=tscholl@termac.com';

  window.open('mailto:' + toLexiPlusCC + '&subject=' + subj + '&body=' + encodeURIComponent(bodyText), '_blank');

  // In-app notification
  if (typeof _storeInAppNotif === 'function') {
    _storeInAppNotif({
      type:      isUrgent ? 'urgent_response' : 'deficiency',
      icon:      isUrgent ? '🚨' : '⚠️',
      urgent:    isUrgent,
      title:     urgLabel + ' — ' + defData.accountName,
      body:      defData.description + (defData.canFixNow ? ' · Tech on site — can fix now' : ' · Return visit needed'),
      recipient: 'Lexi Cranfield',
      email:     'lcranfield@termac.com',
    });
  }
}

// ── 7. AUTO-SCHEDULING CADENCE ────────────────────────────────────────────
// Generates the recurring job schedule for an account based on its service intervals.
function lcAutoScheduleRecurring(account) {
  // SCHEDULING POLICY: This function does NOT auto-create jobs.
  // Each Termac service line is independently scheduled by Aine, Jasmine,
  // or Samuel who assign the right tech, check for route conflicts, and
  // manage customer-specific preferences manually. Auto-scheduling creates
  // overlap, miscommunication, and tech assignment errors.
  //
  // Instead this function creates a SCHEDULING PROMPT in the Service
  // Scheduling Queue — a structured card with everything the scheduler
  // needs to make the decision themselves. The human schedules; the
  // system does the legwork of knowing it's due and gathering context.
  if (!account || !account.serviceIntervals || !account.serviceIntervals.length) return;
  const now = Date.now();

  let added = 0;
  account.serviceIntervals.forEach(function(intervalKey) {
    const def = SERVICE_INTERVALS[intervalKey];
    if (!def) return;

    const nextDate = lcIntervalNextDue(intervalKey, account.lastService || new Date());
    const daysUntilDue = nextDate ? Math.ceil((new Date(nextDate) - now) / 86400000) : null;

    // Only create a prompt if due within 45 days or already overdue
    if (daysUntilDue !== null && daysUntilDue > 45) return;

    // Check if a scheduling prompt already exists for this account+service
    try {
      var queue = JSON.parse(localStorage.getItem('termac_scheduler_queue') || '[]');
      var exists = queue.some(function(q) {
        return q.accountId === account.id && q.intervalKey === intervalKey && q.status === 'needs_scheduling';
      });
      if (exists) return;

      // Create the scheduling prompt — everything the scheduler needs to book it
      queue.unshift({
        id:             'prompt_' + account.id + '_' + intervalKey + '_' + now,
        type:           'scheduling_prompt',
        accountId:      account.id,
        business:       account.name || account.business,
        address:        account.address,
        city:           account.city,
        state:          account.state,
        zip:            account.zip,
        phone:          account.phone,
        contact:        account.contact,
        division:       _lcDivisionFromInterval(intervalKey),
        intervalKey:    intervalKey,
        serviceType:    def.label,
        nfpaCode:       def.nfpa || null,
        lastService:    account.lastService || null,
        nextDueDate:    nextDate,
        daysUntilDue:   daysUntilDue,
        urgency:        daysUntilDue !== null && daysUntilDue <= 0 ? 'overdue' : daysUntilDue <= 14 ? 'urgent' : 'due_soon',
        assignedRep:    account.assignedRep || null,
        techRequired:   def.techSkill || null,
        status:         'needs_scheduling',
        createdAt:      now,
        note:           (daysUntilDue !== null && daysUntilDue <= 0
          ? 'OVERDUE — ' + Math.abs(daysUntilDue) + ' days past due date'
          : 'Due in ' + daysUntilDue + ' days — ' + def.label + (def.nfpa ? ' (' + def.nfpa + ')' : ''))
      });
      localStorage.setItem('termac_scheduler_queue', JSON.stringify(queue));
      added++;
    } catch(e) {}
  });

  // Alert scheduler of new recurring jobs
  if (added > 0) {
    try {
      const alerts = JSON.parse(localStorage.getItem('termac_scheduler_alerts') || '[]');
      alerts.unshift({
        id:      'recur_' + now,
        ts:      now,
        type:    'recurring_jobs_added',
        account: account.name,
        count:   added,
        note:    added + ' recurring jobs auto-scheduled for ' + account.name + '. Assign techs in scheduler.',
      });
      localStorage.setItem('termac_scheduler_alerts', JSON.stringify(alerts));
    } catch(e) {}
  }
}

function _lcDivisionFromInterval(key) {
  if (key.startsWith('gto'))        return 'GTO';
  if (key.startsWith('filterman'))  return 'Filter Man';
  if (key.startsWith('termac'))     return 'Termac';
  if (key.startsWith('allpro'))     return 'AllPro';
  return 'UniPro';
}

// ── 8. WAREHOUSE BIDIRECTIONAL CONFIRMATION ────────────────────────────────
// Warehouse portal calls lcWarehouseConfirmPull() when items are staged.
// Tech portal polls lcGetWarehouseStatus() before departing.
function lcWarehouseConfirmPull(alertId, warehouseStaffName, notes) {
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    const alert = wa.find(function(a){ return a.id === alertId; });
    if (!alert) return false;
    alert.status    = 'ready';
    alert.confirmed = true;
    alert.confirmedBy   = warehouseStaffName || 'Warehouse';
    alert.confirmedAt   = Date.now();
    alert.warehouseNotes = notes || '';
    localStorage.setItem('warehouse_alerts', JSON.stringify(wa));

    // Queue a notification for the tech
    try {
      const briefs = JSON.parse(localStorage.getItem('termac_tech_briefs') || '[]');
      const brief  = briefs.find(function(b){ return b.jobId === alert.jobId; });
      if (brief) {
        brief.warehouseReady  = true;
        brief.warehouseNotes  = notes || 'Items pulled and staged.';
        brief.warehouseReadyAt = Date.now();
        localStorage.setItem('termac_tech_briefs', JSON.stringify(briefs));
      }
    } catch(e) {}

    return true;
  } catch(e) { return false; }
}

function lcGetWarehouseStatus(jobId) {
  try {
    const wa = JSON.parse(localStorage.getItem('warehouse_alerts') || '[]');
    const alert = wa.find(function(a){ return a.jobId === jobId; });
    if (!alert) return { status:'no_pull_request', confirmed:false };
    return {
      status:     alert.status || 'pending',
      confirmed:  alert.confirmed || false,
      items:      alert.items || [],
      confirmedBy: alert.confirmedBy || null,
      notes:      alert.warehouseNotes || null,
    };
  } catch(e) { return { status:'error', confirmed:false }; }
}

// ── 9. CUSTOMER-FACING CONFIRMATION EMAIL ─────────────────────────────────
// Brevo-wired. mailto fallback now. Auto-fires on account creation + job schedule.
function lcSendCustomerConfirmation(account, job) {
  if (!account.email) return; // no email on file — skip

  const dateStr = job.date
    ? new Date(job.date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})
    : 'as soon as we schedule — our team will call you within 24 hours';
  const timeStr = job.time ? ' at ' + job.time : '';
  const tech    = 'Our certified technician'; // real tech name added when scheduled

  const subj = encodeURIComponent('Your Appointment is Confirmed — ' + (account.services||['UniPro']).join(', '));
  const bodyText = [
    'Dear ' + (account.contact || account.name) + ',',
    '',
    'Thank you for choosing Universal Fire Protection / Termac Family of Companies.',
    'Your service appointment has been confirmed. Here are your details:',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'APPOINTMENT DETAILS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Account:   ' + account.name,
    'Address:   ' + account.address,
    'Services:  ' + (account.services||[]).join(', '),
    'Date:      ' + dateStr + timeStr,
    'Tech:      ' + tech,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'WHAT TO EXPECT',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '• Our technician will arrive in a marked Termac vehicle',
    '• Please ensure access to all areas to be inspected',
    '• The inspection typically takes 45-90 minutes depending on scope',
    '• You will receive a detailed service report and certificate upon completion',
    '',
    'Questions? Contact your service rep:',
    'Ted Scholl · tscholl@termac.com · 267-421-6336',
    '',
    'Thank you for your business.',
    '',
    'Universal Fire Protection / Termac Family of Companies',
    'https://coachted-retro.github.io/unipro-sales',
  ].join('\n');

  // TODO at Brevo go-live: replace window.open with Brevo transactional email API call
  // using BREVO_API_KEY and template ID for customer confirmations.
  window.open('mailto:' + encodeURIComponent(account.email) + '?subject=' + subj + '&body=' + encodeURIComponent(bodyText), '_blank');
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
window.TermacLifecycle = {
  notifyNewLead:            lcNotifyNewLead,
  rcpCreateLead:            lcRcpCreateLead,
  routeHarvestedLeads:      lcRouteHarvestedLeads,
  wonLead:                  lcWonLead,
  setAppointment:           lcSetAppointment,
  flagDeficiency:           lcFlagDeficiency,
  autoScheduleRecurring:    lcAutoScheduleRecurring,
  warehouseConfirmPull:     lcWarehouseConfirmPull,
  getWarehouseStatus:       lcGetWarehouseStatus,
  sendCustomerConfirmation: lcSendCustomerConfirmation,
  SERVICE_INTERVALS,
};

console.log('[Termac Lifecycle Engine v1.0] Loaded — 9 lifecycle loops ready');
