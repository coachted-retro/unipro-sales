/* ══════════════════════════════════════════════════════════════════════════
   TERMAC ONE -- APPOINTMENT CARD
   THE appointment card. Not one of several. This file is the only place an
   appointment modal is defined anywhere in the platform.

   2026-07-28: there were two. sales-portal.html had a D1-backed modal;
   termac-os.html had its own static form saving through crmLoad into
   localStorage. Every fix to one left the other untouched, which is why the
   same corrections kept coming back. Both are now this file.

   Any portal that books an appointment loads this script and calls
   termacOpenAppointment(). Nobody writes a second one. If this card needs to
   change, it changes here, once, and every portal gets it.

   Uses d1Query from termac-d1-sync.js when present, otherwise talks to the
   proxy directly so portals that do not load d1-sync still work.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PROXY = 'https://unipro-ai-proxy.termac-one.workers.dev/db';
  function apptQuery(sql, params) {
    if (typeof global.d1Query === 'function') return global.d1Query(sql, params || []);
    return fetch(PROXY, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sql: sql, params: params || [] }) }).then(function(r){ return r.json(); });
  }

var SP_APPT_SLOTS = ['06:30','07:00','07:30','08:00','08:30','09:00','09:30','10:00',
                     '10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00',
                     '14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00'];

function spOpenApptModal(id, tab, mode, presetDate, keepNotes) {
  _spApptId = id;
  _spApptTab = tab;
  _spApptMode = mode || 'appointment';
  _spApptPresetDate = presetDate || _spApptPresetDate || null;
  _spApptGuestChips = [];

  const data = crmLoad('leads');
  const r = data.find(x => x.id === id) || {};
  const addr = r.address || r.addr || '';

  // If opened from a specific record's page, that record starts pre-linked.
  if (id && !_spApptLinkedId) {
    _spApptLinkedId = id; _spApptLinkedTab = tab || 'leads'; _spApptLinkedName = r.business || r.name || r.contact || '';
  }

  const cfg = SP_ENTRY_TYPES[_spApptMode] || SP_ENTRY_TYPES.appointment;
  if (cfg.linkMode === 'none') { _spApptLinkedId = null; _spApptLinkedTab = null; _spApptLinkedName = ''; }
  const defaultDate = _spApptPresetDate || new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const typeDropdown = '<select onchange="spApptTypeChanged(this.value)" style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:9px 10px;font-size:13px;font-weight:700;background:#fff">' +
    Object.keys(SP_ENTRY_TYPES).map(function(k) {
      return '<option value="' + k + '" ' + (k === _spApptMode ? 'selected' : '') + '>' + SP_ENTRY_TYPES[k].label + '</option>';
    }).join('') + '</select>';

  let linkFieldHtml = '';
  if (cfg.linkMode !== 'none') {
    linkFieldHtml = '<div>' +
      '<label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Business Name (optional)' + '</label>' +
      '<div data-role="link-field">' +
      (_spApptLinkedId
        ? '<div style="display:flex;align-items:center;justify-content:space-between;background:#F1F5F9;border-radius:7px;padding:8px 10px;font-size:13px"><span>&#128279; ' + escH(_spApptLinkedName) + '</span><button type="button" onclick="spApptClearLink()" style="background:none;border:none;color:#C8102E;font-size:12px;cursor:pointer;font-weight:700">Change</button></div>'
        : '<div style="position:relative">' +
            '<input type="text" id="spApptLinkSearch" oninput="spApptSearchRecords(this.value)" onblur="setTimeout(function(){var b=document.getElementById(\'spApptLinkResults\');if(b)b.style.display=\'none\';},150)" placeholder="Type the business name..." style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px">' +
            '<div id="spApptLinkResults" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1.5px solid #D7DBE0;border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.12);z-index:10;max-height:200px;overflow-y:auto"></div>' +
          '</div>') +
      '</div>' +
    '</div>';
  }

  let dateTimeHtml;
  if (cfg.hasTimeRange) {
    dateTimeHtml = '<div style="display:grid;grid-template-columns:1fr;gap:10px">' +
      '<div><label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Date *</label><input type="date" id="spApptDate" value="' + defaultDate + '" style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px"></div>' +
      '</div>' +
      spApptTimeGridHtml('09:00','spApptTime','Leave By') +
      spApptTimeGridHtml('10:00','spApptTimeEnd','Arrive By') +
      '<div style="display:none">' +
    '</div>';
  } else {
    dateTimeHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<div><label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Date *</label><input type="date" id="spApptDate" value="' + defaultDate + '" style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px"></div>' +
      spApptTimeGridHtml('09:00') +
    '</div>';
  }

  let allDayRecurHtml = '';
  if (cfg.hasAllDay || cfg.hasRecurring) {
    allDayRecurHtml = '<div style="display:flex;gap:16px;align-items:center">' +
      (cfg.hasAllDay ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer"><input type="checkbox" id="spApptAllDay" onchange="spApptToggleAllDay(this.checked)"> All-day</label>' : '') +
      (cfg.hasRecurring ? '<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer"><input type="checkbox" id="spApptRecurring" onchange="document.getElementById(\'spApptRecurFreq\').style.display=this.checked?\'block\':\'none\'"> Repeats</label>' : '') +
    '</div>' +
    (cfg.hasRecurring ? '<select id="spApptRecurFreq" style="display:none;width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>' : '');
  }

  const locationHtml = cfg.hasLocation
    ? '<div><label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Location</label><input type="text" id="spApptLocation" value="' + addr.replace(/"/g,'&quot;') + '" style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px" placeholder="Business address"></div>'
    : '';

  // 2026-07-28: rep invite chips and the free-text guest field removed from the
  // appointment modal. An appointment carries date, time, location and contact.
  // Inviting other reps was never wanted here.
  const guestsHtml = '';

  const brevoNote = _spApptMode === 'appointment'
    ? '<div style="background:#EBF2FD;border-radius:8px;padding:9px 12px;font-size:11px;color:#1B5FA8">📧 Customer confirmation fires via Brevo when wired. Promotes Lead/Contact to Opportunity.</div>'
    : '';

  const modalHTML = '<div id="spApptModal" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9700;display:flex;align-items:center;justify-content:center;padding:16px">' +
    '<div style="background:#fff;border-radius:12px;width:min(480px,96vw);max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
      '<div style="background:' + cfg.color + ';border-radius:12px 12px 0 0;padding:14px 18px;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-family:Barlow Condensed,sans-serif;font-weight:900;font-size:16px;color:#fff;letter-spacing:.04em">' + cfg.label + '</div>' +
        '<button onclick="spCloseApptModal()" style="background:none;border:none;color:rgba(255,255,255,.7);font-size:20px;cursor:pointer;line-height:1">✕</button>' +
      '</div>' +
      '<div style="padding:18px;display:flex;flex-direction:column;gap:12px">' +
        typeDropdown +
        dateTimeHtml +
        allDayRecurHtml +
        linkFieldHtml +
        locationHtml +
        guestsHtml +
        brevoNote +
        '<div><label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px">Notes <span style="font-weight:400;text-transform:none">(optional)</span></label>' +
        '<textarea id="spApptNotes" rows="2" style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px" placeholder="What is the plan?">' + (keepNotes||'') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button onclick="spCloseApptModal()" style="background:none;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 16px;cursor:pointer;font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:12px">Cancel</button>' +
          '<button onclick="spSaveAppt()" style="background:' + cfg.color + ';color:#fff;border:none;border-radius:7px;padding:8px 18px;cursor:pointer;font-family:Barlow Condensed,sans-serif;font-weight:800;font-size:12px;letter-spacing:.04em;text-transform:uppercase">' + cfg.saveLabel + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

  var existing = document.getElementById('spApptModal');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  spApptWireLookups();
}

function spApptTimeGridHtml(initial, id, label) {
  id = id || 'spApptTime'; label = label || 'Time';
  var cells = SP_APPT_SLOTS.map(function (t) {
    var on = (t === initial);
    return '<button type="button" data-slot="' + t + '" onclick="spApptPickSlot(this,\'' + id + '\')" ' +
      'style="padding:11px 4px;border:1.5px solid ' + (on ? '#C8102E' : '#D7DBE0') + ';' +
      'background:' + (on ? '#C8102E' : '#fff') + ';color:' + (on ? '#fff' : '#333') + ';' +
      'border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">' +
      spApptFmt12(t) + '</button>';
  }).join('');
  var flex = (id === 'spApptTime')
    ? '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#6B7280;cursor:pointer">'
      + '<input type="checkbox" id="spApptFlexTime" onchange="spApptToggleFlex(this)"> Flexible</label>'
    : '';
  return '<div id="' + id + 'Wrap">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">' +
      '<label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em">' + label + '</label>' + flex +
    '</div>' +
    '<input type="hidden" id="' + id + '" value="' + initial + '">' +
    '<div id="' + id + 'Grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">' + cells + '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:7px">' +
      '<button type="button" onclick="spApptShowOtherTime(\'' + id + '\')" style="border:1.5px dashed #B6BCC4;background:#fff;' +
        'color:#5A616B;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer">Other time</button>' +
      '<input type="time" id="' + id + 'Other" onchange="spApptPickOther(this.value,\'' + id + '\')" ' +
        'style="display:none;flex:1;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px">' +
    '</div>' +
  '</div>';
}

function spApptPickSlot(btn, id) {
  id = id || 'spApptTime';
  var grid = document.getElementById(id + 'Grid');
  if (grid) Array.prototype.forEach.call(grid.children, function (b) {
    b.style.background = '#fff'; b.style.color = '#333'; b.style.borderColor = '#D7DBE0';
  });
  btn.style.background = '#C8102E'; btn.style.color = '#fff'; btn.style.borderColor = '#C8102E';
  var h = document.getElementById(id); if (h) h.value = btn.dataset.slot;
  var o = document.getElementById(id + 'Other'); if (o) { o.style.display = 'none'; o.value = ''; }
}

function spApptShowOtherTime(id) {
  var o = document.getElementById((id || 'spApptTime') + 'Other');
  if (!o) return;
  o.style.display = 'block';
  try { o.focus(); if (o.showPicker) o.showPicker(); } catch (e) {}
}

function spApptPickOther(v, id) {
  if (!v) return;
  id = id || 'spApptTime';
  var h = document.getElementById(id); if (h) h.value = v;
  var grid = document.getElementById(id + 'Grid');
  if (grid) Array.prototype.forEach.call(grid.children, function (b) {
    var on = (b.dataset.slot === v);
    b.style.background = on ? '#C8102E' : '#fff';
    b.style.color = on ? '#fff' : '#333';
    b.style.borderColor = on ? '#C8102E' : '#D7DBE0';
  });
}

function spApptToggleFlex(cb) {
  var grid = document.getElementById('spApptTimeGrid');
  var other = document.getElementById('spApptTimeOther');
  if (grid) { grid.style.opacity = cb.checked ? '0.35' : '1'; grid.style.pointerEvents = cb.checked ? 'none' : 'auto'; }
  if (other) other.style.opacity = cb.checked ? '0.35' : '1';
}

// ══════════════════════════════════════════════════════════════════════════
//  APPOINTMENT MODAL -- LIVE ADDRESS LOOKUP
//  Wires the shared termacAddressAutocomplete onto the Location field so the
//  address resolves as it is typed instead of being keyed by hand.
// ══════════════════════════════════════════════════════════════════════════
function spApptWireLookups() {
  // Retry with backoff so termac-d1-sync.js is guaranteed loaded
  var _acRetries = 0;
  function _tryWireAC() {
    var loc = document.getElementById('spApptLocation');
    if (!loc) return;
    if (typeof termacAddressAutocomplete === 'function') {
      // Let termacAddressAutocomplete handle the value directly.
      // It sets inputEl.value to the resolved street address on selection.
      // Passing a minimal onSelect so the business name field also
      // gets filled when the user picks from suggestions.
      termacAddressAutocomplete(loc, {
        fillCompany: 'spApptLinkSearch',
        onSelect: function (r) {
          // Build the complete address string and set it so the field
          // shows the full address, not just the street fragment.
          var full = [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ');
          if (full) { loc.value = full; }
        }
      });
    } else if (_acRetries++ < 20) {
      setTimeout(_tryWireAC, 200);
    }
  }
  _tryWireAC();
}

function spApptSearchRecords(query) {
  var box = document.getElementById('spApptLinkResults');
  if (!box) return;
  var term = (query||'').trim().toLowerCase();
  if (term.length < 2) { box.style.display = 'none'; return; }
  var results = [];

  // 2026-07-20 FIX per Ted: this only ever searched leads + accounts --
  // a real business sitting as a Location (the actual primary entity
  // now) or a Contact could never be found here at all, showing "No
  // matches" for something that genuinely exists. Locations and
  // contacts are both small, safe to check locally; accounts is
  // queried live (see below) since it's too large to trust the local
  // cache for -- same reasoning as everywhere else this got fixed
  // tonight.
  crmLoad('leads').forEach(function(rec) {
    var blob = [rec.name, rec.business, rec.contact, rec.address, rec.addr, rec.city].filter(Boolean).join(' ').toLowerCase();
    if (blob.indexOf(term) !== -1) results.push({ id: rec.id, tab: 'leads', name: rec.business || rec.name || rec.contact, address: rec.address || rec.addr || '', badge: 'Lead' });
  });
  crmLoad('locations').forEach(function(rec) {
    var blob = [rec.name, rec.parentCompany, rec.address, rec.city].filter(Boolean).join(' ').toLowerCase();
    if (blob.indexOf(term) !== -1) results.push({ id: rec.id, tab: 'locations', name: rec.name, address: rec.address || '', badge: 'Location' });
  });
  crmLoad('contacts').forEach(function(rec) {
    var blob = [rec.name, rec.title, rec.phone].filter(Boolean).join(' ').toLowerCase();
    if (blob.indexOf(term) !== -1) results.push({ id: rec.id, tab: 'contacts', name: rec.name, address: '', badge: 'Contact' });
  });

  results = results.slice(0, 8);
  spApptRenderLinkResults(results, term);

  // Accounts queried live, appended once it resolves -- local results
  // above already show instantly, this just adds to them.
  if (typeof d1SearchAccounts === 'function') {
    d1SearchAccounts(term, 5).then(function(rows) {
      var currentBox = document.getElementById('spApptLinkResults');
      var currentInput = document.getElementById('spApptLinkSearch');
      // Bail if the rep already picked something or changed the search
      // while this was in flight.
      if (!currentBox || !currentInput || currentInput.value.trim().toLowerCase() !== term) return;
      var acctResults = rows.map(function(rec) {
        return { id: rec.id, tab: 'accounts', name: rec.business || rec.name || '', address: rec.address || '', badge: 'Account' };
      });
      if (acctResults.length) spApptRenderLinkResults(results.concat(acctResults).slice(0, 12), term);
    }).catch(function() {});
  }
}

function spApptRenderLinkResults(results, term) {
  var box = document.getElementById('spApptLinkResults');
  if (!box) return;
  if (!results.length) { box.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--soft)">No matches for "' + escH(term) + '".</div>'; box.style.display = 'block'; return; }
  box.innerHTML = results.map(function(rr) {
    return '<div onmousedown="event.preventDefault();spApptPickRecord(\'' + rr.id + '\',\'' + rr.tab + '\',' + JSON.stringify(rr.name||'') + ')" ontouchend="event.preventDefault();spApptPickRecord(\'' + rr.id + '\',\'' + rr.tab + '\',' + JSON.stringify(rr.name||'') + ')" style="padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #F1F5F9">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-weight:600">' + escH(rr.name||'Unnamed') + '</span>' +
        '<span style="font-size:10px;color:var(--soft);text-transform:uppercase;margin-left:8px;flex-shrink:0">' + rr.badge + '</span>' +
      '</div>' +
      (rr.address ? '<div style="font-size:11px;color:var(--soft);margin-top:2px">&#128205; ' + escH(rr.address) + '</div>' : '') +
    '</div>';
  }).join('');
  box.style.display = 'block';
}

function spApptPickRecord(id, tab, name) {
  _spApptLinkedId = id; _spApptLinkedTab = tab; _spApptLinkedName = name;
  // Update the link field in place -- no full modal re-render needed.
  // Re-render was causing mobile tap to get lost in the re-paint and
  // the dropdown to stay open due to blur/focus race.
  var searchWrap = document.getElementById('spApptLinkSearch');
  var resultsBox = document.getElementById('spApptLinkResults');
  if (searchWrap && searchWrap.parentNode) {
    searchWrap.parentNode.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;background:#F1F5F9;border-radius:7px;padding:8px 10px;font-size:13px">' +
        '<span>&#128279; ' + escH(name) + '</span>' +
        '<button type="button" onclick="spApptClearLink()" style="background:none;border:none;color:#C8102E;font-size:12px;cursor:pointer;font-weight:700">Change</button>' +
      '</div>';
  } else if (resultsBox) {
    resultsBox.style.display = 'none';
  }
}

function spApptClearLink() {
  _spApptLinkedId = null; _spApptLinkedTab = null; _spApptLinkedName = '';
  // Replace the linked-record pill with the search input again, in place
  var linkWrap = document.querySelector('#spApptModal [data-role="link-field"]');
  if (linkWrap) {
    linkWrap.innerHTML =
      '<div style="position:relative">' +
        '<input type="text" id="spApptLinkSearch" oninput="spApptSearchRecords(this.value)" onblur="setTimeout(function(){var b=document.getElementById(\'spApptLinkResults\');if(b)b.style.display=\'none\';},150)" placeholder="Type the business name..." style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px" autofocus>' +
        '<div id="spApptLinkResults" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1.5px solid #D7DBE0;border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.12);z-index:10;max-height:200px;overflow-y:auto"></div>' +
      '</div>';
  } else {
    // Fallback to full re-render if wrapper not found
    spOpenApptModal(null, null, _spApptMode, document.getElementById('spApptDate')?.value, document.getElementById('spApptNotes')?.value);
  }
}

function spApptToggleAllDay(checked) {
  var wrap = document.getElementById('spApptTimeWrap');
  if (wrap) wrap.style.display = checked ? 'none' : 'block';
}

function spApptToggleGuestChip(btn, name) {
  var i = _spApptGuestChips.indexOf(name);
  if (i >= 0) { _spApptGuestChips.splice(i, 1); btn.style.background = '#fff'; btn.style.color = '#333'; btn.style.borderColor = '#D7DBE0'; }
  else { _spApptGuestChips.push(name); btn.style.background = '#C8102E'; btn.style.color = '#fff'; btn.style.borderColor = '#C8102E'; }
}

function spApptCollectGuests() {
  // Guest invites were removed from the appointment modal. Kept as a stub so
  // every existing caller keeps working and always gets an empty list.
  return [];
}

function spApptFmt12(hhmm) {
  if (!hhmm) return '';
  var p = hhmm.split(':'), h = parseInt(p[0], 10), m = p[1];
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ' ' + ap;
}


  // ── PUBLIC ENTRY POINT ───────────────────────────────────────────────────
  global.termacOpenAppointment = function (o) {
    o = o || {};
    return spOpenApptModal(o.recordId || null, o.tab || null,
                           o.mode || 'appointment', o.date || null, o.notes || null);
  };

  // Existing call sites keep their names. Still one definition, here.
  global.spOpenApptModal        = spOpenApptModal;
  global.spApptTimeGridHtml     = spApptTimeGridHtml;
  global.spApptPickSlot         = spApptPickSlot;
  global.spApptShowOtherTime    = spApptShowOtherTime;
  global.spApptPickOther        = spApptPickOther;
  global.spApptToggleFlex       = spApptToggleFlex;
  global.spApptWireLookups      = spApptWireLookups;
  global.spApptSearchRecords    = spApptSearchRecords;
  global.spApptRenderLinkResults= typeof spApptRenderLinkResults==='function'?spApptRenderLinkResults:undefined;
  global.spApptPickRecord       = typeof spApptPickRecord==='function'?spApptPickRecord:undefined;
  global.spApptClearLink        = spApptClearLink;
  global.spApptToggleAllDay     = spApptToggleAllDay;
  global.spApptToggleGuestChip  = spApptToggleGuestChip;
  global.spApptCollectGuests    = spApptCollectGuests;
  global.spApptFmt12            = spApptFmt12;
  global.SP_APPT_SLOTS          = SP_APPT_SLOTS;
  global.apptQuery              = apptQuery;
})(window);
