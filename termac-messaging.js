/* ============================================================
   Termac One — Unified Messaging (single module, every portal)
   One Messages surface across tech, sales, scheduler, dispatch,
   reception, delivery, and the management dashboard. Reads and
   writes the SAME store the existing chat already uses:
     - Cloudflare KV worker (cross-device delivery + polling)
     - localStorage fallback (key: termac_chat_messages)
   so it interoperates with anything already written. Channels are
   shared; direct messages use a canonical room id so both people
   land in the same thread. Visually distinct from the Ask AI pill:
   Messages lives bottom-LEFT, the assistant lives bottom-RIGHT.
   At go-live this same module is what gets repointed to mirror
   into Teams via Graph / Power Automate — one place to change.
   ============================================================ */
(function () {
  'use strict';
  if (window.__termacMessaging) return;
  window.__termacMessaging = true;

  var WORKER = 'https://cms-cors-proxy.tedscholl.workers.dev';
  var LS_KEY = 'termac_chat_messages';
  var SEEN_KEY = 'termac_chat_seen';

  var CHANNELS = [
    { id: 'all',        name: 'All Staff',    desc: 'Company-wide' },
    { id: 'sales',      name: 'Sales Team',   desc: 'Reps & territory' },
    { id: 'dms',        name: 'DMS Team',     desc: 'Cold call & outreach' },
    { id: 'unipro',     name: 'UniPro Techs', desc: 'Fire & suppression field' },
    { id: 'scheduling', name: 'Scheduling',   desc: 'Jobs & routes' },
    { id: 'dispatch',   name: 'Dispatch',     desc: 'Driver coordination' },
    { id: 'office',     name: 'Office',       desc: 'Quotes, billing, admin' },
  ];
  var STAFF = ['Ted Scholl','Tom Pittakas','TJ O\'Reilly','Brad Fickes','Dan Rini',
    'Chrystal Bush','Tara Colona','Amanda McGowan','Gina Kluge','Kim Reinhart','Donna Meyer',
    'Paul Brahan','Jim Kennedy','Dennis Muracco','Lexi Cranfield',
    'Aine Curran','Jasmine Paez','Samuel Holmes',
    'Marcus Williams','Jake Torres','Priya Nair','Sam Chen','Derek Walsh'];

  function whoAmI() {
    try {
      if (window._spRep && _spRep.name)   return { name: _spRep.name,   role: 'Sales Rep' };
      if (window._dmsUser && _dmsUser.name) return { name: _dmsUser.name, role: 'DMS' };
      if (window._rcpUser && _rcpUser.name) return { name: _rcpUser.name, role: 'Reception' };
      if (window._tech)    return { name: (_tech.name || _tech), role: 'Tech' };
      if (window.currentTech) return { name: (currentTech.name || currentTech), role: 'Tech' };
      if (window._driver)  return { name: _driver, role: 'Driver' };
      if (window._currentUser && _currentUser.name) return { name: _currentUser.name, role: _currentUser.role || 'Staff' };
      var n = localStorage.getItem('termac_current_user'); if (n) return { name: n, role: 'Staff' };
    } catch (e) {}
    return { name: 'Staff', role: 'Staff' };
  }
  function dmRoom(other) { var me = whoAmI().name; return 'dm:' + [me, other].sort().join(' & '); }

  var S = { open: false, room: 'all', msgs: {}, poll: null, badgePoll: null };

  function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function lsSet(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} }
  function seenGet() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) { return {}; } }
  function seenSet(o) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(o)); } catch (e) {} }

  async function load(room) {
    try {
      var r = await fetch(WORKER + '/chat/' + encodeURIComponent(room));
      if (r.ok) { var d = await r.json(); S.msgs[room] = d.messages || []; var ls = lsGet(); ls[room] = S.msgs[room].slice(-200); lsSet(ls); return S.msgs[room]; }
    } catch (e) {}
    var ls = lsGet(); S.msgs[room] = ls[room] || []; return S.msgs[room];
  }
  async function send(room, text) {
    var me = whoAmI(); var msg = { ts: Date.now(), sender: me.name, role: me.role, text: text };
    var arr = S.msgs[room] || []; arr.push(msg); S.msgs[room] = arr;
    var ls = lsGet(); ls[room] = arr.slice(-200); lsSet(ls);
    try { await fetch(WORKER + '/chat/' + encodeURIComponent(room), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }); } catch (e) {}
    return msg;
  }
  function roomList() {
    var me = whoAmI().name;
    var list = CHANNELS.map(function (c) { return { id: c.id, name: c.name, desc: c.desc, dm: false }; });
    STAFF.filter(function (n) { return n !== me; }).forEach(function (n) { list.push({ id: dmRoom(n), name: n, desc: 'Direct message', dm: true }); });
    return list;
  }

  function el(t, s, x) { var e = document.createElement(t); if (s) Object.assign(e.style, s); if (x != null) e.textContent = x; return e; }
  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }

  var launcher, badge, panel, roomsCol, thread, input, title;

  function unreadTotal() {
    var seen = seenGet(); var total = 0;
    Object.keys(S.msgs).forEach(function (room) {
      var last = (S.msgs[room] || []).filter(function (m) { return m.sender !== whoAmI().name; }).slice(-1)[0];
      if (last && last.ts > (seen[room] || 0)) total++;
    });
    return total;
  }
  function refreshBadge() { var n = unreadTotal(); if (badge) { badge.textContent = n > 9 ? '9+' : String(n); badge.style.display = n ? 'inline-block' : 'none'; } }

  function renderRooms() {
    roomsCol.innerHTML = '';
    var seen = seenGet();
    roomsCol.appendChild(el('div', { padding: '8px 12px 4px', fontSize: '10px', fontWeight: '800', letterSpacing: '.08em', color: '#94A3B8', textTransform: 'uppercase' }, 'Channels'));
    roomList().forEach(function (r, i) {
      if (i === CHANNELS.length) roomsCol.appendChild(el('div', { padding: '10px 12px 4px', fontSize: '10px', fontWeight: '800', letterSpacing: '.08em', color: '#94A3B8', textTransform: 'uppercase' }, 'Direct'));
      var active = r.id === S.room;
      var row = el('div', { padding: '9px 12px', cursor: 'pointer', fontSize: '13px', borderLeft: active ? '3px solid #334155' : '3px solid transparent', background: active ? '#F1F5F9' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' });
      row.appendChild(el('span', { fontWeight: r.dm ? '500' : '700', color: '#1E293B', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, (r.dm ? '' : '# ') + r.name));
      var last = (S.msgs[r.id] || []).filter(function (m) { return m.sender !== whoAmI().name; }).slice(-1)[0];
      if (last && last.ts > (seen[r.id] || 0)) row.appendChild(el('span', { width: '8px', height: '8px', borderRadius: '50%', background: '#C8102E', flexShrink: '0' }));
      row.onclick = function () { openRoom(r.id, r.name); };
      roomsCol.appendChild(row);
    });
  }
  function renderThread() {
    var me = whoAmI().name; var arr = S.msgs[S.room] || [];
    thread.innerHTML = '';
    if (!arr.length) { thread.appendChild(el('div', { textAlign: 'center', color: '#94A3B8', fontSize: '13px', padding: '24px' }, 'No messages yet. Say hello.')); return; }
    arr.forEach(function (m) {
      var mine = m.sender === me;
      var wrap = el('div', { display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: '8px' });
      if (!mine) wrap.appendChild(el('div', { fontSize: '10px', color: '#64748B', margin: '0 4px 2px', fontWeight: '700' }, m.sender + (m.role ? ' · ' + m.role : '')));
      var b = el('div', { maxWidth: '78%', padding: '8px 11px', borderRadius: '12px', fontSize: '13px', lineHeight: '1.35', background: mine ? '#334155' : '#F1F5F9', color: mine ? '#fff' : '#1E293B', wordBreak: 'break-word' }, m.text);
      wrap.appendChild(b);
      wrap.appendChild(el('div', { fontSize: '9px', color: '#94A3B8', margin: '2px 4px 0' }, fmtTime(m.ts)));
      thread.appendChild(wrap);
    });
    thread.scrollTop = thread.scrollHeight;
  }
  function markSeen() { var seen = seenGet(); var arr = S.msgs[S.room] || []; if (arr.length) seen[S.room] = arr[arr.length - 1].ts; seenSet(seen); refreshBadge(); }

  async function openRoom(id, name) {
    S.room = id; title.textContent = (id.indexOf('dm:') === 0 ? name : '# ' + name);
    renderRooms();
    await load(id); renderThread(); markSeen();
  }

  function buildUI() {
    // Launcher: bottom-LEFT, slate, labeled — distinct from the indigo Ask AI pill (bottom-right)
    launcher = el('button', { position: 'fixed', left: '20px', bottom: '20px', zIndex: '99990', padding: '0 16px', height: '48px', borderRadius: '24px', border: 'none', background: '#334155', color: '#fff', fontSize: '14px', fontWeight: '800', boxShadow: '0 6px 20px rgba(15,23,42,.35)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', fontFamily: '-apple-system,Segoe UI,Roboto,sans-serif' });
    launcher.innerHTML = '<span style="font-size:18px">\uD83D\uDCAC</span><span>Messages</span>';
    launcher.title = 'Team Messages';
    badge = el('span', { display: 'none', minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: '9px', background: '#C8102E', color: '#fff', fontSize: '11px', fontWeight: '900', lineHeight: '18px', textAlign: 'center', marginLeft: '2px' });
    launcher.appendChild(badge);
    launcher.onclick = toggle;

    panel = el('div', { position: 'fixed', left: '20px', bottom: '80px', zIndex: '99991', width: 'min(640px,94vw)', height: 'min(560px,74vh)', background: '#fff', borderRadius: '16px', boxShadow: '0 16px 48px rgba(0,0,0,.32)', display: 'none', overflow: 'hidden', border: '1px solid #E2E8F0', fontFamily: '-apple-system,Segoe UI,Roboto,sans-serif' });
    var head = el('div', { height: '52px', background: '#0F172A', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', flexShrink: '0' });
    title = el('div', { fontWeight: '800', fontSize: '15px' }, '# All Staff');
    var hx = el('button', { border: 'none', background: 'transparent', color: '#fff', fontSize: '20px', cursor: 'pointer' }, '\u2715');
    hx.onclick = toggle; head.appendChild(title); head.appendChild(hx);

    var body = el('div', { display: 'flex', height: 'calc(100% - 52px)' });
    roomsCol = el('div', { width: '190px', borderRight: '1px solid #E2E8F0', overflowY: 'auto', flexShrink: '0', background: '#FAFBFC' });
    var main = el('div', { flex: '1', display: 'flex', flexDirection: 'column', minWidth: '0' });
    thread = el('div', { flex: '1', overflowY: 'auto', padding: '14px' });
    var bar = el('div', { display: 'flex', gap: '6px', padding: '10px', borderTop: '1px solid #E2E8F0', background: '#F8FAFC' });
    input = el('input', { flex: '1', padding: '10px', border: '1px solid #CBD5E1', borderRadius: '10px', fontSize: '14px' });
    input.placeholder = 'Message the team...';
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSend(); });
    var go = el('button', { padding: '0 16px', border: 'none', borderRadius: '10px', background: '#334155', color: '#fff', fontWeight: '700', cursor: 'pointer' }, 'Send');
    go.onclick = doSend;
    bar.appendChild(input); bar.appendChild(go);
    main.appendChild(thread); main.appendChild(bar);
    body.appendChild(roomsCol); body.appendChild(main);
    panel.appendChild(head); panel.appendChild(body);

    document.body.appendChild(launcher); document.body.appendChild(panel);

    // Retire the legacy red bubble everywhere this loads
    var st = document.createElement('style');
    st.textContent = '#tcFab,#tcPanel,#tcBadge{display:none!important}';
    document.head.appendChild(st);
  }

  async function doSend() {
    var v = input.value.trim(); if (!v) return; input.value = '';
    await send(S.room, v); renderThread(); markSeen(); renderRooms();
  }
  async function toggle() {
    S.open = !S.open; panel.style.display = S.open ? 'block' : 'none';
    if (S.open) { await openRoom(S.room, (CHANNELS.find(function (c) { return c.id === S.room; }) || {}).name || S.room);
      if (S.poll) clearInterval(S.poll);
      S.poll = setInterval(async function () { if (S.open) { await load(S.room); renderThread(); markSeen(); } }, 4000);
    } else if (S.poll) { clearInterval(S.poll); S.poll = null; }
  }
  async function badgeSweep() {
    // Light background poll for the unread badge: All Staff + my channel + my DMs-in-history
    var me = whoAmI().name;
    var watch = ['all'];
    var ls = lsGet(); Object.keys(ls).forEach(function (r) { if (r.indexOf('dm:') === 0 && r.indexOf(me) >= 0) watch.push(r); });
    for (var i = 0; i < watch.length; i++) { try { await load(watch[i]); } catch (e) {} }
    refreshBadge();
  }

  function init() {
    buildUI();
    badgeSweep();
    S.badgePoll = setInterval(badgeSweep, 15000);
    window.termacMessaging = { open: function () { if (!S.open) toggle(); }, openRoom: openRoom, whoAmI: whoAmI };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
