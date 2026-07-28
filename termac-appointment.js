/* ═══════════════════════════════════════════════════════════════════════════
   TERMAC ONE -- UNIVERSAL APPOINTMENT CARD
   ═══════════════════════════════════════════════════════════════════════════

   ONE appointment card for the entire platform. Every portal calls the same
   function, gets the same card, writes the same D1 row, and pushes the same
   Outlook event.

   Why this file exists: as of 2026-07-28 there were two separate appointment
   implementations -- one in sales-portal.html backed by D1, one in
   termac-os.html still writing through crmLoad to localStorage. They had
   different fields and different behaviour. Every fix landed in one of them
   and the other kept doing whatever it had been doing, which is why the same
   requests kept coming back. There is now exactly one.

   USE:
     termacOpenAppointment({
       mode:       'appointment' | 'site_visit' | 'task',
       recordId:   'lead_123',          // optional, pre-links the card
       recordTab:  'leads',             // leads|locations|contacts|opportunities|accounts
       recordName: 'Checkers',          // optional display name
       address:    '232 W Lehigh Ave',  // optional prefill
       date:       '2026-07-29',        // optional prefill
       onSaved:    function(appt) {}    // optional callback
     });

   Also fires a 'termac:appointment-saved' CustomEvent on document so any
   page can refresh its own views without being wired in here.

   Depends on termac-d1-sync.js for d1Query and termacAddressAutocomplete.
   Nothing in here touches localStorage except the auth session, which is
   auth state, not business data.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var STAFF_AUTH = 'https://termac-staff-auth.termac-one.workers.dev';
  var D1_PROXY   = 'https://unipro-ai-proxy.termac-one.workers.dev/db';

  // Self-contained D1 access. Uses the host page's d1Query when it exists,
  // otherwise talks to the proxy directly. termac-os.html does not load
  // termac-d1-sync.js, so this component cannot assume any helper is present.
  function q(sql, params) {
    if (typeof global.d1Query === 'function') return global.d1Query(sql, params || []);
    return fetch(D1_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sql, params: params || [] })
    }).then(function (r) { return r.json(); });
  }

  var MODES = {
    appointment: { label: 'Appointment', icon: '\uD83D\uDCC5', color: '#1B5FA8', save: 'Save Appointment' },
    site_visit:  { label: 'Site Visit',  icon: '\uD83D\uDCCD', color: '#C8102E', save: 'Save Site Visit' },
    task:        { label: 'Task',        icon: '\u2705',       color: '#1A7F37', save: 'Save Task' }
  };

  var SLOTS = ['06:30','07:00','07:30','08:00','08:30','09:00','09:30','10:00',
               '10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00',
               '14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00'];

  var _o = {};          // current options
  var _linked = null;   // { id, tab, name, address }
  var _searchTimer = null;

  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt12(hhmm) {
    if (!hhmm) return '';
    var p = String(hhmm).split(':'), h = parseInt(p[0], 10), m = p[1] || '00';
    var ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
    return h + ':' + m + ' ' + ap;
  }
  function todayISO() {
    var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function session() {
    try { return JSON.parse(localStorage.getItem('termac_staff_session') || 'null'); }
    catch (e) { return null; }
  }
  function toast(msg) {
    if (typeof global.spToast === 'function') return global.spToast(msg);
    if (typeof global.showToast === 'function') return global.showToast(msg);
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:#1C2833;color:#fff;padding:12px 20px;border-radius:9px;z-index:100000;' +
      'font-family:Arial,sans-serif;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function el(id) { return document.getElementById(id); }

  // ── time grid ────────────────────────────────────────────────────────────
  function slotGrid(initial) {
    return SLOTS.map(function (t) {
      var on = t === initial;
      return '<button type="button" data-slot="' + t + '" onclick="TermacAppt._pick(this)" ' +
        'style="padding:12px 4px;border:1.5px solid ' + (on ? '#C8102E' : '#D7DBE0') + ';' +
        'background:' + (on ? '#C8102E' : '#fff') + ';color:' + (on ? '#fff' : '#333') + ';' +
        'border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent">' + fmt12(t) + '</button>';
    }).join('');
  }

  function pick(btn) {
    var g = el('taSlots');
    if (g) Array.prototype.forEach.call(g.children, function (b) {
      b.style.background = '#fff'; b.style.color = '#333'; b.style.borderColor = '#D7DBE0';
    });
    btn.style.background = '#C8102E'; btn.style.color = '#fff'; btn.style.borderColor = '#C8102E';
    if (el('taTime')) el('taTime').value = btn.dataset.slot;
    var o = el('taTimeOther'); if (o) { o.style.display = 'none'; o.value = ''; }
  }

  function otherTime() {
    var o = el('taTimeOther'); if (!o) return;
    o.style.display = 'block';
    try { o.focus(); if (o.showPicker) o.showPicker(); } catch (e) {}
  }

  function pickOther(v) {
    if (!v || !el('taTime')) return;
    el('taTime').value = v;
    var g = el('taSlots');
    if (g) Array.prototype.forEach.call(g.children, function (b) {
      var on = b.dataset.slot === v;
      b.style.background = on ? '#C8102E' : '#fff';
      b.style.color = on ? '#fff' : '#333';
      b.style.borderColor = on ? '#C8102E' : '#D7DBE0';
    });
  }

  function toggleFlex(cb) {
    var g = el('taSlots'), o = el('taTimeOther');
    if (g) { g.style.opacity = cb.checked ? '.35' : '1'; g.style.pointerEvents = cb.checked ? 'none' : 'auto'; }
    if (o) o.style.opacity = cb.checked ? '.35' : '1';
  }

  // ── business lookup, live against D1 ─────────────────────────────────────
  function search(q) {
    var box = el('taResults'); if (!box) return;
    var term = (q || '').trim();
    if (term.length < 2) { box.style.display = 'none'; return; }
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () { runSearch(term, box); }, 220);
  }

  function runSearch(term, box) {
    var like = '%' + term.replace(/[%_]/g, '') + '%';
    var qs = [
      ["SELECT id, name AS nm, address AS ad, 'locations' AS tab, 'Location' AS badge FROM locations WHERE name LIKE ? OR address LIKE ? LIMIT 6", [like, like]],
      ["SELECT id, COALESCE(business,name) AS nm, address AS ad, 'leads' AS tab, 'Lead' AS badge FROM leads WHERE business LIKE ? OR name LIKE ? LIMIT 6", [like, like]],
      ["SELECT id, name AS nm, '' AS ad, 'accounts' AS tab, 'Account' AS badge FROM accounts WHERE name LIKE ? LIMIT 6", [like]],
      ["SELECT id, name AS nm, '' AS ad, 'contacts' AS tab, 'Contact' AS badge FROM contacts WHERE name LIKE ? LIMIT 4", [like]]
    ];
    Promise.all(qs.map(function (qq) {
      return q(qq[0], qq[1]).then(function (r) { return (r && r.results) || []; }).catch(function () { return []; });
    })).then(function (sets) {
      var rows = [].concat.apply([], sets);
      if (!rows.length) {
        box.innerHTML = '<div style="padding:11px 12px;font-size:12px;color:#8A9099">No matches. Type a name to use it as-is.</div>';
        box.style.display = 'block'; return;
      }
      box.innerHTML = rows.map(function (r) {
        return '<div onclick="TermacAppt._link(' + JSON.stringify(JSON.stringify(r)).replace(/"/g, '&quot;') + ')" ' +
          'style="padding:10px 12px;cursor:pointer;border-bottom:1px solid #F0F2F4;font-size:13px" ' +
          'onmouseover="this.style.background=\'#F5F7FA\'" onmouseout="this.style.background=\'#fff\'">' +
          '<div style="font-weight:700">' + esc(r.nm || '(no name)') + '</div>' +
          '<div style="font-size:11px;color:#8A9099">' + esc(r.badge) +
          (r.ad ? ' &middot; ' + esc(r.ad) : '') + '</div></div>';
      }).join('');
      box.style.display = 'block';
    });
  }

  function link(json) {
    var r;
    try { r = JSON.parse(json); } catch (e) { return; }
    _linked = { id: r.id, tab: r.tab, name: r.nm, address: r.ad || '' };
    var box = el('taResults'); if (box) box.style.display = 'none';
    var f = el('taLinkField');
    if (f) {
      f.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'background:#F1F5F9;border-radius:7px;padding:9px 11px;font-size:13px">' +
        '<span>&#128279; ' + esc(_linked.name) + '</span>' +
        '<button type="button" onclick="TermacAppt._unlink()" style="background:none;border:none;' +
        'color:#C8102E;font-size:12px;cursor:pointer;font-weight:700">Change</button></div>';
    }
    if (_linked.address && el('taLocation') && !el('taLocation').value) el('taLocation').value = _linked.address;
  }

  function unlink() {
    _linked = null;
    var f = el('taLinkField');
    if (f) { f.innerHTML = linkInputHtml(''); wireLookups(); }
  }

  function linkInputHtml(v) {
    return '<div style="position:relative">' +
      '<input type="text" id="taLinkSearch" value="' + esc(v) + '" oninput="TermacAppt._search(this.value)" ' +
      'placeholder="Type the business name..." autocomplete="off" ' +
      'style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:10px;font-size:13px;box-sizing:border-box">' +
      '<div id="taResults" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;' +
      'background:#fff;border:1.5px solid #D7DBE0;border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.12);' +
      'z-index:20;max-height:230px;overflow-y:auto"></div></div>';
  }

  function lbl(t) {
    return '<label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;' +
      'letter-spacing:.06em;display:block;margin-bottom:4px">' + t + '</label>';
  }

  // ── open ─────────────────────────────────────────────────────────────────
  function open(opts) {
    _o = opts || {};
    var mode = MODES[_o.mode] ? _o.mode : 'appointment';
    var cfg = MODES[mode];
    _o.mode = mode;
    _linked = _o.recordId ? { id: _o.recordId, tab: _o.recordTab || '', name: _o.recordName || '', address: _o.address || '' } : null;

    close();

    var modeOpts = Object.keys(MODES).map(function (k) {
      return '<option value="' + k + '"' + (k === mode ? ' selected' : '') + '>' + MODES[k].icon + '  ' + MODES[k].label + '</option>';
    }).join('');

    var html =
      '<div id="taOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99000;' +
        'display:flex;align-items:center;justify-content:center;padding:16px">' +
      '<div style="background:#fff;border-radius:12px;width:min(520px,96vw);max-height:92vh;' +
        'overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
        '<div style="background:' + cfg.color + ';border-radius:12px 12px 0 0;padding:14px 18px;' +
          'display:flex;align-items:center;justify-content:space-between;position:sticky;top:0">' +
          '<div style="font-family:Barlow Condensed,Arial,sans-serif;font-weight:900;font-size:17px;' +
            'color:#fff;letter-spacing:.04em">' + cfg.icon + '  ' + cfg.label.toUpperCase() + '</div>' +
          '<button onclick="TermacAppt.close()" style="background:none;border:none;color:rgba(255,255,255,.75);' +
            'font-size:22px;cursor:pointer;line-height:1">&times;</button>' +
        '</div>' +
        '<div style="padding:18px;display:flex;flex-direction:column;gap:14px">' +

          '<div><select id="taMode" onchange="TermacAppt._remode(this.value)" style="width:100%;border:1.5px solid #D7DBE0;' +
            'border-radius:7px;padding:10px;font-size:14px;font-weight:700;background:#fff">' + modeOpts + '</select></div>' +

          '<div>' + lbl('Date *') +
            '<input type="date" id="taDate" value="' + esc(_o.date || todayISO()) + '" ' +
            'style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:10px;font-size:14px;box-sizing:border-box"></div>' +

          '<div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">' +
              '<label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em">Time</label>' +
              '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6B7280;cursor:pointer">' +
                '<input type="checkbox" id="taFlex" onchange="TermacAppt._flex(this)"> Flexible</label>' +
            '</div>' +
            '<input type="hidden" id="taTime" value="09:00">' +
            '<div id="taSlots" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">' + slotGrid('09:00') + '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
              '<button type="button" onclick="TermacAppt._other()" style="border:1.5px dashed #B6BCC4;background:#fff;' +
                'color:#5A616B;border-radius:8px;padding:9px 13px;font-size:12px;font-weight:700;cursor:pointer">Other time</button>' +
              '<input type="time" id="taTimeOther" onchange="TermacAppt._pickOther(this.value)" ' +
                'style="display:none;flex:1;border:1.5px solid #D7DBE0;border-radius:7px;padding:9px;font-size:14px">' +
            '</div>' +
          '</div>' +

          '<div>' + lbl('Business Name') + '<div id="taLinkField">' +
            (_linked && _linked.name
              ? '<div style="display:flex;align-items:center;justify-content:space-between;background:#F1F5F9;' +
                'border-radius:7px;padding:9px 11px;font-size:13px"><span>&#128279; ' + esc(_linked.name) + '</span>' +
                '<button type="button" onclick="TermacAppt._unlink()" style="background:none;border:none;color:#C8102E;' +
                'font-size:12px;cursor:pointer;font-weight:700">Change</button></div>'
              : linkInputHtml('')) +
          '</div></div>' +

          '<div>' + lbl('Location') +
            '<input type="text" id="taLocation" value="' + esc((_linked && _linked.address) || _o.address || '') + '" ' +
            'placeholder="Start typing an address..." autocomplete="off" ' +
            'style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:10px;font-size:14px;box-sizing:border-box"></div>' +

          '<div>' + lbl('Notes') +
            '<textarea id="taNotes" rows="3" placeholder="What is the plan?" ' +
            'style="width:100%;border:1.5px solid #D7DBE0;border-radius:7px;padding:10px;font-size:14px;' +
            'resize:vertical;box-sizing:border-box;font-family:inherit"></textarea></div>' +

          '<div style="display:flex;gap:10px;justify-content:flex-end;padding-top:4px">' +
            '<button onclick="TermacAppt.close()" style="padding:12px 20px;background:#fff;border:1.5px solid #D7DBE0;' +
              'border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Cancel</button>' +
            '<button id="taSave" onclick="TermacAppt.save()" style="padding:12px 22px;background:' + cfg.color + ';' +
              'color:#fff;border:none;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;' +
              'text-transform:uppercase;letter-spacing:.04em">' + cfg.save + '</button>' +
          '</div>' +
        '</div></div></div>';

    document.body.insertAdjacentHTML('beforeend', html);
    wireLookups();
  }

  function wireLookups() {
    setTimeout(function () {
      var loc = el('taLocation');
      if (loc && typeof termacAddressAutocomplete === 'function') {
        termacAddressAutocomplete(loc, {
          onSelect: function (r) {
            var full = [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ');
            if (full) loc.value = full;
          }
        });
      }
    }, 60);
  }

  function remode(m) {
    _o.mode = m;
    _o.date = el('taDate') ? el('taDate').value : _o.date;
    _o.recordId = _linked ? _linked.id : null;
    _o.recordTab = _linked ? _linked.tab : null;
    _o.recordName = _linked ? _linked.name : null;
    _o.address = el('taLocation') ? el('taLocation').value : '';
    open(_o);
  }

  function close() {
    var o = el('taOverlay'); if (o) o.remove();
  }

  // ── save ─────────────────────────────────────────────────────────────────
  function save() {
    var s = session();
    if (!s || !s.email) { toast('Sign in again to save appointments.'); return; }

    var date = el('taDate') ? el('taDate').value : '';
    if (!date) { toast('Pick a date.'); return; }

    var flex = el('taFlex') && el('taFlex').checked;
    var time = flex ? '' : (el('taTime') ? el('taTime').value : '');
    var loc = el('taLocation') ? el('taLocation').value.trim() : '';
    var notes = el('taNotes') ? el('taNotes').value.trim() : '';
    var biz = _linked ? _linked.name : (el('taLinkSearch') ? el('taLinkSearch').value.trim() : '');
    var mode = _o.mode || 'appointment';

    var btn = el('taSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    var id = mode + '_' + Date.now();
    var tab = _linked ? _linked.tab : '';
    var row = {
      id: id,
      record_id: _linked ? _linked.id : null,
      tab: tab || null,
      // typed FKs so every read path can trace the appointment back to its record
      location_id:    tab === 'locations'     ? _linked.id : null,
      lead_id:        tab === 'leads'         ? _linked.id : null,
      contact_id:     tab === 'contacts'      ? _linked.id : null,
      opportunity_id: tab === 'opportunities' ? _linked.id : null,
      account_id:     tab === 'accounts'      ? _linked.id : null,
      title: (biz ? biz + ' \u2014 ' : '') + (MODES[mode] || MODES.appointment).label,
      business: biz || null,
      date: date,
      time: time || null,
      type: mode,
      notes: notes || null,
      location: loc || null,
      is_flex_stop: flex ? 1 : 0,
      rep: s.name || s.email,
      created_by: s.name || s.email,
      division: s.division || null,
      status: 'scheduled',
      created_at: Date.now(),
      updated_at: Date.now()
    };

    var cols = Object.keys(row);
    var sql = 'INSERT INTO appointments (' + cols.join(',') + ') VALUES (' +
      cols.map(function () { return '?'; }).join(',') + ')';

    var p = q(sql, cols.map(function (c) { return row[c]; }));

    p.then(function () {
      pushToOutlook(row, s);
      toast((MODES[mode] || MODES.appointment).label + ' saved');
      close();
      try { document.dispatchEvent(new CustomEvent('termac:appointment-saved', { detail: row })); } catch (e) {}
      if (typeof _o.onSaved === 'function') { try { _o.onSaved(row); } catch (e) {} }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = (MODES[mode] || MODES.appointment).save; }
      toast('Could not save. ' + (e && e.message ? e.message : 'Try again.'));
    });
  }

  function pushToOutlook(row, s) {
    if (!row.date) return;
    var t = row.time || '08:00';
    var startDt = row.date + 'T' + t + ':00';
    var p = t.split(':');
    var eh = Math.min(23, parseInt(p[0], 10) + 1);
    var endDt = row.date + 'T' + (eh < 10 ? '0' : '') + eh + ':' + (p[1] || '00') + ':00';
    fetch(STAFF_AUTH + '/calendar-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        termac_appt_id: row.id,
        from_email: s.email,
        event: {
          subject: row.title,
          start: startDt,
          end: endDt,
          location: row.location || '',
          body: (row.notes || '') + (row.location ? '\n\n\uD83D\uDCCD ' + row.location : '')
        }
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) toast('\uD83D\uDCC5 Added to your Outlook calendar');
      else if (d && d.error === 'no_graph_token') toast('Sign out and back in to enable calendar sync.');
    }).catch(function () {});
  }

  // ── public ───────────────────────────────────────────────────────────────
  var API = {
    open: open,
    close: close,
    save: save,
    _pick: pick,
    _other: otherTime,
    _pickOther: pickOther,
    _flex: toggleFlex,
    _search: search,
    _link: link,
    _unlink: unlink,
    _remode: remode
  };

  global.TermacAppt = API;
  global.termacOpenAppointment = open;

})(window);
