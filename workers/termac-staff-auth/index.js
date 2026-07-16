/**
 * termac-staff-auth — Termac One
 * Deployed: 2026-07-10
 *
 * Real per-person staff login: email + password, provisioned by an admin
 * with a temp password, forced reset on first login, standard reset flow
 * after that. Replaces the placeholder PIN/name-dropdown auth that's been
 * flagged as placeholder-only since the platform's early build.
 *
 * Access is multi-portal via a checkbox grid in HR Manager's Employee
 * Directory (the single source of truth -- no separate account list),
 * not one role = one portal. `portals` is a JSON array of portal keys
 * per person; employee-portal.html reads it to decide which tiles to
 * show after login. When HR marks someone Terminated, that same
 * Directory calls /revoke-by-email so their login dies with their
 * employment status, not as a separate manual step.
 *
 * Direct D1 binding (env.DB), not routed through unipro-ai-proxy -- auth
 * needs custom logic (password hashing, constant-time comparison) that
 * doesn't fit the generic REST CRUD pattern the other tables use, and
 * keeping it isolated is a reasonable security boundary on its own.
 *
 * Endpoints:
 *   POST /provision       { email, name, role, portals[], provisionedBy }
 *   POST /login            { email, password }
 *   POST /reset-request    { email }
 *   POST /reset-confirm    { email, code, newPassword }
 *   POST /change-password  { email, currentPassword, newPassword }
 *   GET  /list
 *   POST /revoke           { id }
 *   POST /reactivate       { id }
 *   POST /revoke-by-email  { email }
 *   POST /update-access    { id, portals[], role? }
 *   GET  /my-access?email=
 *
 * Passwords are never stored in plaintext or logged. Hashed with PBKDF2-
 * SHA256 (100,000 iterations, random 16-byte salt per user) via the
 * platform's built-in Web Crypto API -- no external dependency needed.
 */

const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function randomHex(byteLength) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(derived);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function generateTempPassword() {
  // Avoids visually ambiguous characters (0/O, 1/l/I) since this gets
  // typed by hand off an email on a phone.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 10; i++) out += chars[arr[i] % chars.length];
  return out;
}

function generateResetCode() {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const n = (arr[0] << 24 | arr[1] << 16 | arr[2] << 8 | arr[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

// 2026-07-13, per Ted: "not a generic page -- a direct link to their
// dashboard, specifically." This MUST stay in sync with PORTAL_META and
// DIVISION_SLUG in employee-portal.html -- that file is the single source
// of truth for which portal key maps to which URL and how a division name
// becomes a gm-dashboard.html slug. If a portal or division is ever added
// there, mirror it here too, or invite links will point at the wrong page
// (or the old generic one) while the tile chooser is already correct.
// 2026-07-16 per Ted: this map used to be hand-duplicated in
// staff-login.html too, which is exactly the kind of drift risk that
// caused real login/routing problems -- if one copy got edited without
// the other, invite links and actual post-login redirects could
// silently disagree. This is now the ONLY copy; handleLogin() below
// returns the resolved destination directly in the /login response, and
// staff-login.html just uses it instead of recomputing its own.
// Added `hr` here after finding two real provisioned accounts
// (Terence O'Reilly, Jim Kennedy) already carry an `hr` portal that had
// no dashboard mapped at all -- not currently visible since both have
// several other portals too, but a real gap waiting for the first
// HR-only account. Matches employee-portal.html's own HR tile link.
const PORTAL_URLS = {
  sales_rep: 'sales-portal.html',
  dms: 'dms-portal.html',
  reception: 'reception-portal.html',
  scheduler: 'scheduler-v2.html',
  dispatch: 'dispatch-v2.html',
  tech: 'tech-portal-unified.html',
  warehouse: 'warehouse-portal.html',
  manager: 'termac-os.html',
  admin: 'termac-os.html',
  gm_dashboard: 'gm-dashboard.html',
  hr: 'hr-portal.html',
};
const DIVISION_SLUG = {
  'UniPro': 'unipro', 'AllPro': 'allpro', 'Quality III': 'quality3',
  'Filter Man': 'filterman', 'GTO': 'gto', 'Termac': 'termac',
};

// One clear job role -> one direct dashboard link, full stop. Only people
// with several genuinely different portals and no single "home" (or full
// platform access, which is its own kind of home) land on the personalized
// tile chooser -- that's a real destination in its own right, not a
// fallback shrug, since it's built from this exact same person's granted
// access rather than a blank login form.
function resolveDestinationUrl(role, division, portals) {
  const list = Array.isArray(portals) ? portals : [];
  const fullAccess = role === 'admin' || role === 'owner' || list.indexOf('admin') !== -1;
  if (fullAccess) return 'employee-portal.html';
  if (list.indexOf('gm_dashboard') !== -1) {
    const slug = DIVISION_SLUG[division || ''];
    return slug ? ('gm-dashboard.html?division=' + slug) : 'gm-dashboard.html';
  }
  if (list.length === 1 && PORTAL_URLS[list[0]]) return PORTAL_URLS[list[0]];
  return 'employee-portal.html';
}

// Builds the actual link that goes in invite/resend emails: the login
// page, carrying this person's resolved destination as ?dest= so
// staff-login.html can bounce them straight there once they're signed in,
// instead of leaving them on a generic page to figure out on their own.
function buildLoginUrl(role, division, portals) {
  const dest = resolveDestinationUrl(role, division, portals);
  return 'https://my.termac.com/staff-login.html?dest=' + encodeURIComponent(dest);
}

async function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// Returns true only if termac-notify confirms the email actually sent
// (it checks the real Resend API response). Account creation never fails
// just because the email did -- callers decide what to tell the user.
async function sendEmail(env, recipientName, recipientEmail, subjectNote, notes) {
  try {
    const res = await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientName, recipientEmail,
        caller: 'Termac One', notes,
        source: subjectNote, loggedBy: 'termac-staff-auth',
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.emailSent === true;
  } catch (e) {
    return false;
  }
}

async function handleProvision(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  const role = (body.role || '').trim();
  const division = (body.division || '').trim();
  const portals = Array.isArray(body.portals) ? body.portals : [];
  if (!email || !name) return jsonResponse({ ok: false, error: 'Email and name are required.' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM staff_auth WHERE email = ?').bind(email).first();
  if (existing) return jsonResponse({ ok: false, error: 'An account already exists for this email.' }, 409);

  const tempPassword = generateTempPassword();
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);
  const id = 'STF_' + Date.now().toString(36).toUpperCase() + '_' + randomHex(3);

  await env.DB.prepare(
    'INSERT INTO staff_auth (id, email, name, role, division, portals, password_hash, salt, must_reset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
  ).bind(id, email, name, role, division, JSON.stringify(portals), hash, salt, 'active', Date.now(), Date.now()).run();

  const LOGIN_URL = buildLoginUrl(role, division, portals);
  const emailSent = await sendEmail(env, name, email, 'Termac One Account Created',
    'Your Termac One login is ready. Sign in at ' + LOGIN_URL + ' using this email address, ' + email +
    ', and this temporary password: ' + tempPassword +
    '. You will be asked to set your own password the first time you log in.');

  return jsonResponse({ ok: true, id, tempPassword, emailSent });
}

async function handleLogin(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password) return jsonResponse({ ok: false, error: 'Email and password are required.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user || user.status !== 'active') return jsonResponse({ ok: false, error: 'Invalid email or password.' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!constantTimeEqual(hash, user.password_hash)) {
    return jsonResponse({ ok: false, error: 'Invalid email or password.' }, 401);
  }

  await env.DB.prepare('UPDATE staff_auth SET last_login_at = ? WHERE id = ?').bind(Date.now(), user.id).run();

  let portals = [];
  try { portals = JSON.parse(user.portals || '[]'); } catch (e) {}

  // 2026-07-16 per Ted: this is the actual fix for the login-routing
  // reliability problem. dest is computed here, server-side, using the
  // exact same resolveDestinationUrl() this file already uses to build
  // invite links -- one function, one place, used for both. The client
  // (staff-login.html) just uses this value directly instead of keeping
  // its own separate copy of PORTAL_URLS that could silently drift out
  // of sync with this one.
  const dest = resolveDestinationUrl(user.role, user.division, portals);

  return jsonResponse({
    ok: true,
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    division: user.division || '',
    portals: portals,
    dest: dest,
    mustReset: !!user.must_reset,
  });
}

async function handleResetRequest(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return jsonResponse({ ok: false, error: 'Email is required.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  // Always return ok, even if no account exists -- don't reveal which
  // emails are registered.
  if (!user || user.status !== 'active') return jsonResponse({ ok: true });

  const code = generateResetCode();
  await env.DB.prepare('UPDATE staff_auth SET reset_code = ?, reset_code_expires = ? WHERE id = ?')
    .bind(code, Date.now() + 15 * 60 * 1000, user.id).run();

  await sendEmail(env, user.name, user.email, 'Termac One Password Reset',
    'Your password reset code is: ' + code + '. It expires in 15 minutes. If you did not request this, ignore this message.');

  return jsonResponse({ ok: true });
}

async function handleResetConfirm(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  const newPassword = body.newPassword || '';
  if (!email || !code || !newPassword) return jsonResponse({ ok: false, error: 'Email, code, and new password are required.' }, 400);
  if (newPassword.length < 8) return jsonResponse({ ok: false, error: 'New password must be at least 8 characters.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user || !user.reset_code || !constantTimeEqual(code, user.reset_code)) {
    return jsonResponse({ ok: false, error: 'Invalid or expired code.' }, 401);
  }
  if (!user.reset_code_expires || Date.now() > user.reset_code_expires) {
    return jsonResponse({ ok: false, error: 'That code has expired. Request a new one.' }, 401);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  await env.DB.prepare(
    'UPDATE staff_auth SET password_hash = ?, salt = ?, must_reset = 0, reset_code = NULL, reset_code_expires = NULL, updated_at = ? WHERE id = ?'
  ).bind(hash, salt, Date.now(), user.id).run();

  return jsonResponse({ ok: true });
}

async function handleChangePassword(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const currentPassword = body.currentPassword || '';
  const newPassword = body.newPassword || '';
  if (!email || !currentPassword || !newPassword) return jsonResponse({ ok: false, error: 'All fields are required.' }, 400);
  if (newPassword.length < 8) return jsonResponse({ ok: false, error: 'New password must be at least 8 characters.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user) return jsonResponse({ ok: false, error: 'Account not found.' }, 404);

  const currentHash = await hashPassword(currentPassword, user.salt);
  if (!constantTimeEqual(currentHash, user.password_hash)) {
    return jsonResponse({ ok: false, error: 'Current password is incorrect.' }, 401);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  await env.DB.prepare(
    'UPDATE staff_auth SET password_hash = ?, salt = ?, must_reset = 0, updated_at = ? WHERE id = ?'
  ).bind(hash, salt, Date.now(), user.id).run();

  return jsonResponse({ ok: true });
}

// 2026-07-10: dedicated safe list endpoint for the admin provisioning UI.
// Deliberately NOT routed through unipro-ai-proxy's generic REST CRUD --
// that proxy returns every column of whatever table it's asked for, and
// staff_auth has password_hash/salt/reset_code columns that must never
// reach a browser. This explicitly selects only the safe columns.
async function handleList(env) {
  const result = await env.DB.prepare(
    'SELECT id, email, name, role, portals, must_reset, status, created_at, last_login_at FROM staff_auth ORDER BY created_at DESC'
  ).all();
  const rows = (result.results || []).map(r => {
    let portals = [];
    try { portals = JSON.parse(r.portals || '[]'); } catch (e) {}
    return Object.assign({}, r, { portals });
  });
  return jsonResponse({ ok: true, results: rows });
}

async function handleRevoke(request, env) {
  const body = await request.json();
  const id = (body.id || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'Account id is required.' }, 400);
  await env.DB.prepare('UPDATE staff_auth SET status = ?, updated_at = ? WHERE id = ?')
    .bind('revoked', Date.now(), id).run();
  return jsonResponse({ ok: true });
}

async function handleReactivate(request, env) {
  const body = await request.json();
  const id = (body.id || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'Account id is required.' }, 400);
  await env.DB.prepare('UPDATE staff_auth SET status = ?, updated_at = ? WHERE id = ?')
    .bind('active', Date.now(), id).run();
  return jsonResponse({ ok: true });
}

// 2026-07-10: called by HR Manager's Employee Directory when someone's
// status changes to Terminated/Inactive. Looks up by email since HR's
// employee record and this login record are linked by email, not a
// shared id -- HR doesn't need to know a staff_auth id exists at all.
// Silently succeeds if no matching login exists (most terminated people
// may never have had one), so HR's status-change flow never breaks on
// this call failing.
async function handleRevokeByEmail(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return jsonResponse({ ok: false, error: 'Email is required.' }, 400);
  await env.DB.prepare('UPDATE staff_auth SET status = ?, updated_at = ? WHERE email = ?')
    .bind('revoked', Date.now(), email).run();
  return jsonResponse({ ok: true });
}

// Updates name/role/portals for an existing account -- the checkbox
// access grid in the Employee Directory calls this every time someone's
// permissions change. Does not touch password/status.
async function handleUpdateAccess(request, env) {
  const body = await request.json();
  const id = (body.id || '').trim();
  const portals = Array.isArray(body.portals) ? body.portals : [];
  const role = body.role !== undefined ? String(body.role).trim() : null;
  if (!id) return jsonResponse({ ok: false, error: 'Account id is required.' }, 400);

  if (role !== null) {
    await env.DB.prepare('UPDATE staff_auth SET portals = ?, role = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(portals), role, Date.now(), id).run();
  } else {
    await env.DB.prepare('UPDATE staff_auth SET portals = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(portals), Date.now(), id).run();
  }
  return jsonResponse({ ok: true });
}

// Self-service resend, callable any number of times -- no need to delete
// and re-provision the account by hand. Generates a brand new temp
// password (the old one, sent or not, is dead the moment this runs),
// flips must_reset back on so they're forced to set their own password
// again, and sends the same invite email provisioning does.
async function handleResendInvite(request, env) {
  const body = await request.json();
  const id = (body.id || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'Account id is required.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE id = ?').bind(id).first();
  if (!user) return jsonResponse({ ok: false, error: 'Account not found.' }, 404);

  const tempPassword = generateTempPassword();
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);

  await env.DB.prepare(
    'UPDATE staff_auth SET password_hash = ?, salt = ?, must_reset = 1, status = ?, updated_at = ? WHERE id = ?'
  ).bind(hash, salt, 'active', Date.now(), id).run();

  let userPortals = [];
  try { userPortals = JSON.parse(user.portals || '[]'); } catch (e) {}
  const LOGIN_URL = buildLoginUrl(user.role, user.division, userPortals);
  const emailSent = await sendEmail(env, user.name, user.email, 'Termac One Login Resent',
    'Your Termac One login was resent. Sign in at ' + LOGIN_URL + ' using this email address, ' + user.email +
    ', and this temporary password: ' + tempPassword +
    '. You will be asked to set your own password the first time you log in.');

  return jsonResponse({ ok: true, tempPassword, emailSent });
}

// Lightweight lookup for employee-portal.html to decide which tiles to
// show for the currently logged-in person, without exposing the full
// account list (handleList) to every employee.
async function handleMyAccess(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return jsonResponse({ ok: false, error: 'Email is required.' }, 400);

  const user = await env.DB.prepare('SELECT portals, status, division, role FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user || user.status !== 'active') return jsonResponse({ ok: true, portals: [], active: false });

  let portals = [];
  try { portals = JSON.parse(user.portals || '[]'); } catch (e) {}
  return jsonResponse({ ok: true, portals: portals, active: true, division: user.division || '', role: user.role || 'employee' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (request.method !== 'POST' && request.url.indexOf('/list') === -1 && request.url.indexOf('/my-access') === -1) {
      return jsonResponse({ ok: false, error: 'POST only' }, 405);
    }

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/provision': return await handleProvision(request, env);
        case '/login': return await handleLogin(request, env);
        case '/reset-request': return await handleResetRequest(request, env);
        case '/reset-confirm': return await handleResetConfirm(request, env);
        case '/change-password': return await handleChangePassword(request, env);
        case '/list': return await handleList(env);
        case '/revoke': return await handleRevoke(request, env);
        case '/reactivate': return await handleReactivate(request, env);
        case '/revoke-by-email': return await handleRevokeByEmail(request, env);
        case '/update-access': return await handleUpdateAccess(request, env);
        case '/resend-invite': return await handleResendInvite(request, env);
        case '/my-access': return await handleMyAccess(request, env);
        default: return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Server error.' }, 500);
    }
  },
};
