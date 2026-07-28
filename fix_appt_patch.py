import io

p = '/tmp/ups/sales-portal.html'
s = io.open(p, encoding='utf-8').read()
orig = s

# 1. TIME: replace the scroll-wheel <input type="time"> block with a tap grid.
i = s.index('id="spApptTimeWrap"')
st = s.rfind('\n', 0, i) + 1
en = s.index('\n', s.index('Flexible', i)) + 1
old = s[st:en]
assert 'spApptFlexTime' in old and len(old) < 1400, len(old)
s = s[:st] + "      spApptTimeGridHtml('09:00') +\n" + s[en:]

# Drop the grid builder in just above spOpenApptModal's caller helpers.
ANCHOR = "function spApptSearchRecords(query) {"
assert ANCHOR in s
GRID = r"""
// ══════════════════════════════════════════════════════════════════════════
//  APPOINTMENT TIME -- TAP GRID, NOT A SCROLL WHEEL
//  2026-07-28: reps set these on a tablet standing in a kitchen. A native
//  <input type="time"> is a scroll wheel per segment and it is the single
//  most complained-about control in the app. This is one tap. "Other" still
//  exposes the native picker for odd times.
// ══════════════════════════════════════════════════════════════════════════
var SP_APPT_SLOTS = ['06:30','07:00','07:30','08:00','08:30','09:00','09:30','10:00',
                     '10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00',
                     '14:30','15:00','15:30','16:00','16:30','17:00','17:30','18:00'];

function spApptFmt12(hhmm) {
  if (!hhmm) return '';
  var p = hhmm.split(':'), h = parseInt(p[0], 10), m = p[1];
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ' ' + ap;
}

function spApptTimeGridHtml(initial) {
  var cells = SP_APPT_SLOTS.map(function (t) {
    var on = (t === initial);
    return '<button type="button" data-slot="' + t + '" onclick="spApptPickSlot(this)" ' +
      'style="padding:11px 4px;border:1.5px solid ' + (on ? '#C8102E' : '#D7DBE0') + ';' +
      'background:' + (on ? '#C8102E' : '#fff') + ';color:' + (on ? '#fff' : '#333') + ';' +
      'border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">' +
      spApptFmt12(t) + '</button>';
  }).join('');
  return '<div id="spApptTimeWrap">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">' +
      '<label style="font-size:11px;font-weight:700;color:#5A616B;text-transform:uppercase;letter-spacing:.06em">Time</label>' +
      '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#6B7280;cursor:pointer">' +
        '<input type="checkbox" id="spApptFlexTime" onchange="spApptToggleFlex(this)"> Flexible</label>' +
    '</div>' +
    '<input type="hidden" id="spApptTime" value="' + initial + '">' +
    '<div id="spApptSlotGrid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">' + cells + '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:7px">' +
      '<button type="button" onclick="spApptShowOtherTime()" style="border:1.5px dashed #B6BCC4;background:#fff;' +
        'color:#5A616B;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer">Other time</button>' +
      '<input type="time" id="spApptTimeOther" onchange="spApptPickOther(this.value)" ' +
        'style="display:none;flex:1;border:1.5px solid #D7DBE0;border-radius:7px;padding:8px 10px;font-size:13px">' +
    '</div>' +
  '</div>';
}

function spApptPickSlot(btn) {
  var grid = document.getElementById('spApptSlotGrid');
  if (grid) Array.prototype.forEach.call(grid.children, function (b) {
    b.style.background = '#fff'; b.style.color = '#333'; b.style.borderColor = '#D7DBE0';
  });
  btn.style.background = '#C8102E'; btn.style.color = '#fff'; btn.style.borderColor = '#C8102E';
  var h = document.getElementById('spApptTime'); if (h) h.value = btn.dataset.slot;
  var o = document.getElementById('spApptTimeOther'); if (o) { o.style.display = 'none'; o.value = ''; }
}

function spApptShowOtherTime() {
  var o = document.getElementById('spApptTimeOther');
  if (!o) return;
  o.style.display = 'block';
  try { o.focus(); if (o.showPicker) o.showPicker(); } catch (e) {}
}

function spApptPickOther(v) {
  if (!v) return;
  var h = document.getElementById('spApptTime'); if (h) h.value = v;
  var grid = document.getElementById('spApptSlotGrid');
  if (grid) Array.prototype.forEach.call(grid.children, function (b) {
    var on = (b.dataset.slot === v);
    b.style.background = on ? '#C8102E' : '#fff';
    b.style.color = on ? '#fff' : '#333';
    b.style.borderColor = on ? '#C8102E' : '#D7DBE0';
  });
}

function spApptToggleFlex(cb) {
  var grid = document.getElementById('spApptSlotGrid');
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
  setTimeout(function () {
    var loc = document.getElementById('spApptLocation');
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

"""
s = s.replace(ANCHOR, GRID + ANCHOR, 1)

# Call the wiring right after the modal is injected.
INJ = "  document.body.insertAdjacentHTML('beforeend', modalHTML);"
assert INJ in s
s = s.replace(INJ, INJ + "\n  spApptWireLookups();", 1)

assert s != orig
io.open(p, 'w', encoding='utf-8').write(s)
print('appointment modal rebuilt: tap grid + address autocomplete')
