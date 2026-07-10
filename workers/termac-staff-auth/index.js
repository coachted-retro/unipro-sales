/**
 * termac-staff-auth — Termac One
 * Deployed: 2026-07-10
 *
 * Real per-person staff login: email + password, provisioned by an admin
 * with a temp password, forced reset on first login, standard reset flow
 * after that. Replaces the placeholder PIN/name-dropdown auth that's been
 * flagged as placeholder-only since the platform's early build.
 *
 * Direct D1 binding (env.DB), not routed through unipro-ai-proxy -- auth
 * needs custom logic (password hashing, constant-time comparison) that
 * doesn't fit the generic REST CRUD pattern the other tables use, and
 * keeping it isolated is a reasonable security boundary on its own.
 *
 * Endpoints:
 *   POST /provision      { email, name, role, provisionedBy }
 *   POST /login           { email, password }
 *   POST /reset-request   { email }
 *   POST /reset-confirm   { email, code, newPassword }
 *   POST /change-password { email, currentPassword, newPassword }
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

async function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function sendEmail(env, recipientName, recipientEmail, subjectNote, notes) {
  try {
    await env.NOTIFY_SERVICE.fetch('https://termac-notify.termac-one.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientName, recipientEmail,
        caller: 'Termac One', notes,
        source: subjectNote, loggedBy: 'termac-staff-auth',
      }),
    });
  } catch (e) { /* account creation should not fail just because the email did */ }
}

async function handleProvision(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  const role = (body.role || '').trim();
  if (!email || !name) return jsonResponse({ ok: false, error: 'Email and name are required.' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM staff_auth WHERE email = ?').bind(email).first();
  if (existing) return jsonResponse({ ok: false, error: 'An account already exists for this email.' }, 409);

  const tempPassword = generateTempPassword();
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);
  const id = 'STF_' + Date.now().toString(36).toUpperCase() + '_' + randomHex(3);

  await env.DB.prepare(
    'INSERT INTO staff_auth (id, email, name, role, password_hash, salt, must_reset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
  ).bind(id, email, name, role, hash, salt, 'active', Date.now(), Date.now()).run();

  await sendEmail(env, name, email, 'Termac One Account Created',
    'Your Termac One login is ready. Email: ' + email + '. Temporary password: ' + tempPassword +
    '. You will be asked to set your own password the first time you log in.');

  return jsonResponse({ ok: true, id, tempPassword });
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

  return jsonResponse({
    ok: true,
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
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
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/provision': return await handleProvision(request, env);
        case '/login': return await handleLogin(request, env);
        case '/reset-request': return await handleResetRequest(request, env);
        case '/reset-confirm': return await handleResetConfirm(request, env);
        case '/change-password': return await handleChangePassword(request, env);
        default: return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Server error.' }, 500);
    }
  },
};
