/* ═══════════════════════════════════════════════════════════════
   TERMAC ONE — INTERNAL MESSAGING SYSTEM
   Group channels + Direct Messages
   Storage: D1 (messages table via unipro-ai-proxy) -> localStorage
   (offline read cache only, not a write fallback)

   Drop-in include: <script src="termac-chat.js"></script>
   Self-initializing (runs on DOMContentLoaded), injects its own CSS
   and HTML (a floating Team Messages button + panel), so no other
   markup changes are needed on the host page.
═══════════════════════════════════════════════════════════════ */

(function() {
'use strict';

// ── CONFIG ───────────────────────────────────────────────────
const D1_API_URL = 'https://unipro-ai-proxy.termac-one.workers.dev';
const D1_API_SECRET = 'termac2026';
const LS_KEY     = 'termac_chat_messages';
const POLL_MS    = 8000; // poll for new messages every 8 seconds

const CHANNELS = [
  { id:'all',        name:'All Staff',     icon:'📢', desc:'Company-wide announcements' },
  { id:'sales',      name:'Sales Team',    icon:'📊', desc:'Reps & territory updates' },
  { id:'dms',        name:'DMS Team',      icon:'📋', desc:'Cold call & outreach team' },
  { id:'unipro',     name:'UniPro Techs',  icon:'🔧', desc:'Fire & suppression field team' },
  { id:'scheduling', name:'Scheduling',    icon:'🗓', desc:'Jobs, routes & dispatch' },
  { id:'dispatch',   name:'Dispatch',      icon:'🚨', desc:'Emergency & driver coordination' },
  { id:'office',     name:'Office',        icon:'🏢', desc:'Quotes, billing & admin' },
];

// All known staff for DM list
const STAFF_LIST = [
  'Ted Scholl','Tom Pittakas','TJ O\'Reilly','Brad Fickes','Dan Rini',
  'Chrystal Bush','Tara Colona','Amanda McGowan','Gina Kluge','Kim Reinhart','Donna Meyer',
  'Paul Brahan',
  'Marcus Williams','Jake Torres','Priya Nair','Sam Chen','Derek Walsh',
];

// ── STATE ────────────────────────────────────────────────────
let _chatOpen    = false;
let _activeRoom  = 'all'; // channel id or 'dm:Name'
let _currentUser = null;
let _messages    = {};    // { roomId: [msg, ...] }
let _unread      = {};    // { roomId: count }
let _pollTimer   = null;
let _lastMsgTs   = 0;

// ── DETECT CURRENT USER ──────────────────────────────────────
function detectUser() {
  // Try various globals set by each portal
  if (window._spRep)   return { name: window._spRep.name,   role: 'Sales Rep' };
  if (window._dmsUser) return { name: window._dmsUser.name, role: 'DMS' };
  if (window._rcpUser) return { name: window._rcpUser.name, role: 'Reception' };
  if (window._tech)    return { name: window._tech.name,    role: 'Tech' };
  if (window._driver)  return { name: window._driver,       role: 'Driver' };
  if (window._currentUser) return { name: window._currentUser.name, role: window._currentUser.role || 'Staff' };
  return { name: 'Staff', role: 'Staff' };
}

// ── STORAGE ──────────────────────────────────────────────────
// 2026-07-13 FIX: this previously called WORKER_URL/chat/{roomId} on
// cms-cors-proxy.termac-one.workers.dev - that worker has no /chat/
// route at all (it's an unrelated government-lead-data CORS proxy).
// Every request 400'd, the catch{} swallowed it silently, and every
// message ever sent through this widget across all 12 portals that
// had it went to localStorage only - never actually reaching any
// other device or user. Rewired to the real, already-working D1 API
// (unipro-ai-proxy) against the existing 'messages' table, same
// pattern every other CRM feature on this platform already uses.
async function loadMessages(roomId) {
  try {
    const resp = await fetch(`${D1_API_URL}/db/messages?room_id=${encodeURIComponent(roomId)}&limit=200`, {
      headers: { 'X-API-Secret': D1_API_SECRET }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok && Array.isArray(data.results)) {
        const msgs = data.results.map(r => ({
          ts: r.created_at, sender: r.sender, role: r.role || '', text: r.text
        })).sort((a, b) => a.ts - b.ts);
        _messages[roomId] = msgs;
        // Mirror to localStorage as an offline-read cache only - D1 is
        // the source of truth now, this is not a fallback write path.
        try {
          const ls = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
          ls[roomId] = msgs.slice(-200);
          localStorage.setItem(LS_KEY, JSON.stringify(ls));
        } catch(e) {}
        return msgs;
      }
    }
  } catch(e) {}
  // D1 unreachable (offline) - fall back to last-known local cache so
  // the panel still shows something instead of going blank.
  const ls = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  _messages[roomId] = ls[roomId] || [];
  return _messages[roomId];
}

async function saveMessage(roomId, msg) {
  const msgs = _messages[roomId] || [];
  msgs.push(msg);
  _messages[roomId] = msgs;

  // Save to localStorage immediately (fast, always works, offline-safe)
  const ls = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  ls[roomId] = msgs.slice(-200); // keep last 200 per room
  localStorage.setItem(LS_KEY, JSON.stringify(ls));

  // Push to D1 so it actually reaches every other device and user.
  try {
    await fetch(`${D1_API_URL}/db/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Secret': D1_API_SECRET },
      body: JSON.stringify({
        room_id: roomId,
        sender: msg.sender,
        role: msg.role || '',
        text: msg.text,
        recipient: roomId.indexOf('dm:') === 0 ? roomId.slice(3) : '',
        read_flag: 0
      })
    });
  } catch(e) {}
}

// Poll for new messages
async function pollMessages() {
  if (!_chatOpen || !_activeRoom) return;
  const msgs = await loadMessages(_activeRoom);
  const newMsgs = msgs.filter(m => m.ts > _lastMsgTs);
  if (newMsgs.length > 0) {
    renderMessages();
    _lastMsgTs = Math.max(...msgs.map(m => m.ts));
  }
}

// ── CSS ──────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('termac-chat-css')) return;
  const style = document.createElement('style');
  style.id = 'termac-chat-css';
  style.textContent = `
/* ── Chat FAB ── */
#tcFab{position:fixed;bottom:20px;right:20px;width:52px;height:52px;background:#C8102E;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 16px rgba(200,16,46,.4);z-index:8000;transition:transform .15s}
#tcFab:hover{transform:scale(1.08)}
#tcFabCompact:hover{opacity:.8}
.tc-compact-mode #tcFab{display:none!important}
.tc-compact-mode #tcFabCompact{display:flex!important}
#tcBadge{position:absolute;top:-4px;right:-4px;background:#F2B705;color:#1A1D21;border-radius:99px;padding:1px 6px;font-size:10px;font-weight:900;font-family:'Barlow Condensed',sans-serif;display:none;min-width:18px;text-align:center}

/* ── Chat Panel ── */
#tcPanel{position:fixed;bottom:82px;right:20px;width:min(420px,96vw);height:min(600px,80vh);background:#fff;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.22);z-index:8000;display:none;flex-direction:row;overflow:hidden;border:1px solid #E5E7EB}

/* ── Sidebar ── */
#tcSidebar{width:180px;background:#1A1D21;display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto}
#tcSidebarTop{padding:12px 10px;border-bottom:1px solid #2A2E33}
#tcAppName{font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:13px;letter-spacing:.10em;text-transform:uppercase;color:#F2B705}
#tcUserName{font-size:11px;color:#6B7280;margin-top:2px}
.tc-section-hdr{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#4B5563;padding:10px 10px 4px}
.tc-room-btn{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;border-radius:6px;margin:1px 6px;transition:background .1s}
.tc-room-btn:hover{background:#2A2E33}
.tc-room-btn.active{background:#C8102E}
.tc-room-icon{font-size:14px;flex-shrink:0}
.tc-room-name{font-size:12px;color:#D1D5DB;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-room-btn.active .tc-room-name{color:#fff}
.tc-room-badge{background:#F2B705;color:#1A1D21;border-radius:99px;padding:0 5px;font-size:9px;font-weight:900;min-width:16px;text-align:center}

/* ── Chat Main ── */
#tcMain{flex:1;display:flex;flex-direction:column;min-width:0}
#tcHeader{padding:10px 14px;border-bottom:1px solid #F3F4F6;display:flex;align-items:center;gap:8px;flex-shrink:0}
#tcRoomTitle{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:14px;color:#1A1D21;flex:1}
#tcRoomDesc{font-size:11px;color:#6B7280}
#tcMessages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.tc-msg{display:flex;flex-direction:column;gap:2px;max-width:88%}
.tc-msg.mine{align-self:flex-end;align-items:flex-end}
.tc-msg.theirs{align-self:flex-start}
.tc-msg-meta{font-size:10px;color:#9CA3AF;display:flex;gap:6px;align-items:center}
.tc-msg.mine .tc-msg-meta{flex-direction:row-reverse}
.tc-msg-sender{font-weight:700;color:#6B7280}
.tc-msg-bubble{padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;word-break:break-word}
.tc-msg.mine .tc-msg-bubble{background:#C8102E;color:#fff;border-bottom-right-radius:3px}
.tc-msg.theirs .tc-msg-bubble{background:#F3F4F6;color:#1A1D21;border-bottom-left-radius:3px}
.tc-msg-date-divider{text-align:center;font-size:10px;color:#9CA3AF;font-weight:600;letter-spacing:.04em;margin:4px 0}

/* ── Input ── */
#tcInputArea{padding:10px 12px;border-top:1px solid #F3F4F6;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
#tcInput{flex:1;border:1.5px solid #E5E7EB;border-radius:10px;padding:8px 12px;font-size:13px;font-family:inherit;resize:none;max-height:100px;min-height:38px;outline:none;line-height:1.4}
#tcInput:focus{border-color:#C8102E}
#tcSendBtn{background:#C8102E;color:#fff;border:none;border-radius:10px;padding:8px 14px;cursor:pointer;font-weight:700;font-size:13px;flex-shrink:0;align-self:flex-end;transition:background .1s}
#tcSendBtn:hover{background:#A30D25}
#tcEmpty{text-align:center;color:#9CA3AF;font-size:13px;padding:40px 20px;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
  `;
  document.head.appendChild(style);
}

// ── HTML ─────────────────────────────────────────────────────
function injectHTML() {
  if (document.getElementById('tcPanel')) return;
  // Compact mode: FAB hidden, small button injected into top nav bar
  if (window.TC_COMPACT_MODE) {
    document.body.classList.add('tc-compact-mode');
    // Try to inject into the existing top nav
    setTimeout(function() {
      var nav = document.querySelector('.topbar .tb-actions, .trn-inner, .nav, .topbar, header');
      var compactBtn = document.getElementById('tcFabCompact');
      if (nav && compactBtn) {
        nav.appendChild(compactBtn);
        compactBtn.style.display = 'flex';
      }
    }, 300);
  }

  const html = `
<button id="tcFab" onclick="tcToggle()" title="Team Messages">
  💬
  <span id="tcBadge"></span>
</button>
<button id="tcFabCompact" onclick="tcToggle()" title="Team Messages" style="display:none;background:none;border:none;cursor:pointer;font-size:18px;position:relative;padding:4px 8px;color:#fff;flex-shrink:0">
  💬<span id="tcBadgeCompact" style="position:absolute;top:0;right:0;background:#C8102E;color:#fff;border-radius:50%;width:16px;height:16px;font-size:9px;font-weight:700;display:none;align-items:center;justify-content:center"></span>
</button>

<div id="tcPanel">
  <!-- Sidebar -->
  <div id="tcSidebar">
    <div id="tcSidebarTop">
      <div id="tcAppName">Termac Chat</div>
      <div id="tcUserName">Loading…</div>
    </div>

    <div class="tc-section-hdr">Channels</div>
    ${CHANNELS.map(ch => `
    <div class="tc-room-btn${ch.id==='all'?' active':''}" id="tcRoom_${ch.id}" onclick="tcSelectRoom('${ch.id}','#${ch.name}','${ch.desc}')">
      <span class="tc-room-icon">${ch.icon}</span>
      <span class="tc-room-name">#${ch.name}</span>
      <span class="tc-room-badge" id="tcBadge_${ch.id}" style="display:none"></span>
    </div>`).join('')}

    <div class="tc-section-hdr">Direct Messages</div>
    <div id="tcDmList"></div>
  </div>

  <!-- Main chat area -->
  <div id="tcMain">
    <div id="tcHeader">
      <div>
        <div id="tcRoomTitle">#All Staff</div>
        <div id="tcRoomDesc">Company-wide announcements</div>
      </div>
    </div>
    <div id="tcMessages"><div id="tcEmpty"><span style="font-size:32px">💬</span>No messages yet. Say hello!</div></div>
    <div id="tcInputArea">
      <textarea id="tcInput" placeholder="Message…" rows="1"
        oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();tcSend()}"></textarea>
      <button id="tcSendBtn" onclick="tcSend()">Send</button>
    </div>
  </div>
</div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  // Build DM list
  buildDmList();
}

function buildDmList() {
  const list = document.getElementById('tcDmList');
  if (!list) return;
  const staffNames = STAFF_LIST.filter(n => n !== (_currentUser?.name || ''));
  list.innerHTML = staffNames.map(name => {
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2);
    const roomId = dmRoomId(name);
    return `<div class="tc-room-btn" id="tcRoom_dm_${name.replace(/[^a-z]/gi,'_')}" onclick="tcSelectRoom('${roomId}','${escChat(name)}','Direct message')">
      <span class="tc-room-icon" style="background:#2A2E33;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#9CA3AF;flex-shrink:0">${initials}</span>
      <span class="tc-room-name">${escChat(name)}</span>
      <span class="tc-room-badge" id="tcBadge_${roomId.replace(/[^a-z]/gi,'_')}" style="display:none"></span>
    </div>`;
  }).join('');
}

function dmRoomId(otherName) {
  const me = _currentUser?.name || 'Staff';
  const names = [me, otherName].sort();
  return 'dm:' + names.join(':');
}

function escChat(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── TOGGLE ───────────────────────────────────────────────────
window.tcToggle = function() {
  _chatOpen = !_chatOpen;
  const panel = document.getElementById('tcPanel');
  if (panel) panel.style.display = _chatOpen ? 'flex' : 'none';
  if (_chatOpen) {
    _currentUser = detectUser();
    const unEl = document.getElementById('tcUserName');
    if (unEl) unEl.textContent = _currentUser.name;
    tcSelectRoom(_activeRoom);
    if (!_pollTimer) _pollTimer = setInterval(pollMessages, POLL_MS);
  } else {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
};

// ── SELECT ROOM ──────────────────────────────────────────────
window.tcSelectRoom = async function(roomId, title, desc) {
  _activeRoom = roomId;

  // Update sidebar active state
  document.querySelectorAll('.tc-room-btn').forEach(b => b.classList.remove('active'));
  const safeId = roomId.replace(/[^a-z0-9]/gi,'_');
  const activeBtn = document.getElementById('tcRoom_' + safeId) ||
                    document.getElementById('tcRoom_' + roomId) ||
                    document.getElementById('tcRoom_dm_' + safeId);
  if (activeBtn) activeBtn.classList.add('active');

  // Update header
  const ch = CHANNELS.find(c => c.id === roomId);
  const titleEl = document.getElementById('tcRoomTitle');
  const descEl  = document.getElementById('tcRoomDesc');
  if (titleEl) titleEl.textContent = title || (ch ? '#'+ch.name : roomId);
  if (descEl)  descEl.textContent  = desc  || (ch ? ch.desc : '');

  // Clear unread
  _unread[roomId] = 0;
  updateBadges();

  // Load messages
  const msgs = document.getElementById('tcMessages');
  if (msgs) msgs.innerHTML = '<div id="tcEmpty" style="text-align:center;padding:30px;color:#9CA3AF;font-size:13px">Loading…</div>';

  await loadMessages(roomId);
  renderMessages();
  _lastMsgTs = Math.max(0, ...(_messages[roomId]||[]).map(m=>m.ts));

  // Focus input
  const inp = document.getElementById('tcInput');
  if (inp) inp.focus();
};

// ── RENDER MESSAGES ──────────────────────────────────────────
function renderMessages() {
  const container = document.getElementById('tcMessages');
  if (!container) return;
  const msgs = _messages[_activeRoom] || [];
  if (msgs.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#9CA3AF;font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px"><span style="font-size:32px">💬</span>No messages yet — say something!</div>';
    return;
  }

  const me = _currentUser?.name || 'Staff';
  let html = '';
  let lastDate = '';

  msgs.forEach(m => {
    const d = new Date(m.ts);
    const dateStr = d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if (dateStr !== lastDate) {
      html += `<div class="tc-msg-date-divider">${dateStr}</div>`;
      lastDate = dateStr;
    }
    const isMine = m.sender === me;
    const timeStr = d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    html += `<div class="tc-msg ${isMine?'mine':'theirs'}">
      <div class="tc-msg-meta">
        ${!isMine?`<span class="tc-msg-sender">${escChat(m.sender)}</span>`:''}
        <span>${timeStr}</span>
      </div>
      <div class="tc-msg-bubble">${escChat(m.text)}</div>
    </div>`;
  });

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

// ── SEND ─────────────────────────────────────────────────────
window.tcSend = async function() {
  const inp = document.getElementById('tcInput');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;

  _currentUser = detectUser();
  const msg = { ts: Date.now(), sender: _currentUser.name, role: _currentUser.role, text };

  inp.value = '';
  inp.style.height = 'auto';

  await saveMessage(_activeRoom, msg);
  renderMessages();
};

// ── BADGES ───────────────────────────────────────────────────
function updateBadges() {
  let total = 0;
  Object.entries(_unread).forEach(([room, count]) => {
    const safeId = room.replace(/[^a-z0-9]/gi,'_');
    const badge = document.getElementById('tcBadge_'+safeId) || document.getElementById('tcBadge_'+room);
    if (badge) { badge.textContent = count; badge.style.display = count ? 'block' : 'none'; }
    total += count;
  });
  const fab = document.getElementById('tcBadge');
  if (fab) { fab.textContent = total; fab.style.display = total ? 'block' : 'none'; }
}

// ── INIT ─────────────────────────────────────────────────────
function init() {
  // 2026-07-16 per Ted: pages like allpro-project-planner.html get
  // opened two ways -- standalone in their own tab (needs this widget),
  // or embedded in an iframe inside sales-portal.html (which already
  // shows its own "Messages" pill via termac-messaging.js). Loading
  // this widget in the embedded case put a second floating chat button
  // -- a red circle -- on screen at the same time as the parent's
  // pill, which is exactly the "two team message bubbles" Ted flagged.
  // Skip entirely when framed; standalone tabs are untouched.
  if (window.self !== window.top) return;
  injectCSS();
  injectHTML();
  // Load unread counts from localStorage
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  _messages = saved;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();

