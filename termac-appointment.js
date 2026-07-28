/* ══════════════════════════════════════════════════════════════════════════
   TERMAC ONE — APPOINTMENT CARD  (rewritten 2026-07-28)
   Single definition for the entire platform. No other file defines this.

   SEARCH LOGIC (per field spec):
   ┌─────────────────────────────────────────────────────────────────────┐
   │  One search box at the top of the modal.                            │
   │  Step A: query internal DB (leads, locations, contacts, accounts)   │
   │          → show instantly, tagged 🏢 with green "System" badge      │
   │  Step B: 300ms debounce → Google Places autocomplete               │
   │          → show below, tagged 📍 with blue "Google" badge          │
   │  Selecting a system record: fills all fields + attaches record ID   │
   │  Selecting a Google place: detail fetch fills address + phone,      │
   │          sets is_new_location = true, saves a new Location to D1    │
   └─────────────────────────────────────────────────────────────────────┘

   SAVE writes to:
   - D1 appointments table via apptQuery (INSERT)
   - D1 locations table if is_new_location (INSERT)
   - Outlook calendar via pushApptToOutlook if available

   PUBLIC API:
     termacOpenAppointment({ recordId, tab, mode, date, notes })
   ══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var PROXY = 'https://unipro-ai-proxy.termac-one.workers.dev';

  // ── D1 query helper (works with or without termac-d1-sync.js) ──────────
  function apptQuery(sql, params) {
    if (typeof global.d1Query === 'function') return global.d1Query(sql, params || []);
    return fetch(PROXY + '/db/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Secret': 'termac2026' },
      body: JSON.stringify({ sql: sql, params: params || [] })
    }).then(function (r) { return r.json(); }).catch(function () { return { results: [] }; });
  }

  // ── Internal state ────────────────────────────────────────────────────
  var _linkedId   = null;   // D1 record ID attached to this appointment
  var _linkedTab  = null;   // 'leads' | 'locations' | 'contacts' | 'accounts'
  var _linkedName = null;   // display name for the linked record
  var _isNew      = false;  // true when a Google Place was selected → create location
  var _newPlaceData = null; // { name, address, city, state, zip, phone, placeId }
  var _searchTimer = null;
  var _placesTimer = null;
  var _lastTerm   = '';
  var _placesSearched = false;

  // ── Time slots for the tap grid ────────────────────────────────────────
  var SLOTS = [
    '06:30','07:00','07:30','08:00','08:30','09:00','09:30','10:00',
    '10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00',
    '14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00'
  ];

  function fmt12(hhmm) {
    if (!hhmm) return '';
    var p = hhmm.split(':'), h = parseInt(p[0], 10), m = p[1];
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (!h) h = 12;
    return h + ':' + m + ' ' + ap;
  }

  function escH(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Modal HTML ────────────────────────────────────────────────────────
  function buildModal(opts) {
    opts = opts || {};
    var today = new Date().toISOString().slice(0, 10);
    var defaultDate = opts.date || today;
    var defaultTime = '09:00';

    // Linked record chip or empty
    var linkedChip = _linkedId
      ? '<div id="taLinkedChip" style="display:flex;align-items:center;justify-content:space-between;background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:8px 12px;font-size:13px">'
        + '<span>🏢 ' + escH(_linkedName) + '</span>'
        + '<button type="button" onclick="taUnlink()" style="background:none;border:none;color:#C8102E;font-weight:700;font-size:12px;cursor:pointer">Change</button>'
        + '</div>'
      : '';

    // Time tap grid
    var cells = SLOTS.map(function (t) {
      var on = (t === defaultTime);
      return '<button type="button" data-slot="' + t + '" onclick="taPickSlot(this)"'
        + ' style="padding:11px 2px;border:1.5px solid ' + (on ? '#C8102E' : '#D7DBE0') + ';'
        + 'background:' + (on ? '#C8102E' : '#fff') + ';color:' + (on ? '#fff' : '#1A1D21') + ';'
        + 'border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;min-height:48px;'
        + '-webkit-tap-highlight-color:transparent">' + fmt12(t) + '</button>';
    }).join('');

    return '<div id="taModal" onclick="if(event.target===this)taClose()" '
      + 'style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9800;'
      + 'display:flex;align-items:flex-end;justify-content:center;padding:0">'
      + '<div style="background:#fff;border-radius:18px 18px 0 0;width:100%;max-width:540px;'
      + 'max-height:94vh;overflow-y:auto;-webkit-overflow-scrolling:touch;box-shadow:0 -8px 40px rgba(0,0,0,.2)">'

      // ── Header ─────────────────────────────────────────────────────
      + '<div style="background:#1A1D21;border-radius:18px 18px 0 0;padding:16px 18px;'
      + 'display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:1">'
        + '<div style="font-family:Barlow Condensed,sans-serif;font-weight:900;font-size:18px;'
        + 'color:#fff;letter-spacing:.04em">📅 Set Appointment</div>'
        + '<button type="button" onclick="taClose()" style="background:none;border:none;color:rgba(255,255,255,.6);'
        + 'font-size:22px;cursor:pointer;line-height:1;padding:4px">✕</button>'
      + '</div>'

      + '<div style="padding:18px;display:flex;flex-direction:column;gap:14px">'

        // ── Search box ───────────────────────────────────────────────
        + '<div>'
          + '<label style="display:block;font-size:10px;font-weight:700;color:#5A616B;'
          + 'text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">🔍 Search Business / Location</label>'
          + '<div style="position:relative">'
            + '<input type="text" id="taSearch" placeholder="Type business name or address…" autocomplete="off" '
            + 'style="width:100%;box-sizing:border-box;padding:13px 14px;border:1.5px solid #D7DBE0;'
            + 'border-radius:10px;font-size:15px;min-height:48px;-webkit-appearance:none"'
            + ' oninput="taOnSearch(this.value)">'
            + '<div id="taDropdown" style="display:none;position:absolute;left:0;right:0;top:calc(100%+4px);'
            + 'background:#fff;border:1.5px solid #D7DBE0;border-radius:10px;'
            + 'box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:100;max-height:260px;overflow-y:auto"></div>'
          + '</div>'
          + linkedChip
        + '</div>'

        // ── Selected details (hidden until a record is picked) ────────
        + '<div id="taDetails" style="display:flex;flex-direction:column;gap:12px">'
          + taField('Business Name', 'taBiz', 'text', 'Business name')
          + taField('Location / Address', 'taAddr', 'text', 'Full address')
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
            + taField('Contact Name', 'taContact', 'text', 'Name (optional)')
            + taField('Phone', 'taPhone', 'tel', 'Phone (optional)')
          + '</div>'
          + taField('Email', 'taEmail', 'email', 'Email (optional)')
        + '</div>'

        // ── Date ──────────────────────────────────────────────────────
        + '<div>'
          + '<label style="display:block;font-size:10px;font-weight:700;color:#5A616B;'
          + 'text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Date *</label>'
          + '<input type="date" id="taDate" value="' + defaultDate + '" '
          + 'style="width:100%;box-sizing:border-box;padding:13px 14px;border:1.5px solid #D7DBE0;'
          + 'border-radius:10px;font-size:15px;min-height:48px">'
        + '</div>'

        // ── Time tap grid ─────────────────────────────────────────────
        + '<div>'
          + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
            + '<label style="font-size:10px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.08em">Time</label>'
            + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6B7280;cursor:pointer">'
              + '<input type="checkbox" id="taFlex" onchange="taToggleFlex(this)"> Flexible</label>'
          + '</div>'
          + '<input type="hidden" id="taTime" value="' + defaultTime + '">'
          + '<div id="taGrid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">' + cells + '</div>'
          + '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">'
            + '<button type="button" onclick="taShowOther()" style="border:1.5px dashed #B6BCC4;background:#fff;'
            + 'color:#5A616B;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:700;cursor:pointer;min-height:48px">Other time</button>'
            + '<input type="time" id="taTimeOther" onchange="taPickOther(this.value)" '
            + 'style="display:none;flex:1;border:1.5px solid #D7DBE0;border-radius:10px;padding:13px 14px;font-size:15px;min-height:48px">'
          + '</div>'
        + '</div>'

        // ── Notes ─────────────────────────────────────────────────────
        + '<div>'
          + '<label style="display:block;font-size:10px;font-weight:700;color:#5A616B;'
          + 'text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Notes / Job Scope (optional)</label>'
          + '<textarea id="taNotes" placeholder="What is the plan?" rows="3" '
          + 'style="width:100%;box-sizing:border-box;padding:13px 14px;border:1.5px solid #D7DBE0;'
          + 'border-radius:10px;font-size:15px;resize:vertical">'
          + escH(opts.notes || '')
          + '</textarea>'
        + '</div>'

        // ── Brevo note ────────────────────────────────────────────────
        + '<div style="background:#EBF2FD;border-radius:8px;padding:10px 14px;font-size:11px;color:#1B5FA8">'
          + '📧 Customer confirmation fires via Brevo when wired. Promotes Lead/Contact to Opportunity.'
        + '</div>'

        // ── Buttons ───────────────────────────────────────────────────
        + '<div style="display:flex;gap:10px;padding-bottom:env(safe-area-inset-bottom,0)">'
          + '<button type="button" onclick="taClose()" '
          + 'style="flex:0 0 90px;background:#fff;border:1.5px solid #D7DBE0;border-radius:10px;'
          + 'padding:14px;font-size:15px;cursor:pointer;min-height:52px">Cancel</button>'
          + '<button type="button" onclick="taSave()" '
          + 'style="flex:1;background:#C8102E;color:#fff;border:none;border-radius:10px;'
          + 'font-family:Barlow Condensed,sans-serif;font-weight:900;font-size:16px;'
          + 'letter-spacing:.06em;text-transform:uppercase;cursor:pointer;min-height:52px">Save Appointment</button>'
        + '</div>'

      + '</div>'   // end inner padding div
    + '</div>'     // end card
    + '</div>';    // end overlay
  }

  function taField(label, id, type, ph) {
    return '<div>'
      + '<label for="' + id + '" style="display:block;font-size:10px;font-weight:700;color:#5A616B;'
      + 'text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">' + label + '</label>'
      + '<input type="' + type + '" id="' + id + '" placeholder="' + ph + '" autocomplete="off" '
      + 'style="width:100%;box-sizing:border-box;padding:13px 14px;border:1.5px solid #D7DBE0;'
      + 'border-radius:10px;font-size:15px;min-height:48px;-webkit-appearance:none">'
    + '</div>';
  }

  // ── Open / close ──────────────────────────────────────────────────────
  function taOpen(opts) {
    opts = opts || {};
    // Reset state
    _linkedId = opts.recordId || null;
    _linkedTab = opts.tab || null;
    _linkedName = null;
    _isNew = false;
    _newPlaceData = null;

    // If a record is pre-linked, resolve its name
    var render = function () {
      var existing = document.getElementById('taModal');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', buildModal(opts));
      // Pre-show details if linked
      if (_linkedId) {
        document.getElementById('taDetails').style.display = 'flex';
        taLoadLinked(_linkedId, _linkedTab);
      }
    };

    if (_linkedId && _linkedTab) {
      // Look up the record name so the chip shows it
      var tbl = _linkedTab === 'leads' ? 'leads'
              : _linkedTab === 'contacts' ? 'contacts'
              : _linkedTab === 'accounts' ? 'accounts' : 'locations';
      apptQuery('SELECT name, business, address FROM ' + tbl + ' WHERE id=? LIMIT 1', [_linkedId])
        .then(function (res) {
          var r = res && res.results && res.results[0];
          if (r) {
            _linkedName = r.business || r.name || '';
          }
          render();
        }).catch(render);
    } else {
      render();
    }
  }

  function taClose() {
    var m = document.getElementById('taModal');
    if (m) m.remove();
    _linkedId = null; _linkedTab = null; _linkedName = null;
    _isNew = false; _newPlaceData = null;
    clearTimeout(_searchTimer); clearTimeout(_placesTimer);
  }

  // ── Search ────────────────────────────────────────────────────────────
  function taOnSearch(val) {
    var term = (val || '').trim();
    _lastTerm = term;
    _placesSearched = false;
    clearTimeout(_searchTimer); clearTimeout(_placesTimer);

    var drop = document.getElementById('taDropdown');
    if (!drop) return;

    if (term.length < 2) {
      drop.style.display = 'none';
      drop.innerHTML = '';
      return;
    }

    // Step A: internal search immediately (local cache is fast)
    _searchTimer = setTimeout(function () { taSearchInternal(term); }, 0);
    // Step B: Google Places after 300ms debounce
    _placesTimer = setTimeout(function () { taSearchPlaces(term); }, 300);
  }

  var _internalResults = [];
  var _placesResults   = [];

  function taSearchInternal(term) {
    _internalResults = [];
    var tl = term.toLowerCase();
    var load = typeof crmLoad === 'function' ? crmLoad : function () { return []; };

    load('leads').forEach(function (r) {
      var blob = [r.name, r.business, r.contact, r.address, r.city].filter(Boolean).join(' ').toLowerCase();
      if (blob.indexOf(tl) !== -1) _internalResults.push({
        id: r.id, tab: 'leads', name: r.business || r.name || '', address: r.address || '',
        contact: r.contact || '', phone: r.phone || '', email: r.email || '', badge: 'Lead'
      });
    });
    load('locations').forEach(function (r) {
      var blob = [r.name, r.parentCompany, r.address, r.city].filter(Boolean).join(' ').toLowerCase();
      if (blob.indexOf(tl) !== -1) _internalResults.push({
        id: r.id, tab: 'locations', name: r.name || '', address: r.address || '',
        contact: '', phone: '', email: '', badge: 'Location'
      });
    });
    load('contacts').forEach(function (r) {
      var blob = [r.name, r.phone, r.email].filter(Boolean).join(' ').toLowerCase();
      if (blob.indexOf(tl) !== -1) _internalResults.push({
        id: r.id, tab: 'contacts', name: r.name || '', address: '',
        contact: r.name || '', phone: r.phone || '', email: r.email || '', badge: 'Contact'
      });
    });
    _internalResults = _internalResults.slice(0, 8);
    taRenderDropdown();
  }

  function taSearchPlaces(term) {
    if (term !== _lastTerm) return;
    _placesSearched = false;
    fetch(PROXY + '/maps/autocomplete?q=' + encodeURIComponent(term) + '&lat=40.0&lng=-75.2')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (term !== _lastTerm) return;
        _placesSearched = true;
        _placesResults = (d.predictions || []).map(function (p) {
          return { placeId: p.placeId, name: p.main || '', secondary: p.secondary || '', isPlace: p.isPlace };
        });
        taRenderDropdown();
      }).catch(function () {
        _placesSearched = true;
        taRenderDropdown();
      });
  }

  function taRenderDropdown() {
    var drop = document.getElementById('taDropdown');
    if (!drop) return;
    var html = '';

    if (_internalResults.length) {
      html += '<div style="padding:6px 12px;font-size:10px;font-weight:800;color:#166534;'
        + 'text-transform:uppercase;letter-spacing:.08em;background:#F0FDF4;border-radius:8px 8px 0 0">🏢 System Records</div>';
      html += _internalResults.map(function (r) {
        return '<div onmousedown="event.preventDefault();taPickInternal(' + JSON.stringify(r) + ')" '
          + 'ontouchend="event.preventDefault();taPickInternal(' + JSON.stringify(r) + ')" '
          + 'style="padding:11px 14px;cursor:pointer;border-bottom:1px solid #F1F5F9;min-height:48px;'
          + 'display:flex;flex-direction:column;justify-content:center"'
          + ' onmouseover="this.style.background=\'#F0FDF4\'" onmouseout="this.style.background=\'\'">'
          + '<div style="display:flex;justify-content:space-between;align-items:center">'
            + '<span style="font-weight:700;font-size:14px">' + escH(r.name || 'Unnamed') + '</span>'
            + '<span style="font-size:10px;font-weight:700;color:#166534;background:#DCFCE7;'
            + 'border-radius:4px;padding:2px 7px;flex-shrink:0">' + r.badge + '</span>'
          + '</div>'
          + (r.address ? '<div style="font-size:12px;color:#6B7280;margin-top:2px">📍 ' + escH(r.address) + '</div>' : '')
          + (r.contact ? '<div style="font-size:12px;color:#6B7280">👤 ' + escH(r.contact) + (r.phone ? ' · ' + escH(r.phone) : '') + '</div>' : '')
        + '</div>';
      }).join('');
    }

    if (_placesResults.length) {
      html += '<div style="padding:6px 12px;font-size:10px;font-weight:800;color:#1B5FA8;'
        + 'text-transform:uppercase;letter-spacing:.08em;background:#EBF2FD"'
        + (html ? '' : ';border-radius:8px 8px 0 0') + '>📍 Google Places</div>';
      html += _placesResults.map(function (p) {
        return '<div onmousedown="event.preventDefault();taPickPlace(' + JSON.stringify(p) + ')" '
          + 'ontouchend="event.preventDefault();taPickPlace(' + JSON.stringify(p) + ')" '
          + 'style="padding:11px 14px;cursor:pointer;border-bottom:1px solid #F1F5F9;min-height:48px;'
          + 'display:flex;flex-direction:column;justify-content:center"'
          + ' onmouseover="this.style.background=\'#EBF2FD\'" onmouseout="this.style.background=\'\'">'
          + '<div style="display:flex;justify-content:space-between;align-items:center">'
            + '<span style="font-weight:700;font-size:14px">' + escH(p.name) + '</span>'
            + '<span style="font-size:10px;font-weight:700;color:#1B5FA8;background:#DBEAFE;'
            + 'border-radius:4px;padding:2px 7px;flex-shrink:0">Google</span>'
          + '</div>'
          + (p.secondary ? '<div style="font-size:12px;color:#6B7280;margin-top:2px">📍 ' + escH(p.secondary) + '</div>' : '')
        + '</div>';
      }).join('');
    }

    if (!html && _lastTerm.length >= 2) {
      // Only show 'no results' if Google Places has already responded
      html = _placesSearched
        ? '<div style="padding:14px;font-size:13px;color:#6B7280;text-align:center">No matches found. Try a shorter term.</div>'
        : '<div style="padding:14px;font-size:13px;color:#6B7280;text-align:center">Searching Google Places…</div>';
    }

    drop.innerHTML = html;
    drop.style.display = html ? 'block' : 'none';
  }

  // ── Picking a result ──────────────────────────────────────────────────
  function taPickInternal(r) {
    _linkedId   = r.id;
    _linkedTab  = r.tab;
    _linkedName = r.name;
    _isNew      = false;
    _newPlaceData = null;

    var drop = document.getElementById('taDropdown');
    var search = document.getElementById('taSearch');
    if (drop) drop.style.display = 'none';
    if (search) search.value = r.name;

    taShowLinkedChip(r.name);
    taFillFields({ name: r.name, address: r.address, contact: r.contact, phone: r.phone, email: r.email });

    // Load full record from D1 for complete contact info
    taLoadLinked(r.id, r.tab);
  }

  function taPickPlace(p) {
    var drop = document.getElementById('taDropdown');
    var search = document.getElementById('taSearch');
    if (drop) drop.style.display = 'none';

    // Show the place name immediately while detail resolves
    if (search) search.value = [p.name, p.secondary].filter(Boolean).join(', ');

    // Fetch full detail
    fetch(PROXY + '/maps/detail?place_id=' + encodeURIComponent(p.placeId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var street = [d.street_number, d.route].filter(Boolean).join(' ');
        var fullAddr = [street || p.name, d.city, d.state, d.zip].filter(Boolean).join(', ');
        _isNew = true;
        _linkedId = null;
        _linkedTab = null;
        _linkedName = d.name || p.name;
        _newPlaceData = {
          name: d.name || p.name,
          address: fullAddr,
          city: d.city || '',
          state: d.state || '',
          zip: d.zip || '',
          phone: d.phone || '',
          lat: d.lat, lng: d.lng,
          placeId: p.placeId
        };
        taShowLinkedChip((d.name || p.name) + ' 🆕');
        taFillFields({ name: d.name || p.name, address: fullAddr, phone: d.phone || '' });
        if (search) search.value = '';
      }).catch(function () {
        // Detail failed — fill with what we have from the suggestion
        _isNew = true;
        _newPlaceData = { name: p.name, address: p.secondary || '', placeId: p.placeId };
        taShowLinkedChip(p.name + ' 🆕');
        taFillFields({ name: p.name, address: p.secondary || '' });
        if (search) search.value = '';
      });
  }

  function taLoadLinked(id, tab) {
    var tbl = tab === 'leads' ? 'leads' : tab === 'contacts' ? 'contacts'
            : tab === 'accounts' ? 'accounts' : 'locations';
    apptQuery('SELECT * FROM ' + tbl + ' WHERE id=? LIMIT 1', [id])
      .then(function (res) {
        var r = res && res.results && res.results[0];
        if (!r) return;
        taFillFields({
          name: r.business || r.name || '',
          address: r.address || '',
          contact: r.contact || r.contact_name || '',
          phone: r.phone || '',
          email: r.email || ''
        });
      }).catch(function () {});
  }

  function taShowLinkedChip(name) {
    // Replace search box area with a chip showing the selected record
    var search = document.getElementById('taSearch');
    if (search) search.style.display = 'none';
    var existing = document.getElementById('taLinkedChip');
    if (existing) { existing.querySelector('span').textContent = '🏢 ' + name; existing.style.display = 'flex'; return; }
    var chip = document.createElement('div');
    chip.id = 'taLinkedChip';
    chip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:600;margin-top:6px';
    chip.innerHTML = '<span>🏢 ' + escH(name) + '</span>'
      + '<button type="button" onclick="taUnlink()" style="background:none;border:none;color:#C8102E;font-weight:700;font-size:13px;cursor:pointer;padding:4px 8px">Change</button>';
    if (search) search.parentNode.insertBefore(chip, search.nextSibling);
    document.getElementById('taDetails').style.display = 'flex';
  }

  function taUnlink() {
    _linkedId = null; _linkedTab = null; _linkedName = null; _isNew = false; _newPlaceData = null;
    var chip = document.getElementById('taLinkedChip');
    if (chip) chip.remove();
    var search = document.getElementById('taSearch');
    if (search) { search.style.display = ''; search.value = ''; search.focus(); }
    taFillFields({ name: '', address: '', contact: '', phone: '', email: '' });
    document.getElementById('taDetails').style.display = 'none';
    _internalResults = []; _placesResults = [];
  }

  function taFillFields(f) {
    var set = function (id, val) { var e = document.getElementById(id); if (e && val != null) e.value = val; };
    set('taBiz',     f.name    || '');
    set('taAddr',    f.address || '');
    set('taContact', f.contact || '');
    set('taPhone',   f.phone   || '');
    set('taEmail',   f.email   || '');
  }

  // ── Time grid ─────────────────────────────────────────────────────────
  function taPickSlot(btn) {
    var grid = document.getElementById('taGrid');
    if (grid) Array.prototype.forEach.call(grid.children, function (b) {
      b.style.background = '#fff'; b.style.color = '#1A1D21'; b.style.borderColor = '#D7DBE0';
    });
    btn.style.background = '#C8102E'; btn.style.color = '#fff'; btn.style.borderColor = '#C8102E';
    var h = document.getElementById('taTime'); if (h) h.value = btn.dataset.slot;
    var o = document.getElementById('taTimeOther'); if (o) { o.style.display = 'none'; o.value = ''; }
  }

  function taShowOther() {
    var o = document.getElementById('taTimeOther');
    if (!o) return;
    o.style.display = 'block';
    try { o.focus(); if (o.showPicker) o.showPicker(); } catch (e) {}
  }

  function taPickOther(v) {
    if (!v) return;
    var h = document.getElementById('taTime'); if (h) h.value = v;
    var grid = document.getElementById('taGrid');
    if (grid) Array.prototype.forEach.call(grid.children, function (b) {
      var on = (b.dataset.slot === v);
      b.style.background = on ? '#C8102E' : '#fff';
      b.style.color = on ? '#fff' : '#1A1D21';
      b.style.borderColor = on ? '#C8102E' : '#D7DBE0';
    });
  }

  function taToggleFlex(cb) {
    var grid = document.getElementById('taGrid');
    var other = document.getElementById('taTimeOther');
    var op = cb.checked ? '0.35' : '1';
    var pe = cb.checked ? 'none' : 'auto';
    if (grid) { grid.style.opacity = op; grid.style.pointerEvents = pe; }
    if (other) other.style.opacity = op;
  }

  // ── Save ──────────────────────────────────────────────────────────────
  function taSave() {
    var date  = (document.getElementById('taDate')  || {}).value || '';
    var time  = (document.getElementById('taTime')  || {}).value || '';
    var biz   = ((document.getElementById('taBiz')  || {}).value || '').trim();
    var addr  = ((document.getElementById('taAddr') || {}).value || '').trim();
    var notes = ((document.getElementById('taNotes')|| {}).value || '').trim();
    var contact = ((document.getElementById('taContact')||{}).value||'').trim();
    var phone   = ((document.getElementById('taPhone')  ||{}).value||'').trim();

    if (!date) { alert('Please choose a date.'); return; }
    if (!biz && !addr && !_linkedId) { alert('Please search for a business or enter a location.'); return; }

    var btn = document.querySelector('#taModal button[onclick="taSave()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    var doSave = function (locationId) {
      var now = Date.now();
      var id  = 'appt_' + now + '_' + Math.random().toString(36).slice(2, 6);
      var payload = {
        id: id,
        record_id:      _linkedId   || locationId || null,
        tab:            _linkedTab  || (locationId ? 'locations' : null),
        location_id:    (_linkedTab === 'locations' ? _linkedId : null) || locationId || null,
        lead_id:        _linkedTab  === 'leads'    ? _linkedId : null,
        contact_id:     _linkedTab  === 'contacts' ? _linkedId : null,
        opportunity_id: _linkedTab  === 'opportunities' ? _linkedId : null,
        title:          biz || addr || 'Appointment',
        business:       biz,
        address:        addr,
        contact_name:   contact,
        phone:          phone,
        date:           date,
        time:           time,
        notes:          notes,
        rep:            (typeof _spRep !== 'undefined' && _spRep ? _spRep.name : ''),
        type:           'appointment',
        created_at:     now,
        updated_at:     now
      };

      // Write to D1
      apptQuery(
        'INSERT INTO appointments (id, record_id, tab, location_id, lead_id, contact_id, ' +
        'opportunity_id, title, business, address, contact_name, phone, date, time, notes, rep, type, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [payload.id, payload.record_id, payload.tab, payload.location_id, payload.lead_id,
         payload.contact_id, payload.opportunity_id, payload.title, payload.business,
         payload.address, payload.contact_name, payload.phone, payload.date, payload.time,
         payload.notes, payload.rep, payload.type, payload.created_at, payload.updated_at]
      ).catch(function () {});

      // Also save to local cache for instant UI update
      if (typeof crmSave === 'function') {
        try {
          var appts = (typeof crmLoad === 'function' ? crmLoad('appointments') : null) || [];
          appts.push(payload);
          crmSave('appointments', appts);
        } catch (e) {}
      }

      // Outlook push
      if (typeof pushApptToOutlook === 'function') {
        pushApptToOutlook(payload).catch(function () {});
      }

      taClose();
      if (typeof spToast === 'function') spToast('📅 Appointment saved — ' + date + (time ? ' at ' + fmt12(time) : ''));
      if (typeof spRender === 'function' && typeof _spTab !== 'undefined') spRender(_spTab);
    };

    // If a Google Place was selected, create the Location record first
    if (_isNew && _newPlaceData) {
      var locId = 'loc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      apptQuery(
        'INSERT INTO locations (id, name, address, city, state, zip, phone, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [locId, _newPlaceData.name, _newPlaceData.address, _newPlaceData.city || '',
         _newPlaceData.state || '', _newPlaceData.zip || '', _newPlaceData.phone || '',
         'Google Places', Date.now(), Date.now()]
      ).then(function () { doSave(locId); }).catch(function () { doSave(null); });
    } else {
      doSave(null);
    }
  }

  // ── Public exports ────────────────────────────────────────────────────
  global.termacOpenAppointment = function (o) {
    taOpen(o || {});
  };
  global.spOpenApptModal = function (id, tab, mode, date, notes) {
    taOpen({ recordId: id, tab: tab, mode: mode, date: date, notes: notes });
  };

  // Functions called from onclick attributes in the generated HTML
  global.taClose      = taClose;
  global.taOnSearch   = taOnSearch;
  global.taPickInternal = taPickInternal;
  global.taPickPlace  = taPickPlace;
  global.taUnlink     = taUnlink;
  global.taPickSlot   = taPickSlot;
  global.taShowOther  = taShowOther;
  global.taPickOther  = taPickOther;
  global.taToggleFlex = taToggleFlex;
  global.taSave       = taSave;
  global.apptQuery    = apptQuery;

  // Backward-compat stubs so existing call sites do not throw
  global.spCloseApptModal      = taClose;
  global.spSaveApptFromModal   = taSave;
  global.spApptCollectGuests   = function () { return []; };
  global.spApptToggleGuestChip = function () {};
  global.SP_APPT_SLOTS         = SLOTS;
  global.spApptFmt12           = fmt12;

})(window);
