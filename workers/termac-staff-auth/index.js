/**
 * termac-staff-auth — Termac One
 * Deployed: 2026-07-10, converted to SSO-only 2026-07-17
 *
 * All staff login is Microsoft Entra SSO. An employee signs in with their
 * company email address and its Microsoft password -- Microsoft verifies
 * that password, never this worker. Termac One never sees or stores a
 * password of any kind. This replaced the July-10 local email+password
 * system (temp password, forced reset, self-service reset), which
 * itself had replaced the original placeholder PIN/name-dropdown auth.
 * Neither of those earlier systems exist in this file anymore.
 *
 * Access is multi-portal via a checkbox grid in HR Manager's Employee
 * Directory (the single source of truth -- no separate account list),
 * not one role = one portal. `portals` is a JSON array of portal keys
 * per person; employee-portal.html reads it to decide which tiles to
 * show after login. When HR marks someone Terminated, that same
 * Directory calls /revoke-by-email so their login dies with their
 * employment status, not as a separate manual step.
 *
 * Direct D1 binding (env.DB), not routed through unipro-ai-proxy -- this
 * table is a security boundary on its own and stays isolated from the
 * generic REST CRUD proxy every other table uses.
 *
 * Endpoints:
 *   POST /provision       { email, name, role, division, portals[], provisionedBy }
 *   POST /sso-exchange    { code }  -- the only sign-in path
 *   POST /resend-invite   { id }    -- re-sends the "your access is ready" email
 *   GET  /list
 *   POST /revoke          { id }
 *   POST /reactivate      { id }
 *   POST /revoke-by-email { email }
 *   POST /update-access   { id, portals[], role? }
 *   GET  /my-access?email=
 */

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLength) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

// Decodes (does not verify signature of) a JWT's payload segment. Safe
// here because the id_token arrives over a direct server-to-server HTTPS
// call to login.microsoftonline.com with our client secret attached --
// we are the intended audience, not relaying a token a browser handed us.
function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('Malformed token.');
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const json = atob(b64);
  return JSON.parse(json);
}

// 2026-07-17 per Ted: everyone lands on employee-portal.html first, full
// stop, no more single-portal people getting bounced straight into their
// own dashboard. That page carries company news/announcements that
// single-portal people (most of the company) were never seeing before --
// they went straight to their own portal and never passed through it.
// One landing page for everyone means one thing to explain and one thing
// to fix if it breaks, instead of two different behaviors depending on
// how many portals someone has.
function resolveDestinationUrl(role, division, portals) {
  return 'employee-portal.html';
}

// Builds the actual link that goes in provisioning/resend emails: the
// SSO sign-in page, carrying this person's resolved destination as
// ?dest= so staff-login.html can bounce them straight there once
// Microsoft confirms who they are, instead of leaving them on a generic
// page to figure out on their own.
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

// Creates the access record HR grants -- no password of any kind. The
// person's actual login credential is their Microsoft account, which
// Termac One never touches. This just says "this email is allowed in,
// and here is what they can see."
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

  const id = 'STF_' + Date.now().toString(36).toUpperCase() + '_' + randomHex(3);

  await env.DB.prepare(
    'INSERT INTO staff_auth (id, email, name, role, division, portals, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, email, name, role, division, JSON.stringify(portals), 'active', Date.now(), Date.now()).run();

  const LOGIN_URL = buildLoginUrl(role, division, portals);
  const emailSent = await sendEmail(env, name, email, 'Termac One Access Ready',
    'Your Termac One access is ready. Sign in at ' + LOGIN_URL +
    ' using the Sign in with Microsoft button with this email address: ' + email +
    '. Use your normal company email password -- Termac One does not have a separate password.');

  return jsonResponse({ ok: true, id, emailSent });
}

// 2026-07-17: Entra SSO. staff-login.html's "Sign in with Microsoft"
// button sends the browser to Microsoft's own /authorize URL directly,
// so this worker never sees that step. Microsoft then redirects back to
// auth/callback.html with a one-time `code`, which posts here. This is
// the only place the client secret is used -- it never reaches the
// browser. Looks the signed-in person up in staff_auth by the email
// Microsoft confirms (upn falls back to email/preferred_username across
// tenant configs).
async function handleSsoExchange(request, env) {
  const body = await request.json();
  const code = (body.code || '').trim();
  if (!code) return jsonResponse({ ok: false, error: 'Missing authorization code.' }, 400);
  if (!env.SSO_CLIENT_SECRET) {
    return jsonResponse({ ok: false, error: 'SSO is not fully configured yet. Contact your admin.' }, 500);
  }

  const tokenUrl = 'https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token';
  const params = new URLSearchParams({
    client_id: env.SSO_CLIENT_ID,
    client_secret: env.SSO_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: env.SSO_REDIRECT_URI,
    scope: 'openid profile email offline_access https://graph.microsoft.com/Mail.Send',
  });

  let tokenData;
  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.id_token) {
      return jsonResponse({ ok: false, error: tokenData.error_description || 'Microsoft sign-in failed.' }, 401);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach Microsoft to complete sign-in.' }, 502);
  }

  let claims;
  try {
    claims = decodeJwtPayload(tokenData.id_token);
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not read Microsoft sign-in response.' }, 502);
  }

  const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  if (!email) return jsonResponse({ ok: false, error: 'Microsoft did not return an email for this account.' }, 401);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user || user.status !== 'active') {
    return jsonResponse({ ok: false, error: 'No active Termac One account for ' + email + '. Contact your admin.' }, 403);
  }

  await env.DB.prepare('UPDATE staff_auth SET last_login_at = ? WHERE id = ?').bind(Date.now(), user.id).run();

  // 2026-07-20 per Ted: store the Graph access/refresh token for this
  // person server-side, never sent to the browser, so /api/send-mail
  // can send real email as them later in the session. If Mail.Send
  // wasn't actually granted for some reason, tokenData just won't have
  // these fields -- don't let that break login itself.
  if (tokenData.access_token) {
    try {
      await env.DB.prepare(
        `INSERT INTO staff_graph_tokens (staff_email, access_token, refresh_token, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(staff_email) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      ).bind(
        email,
        tokenData.access_token,
        tokenData.refresh_token || null,
        Date.now() + ((tokenData.expires_in || 3600) * 1000),
        Date.now()
      ).run();
    } catch (e) { /* email-sending is a bonus, never block login over it */ }
  }

  let portals = [];
  try { portals = JSON.parse(user.portals || '[]'); } catch (e) {}
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
  });
}

// 2026-07-20 per Ted: send-as-the-real-person email, for every portal
// (sales, management, DMS, reception, scheduler, tech). Looks up the
// Graph token stored for this person at their last SSO login, refreshes
// it if it's expired or about to be, then calls Microsoft Graph's own
// sendMail so the email genuinely comes from their real mailbox and
// replies land there too -- not a shared system address. Callers should
// fall back to the existing Resend-based system send on any non-ok
// response here (most commonly: this person hasn't logged in since
// Mail.Send was added, so there's no token on file yet).
async function handleSendMail(request, env) {
  const body = await request.json();
  const fromEmail = String(body.from_email || '').trim().toLowerCase();
  const to = (Array.isArray(body.to) ? body.to : [body.to]).filter(Boolean);
  const subject = String(body.subject || '').trim();
  const html = String(body.html || '');
  if (!fromEmail || !to.length || !subject) {
    return jsonResponse({ ok: false, error: 'Missing from_email, to, or subject.' }, 400);
  }

  let tokenRow = await env.DB.prepare('SELECT * FROM staff_graph_tokens WHERE staff_email = ?').bind(fromEmail).first();
  if (!tokenRow || !tokenRow.access_token) {
    return jsonResponse({ ok: false, error: 'no_graph_token', message: 'No Microsoft mail token on file yet -- sign out and back in once to enable this.' }, 409);
  }

  if (tokenRow.expires_at < Date.now() + 60000) {
    if (!tokenRow.refresh_token) {
      return jsonResponse({ ok: false, error: 'no_refresh_token', message: 'Mail token expired and cannot be refreshed -- sign out and back in.' }, 409);
    }
    const tokenUrl = 'https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token';
    const refreshParams = new URLSearchParams({
      client_id: env.SSO_CLIENT_ID,
      client_secret: env.SSO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token,
      scope: 'openid profile email offline_access https://graph.microsoft.com/Mail.Send',
    });
    let refreshData;
    try {
      const refreshRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshParams.toString(),
      });
      refreshData = await refreshRes.json();
      if (!refreshRes.ok || !refreshData.access_token) {
        return jsonResponse({ ok: false, error: 'refresh_failed', message: 'Could not refresh Microsoft mail token -- sign out and back in.' }, 409);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Could not reach Microsoft to refresh mail token.' }, 502);
    }
    await env.DB.prepare(
      `UPDATE staff_graph_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE staff_email = ?`
    ).bind(
      refreshData.access_token,
      refreshData.refresh_token || tokenRow.refresh_token,
      Date.now() + ((refreshData.expires_in || 3600) * 1000),
      Date.now(),
      fromEmail
    ).run();
    tokenRow = Object.assign({}, tokenRow, { access_token: refreshData.access_token });
  }

  const graphMessage = {
    message: {
      subject: subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: to.map(function(addr) { return { emailAddress: { address: addr } }; }),
    },
    saveToSentItems: true,
  };

  try {
    const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + tokenRow.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(graphMessage),
    });
    if (sendRes.status !== 202) {
      const errText = await sendRes.text();
      return jsonResponse({ ok: false, error: 'graph_send_failed', message: errText.slice(0, 300) }, 502);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach Microsoft Graph to send mail.' }, 502);
  }

  return jsonResponse({ ok: true, sentAs: fromEmail });
}

// 2026-07-10: dedicated safe list endpoint for the admin provisioning UI.
// Deliberately NOT routed through unipro-ai-proxy's generic REST CRUD --
// that proxy returns every column of whatever table it's asked for.
// There is no password column left to worry about, but this stays a
// deliberate explicit-column select rather than SELECT *.
async function handleList(env) {
  const result = await env.DB.prepare(
    'SELECT id, email, name, role, division, portals, status, created_at, last_login_at FROM staff_auth ORDER BY created_at DESC'
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
// permissions change. Does not touch status.
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

// 2026-07-17: no password to regenerate anymore -- this just re-sends the
// "your access is ready, sign in with Microsoft" email, in case the first
// one got lost or the person needs the link again. Safe to click as many
// times as needed; it changes nothing about the account itself.
async function handleResendInvite(request, env) {
  const body = await request.json();
  const id = (body.id || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'Account id is required.' }, 400);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE id = ?').bind(id).first();
  if (!user) return jsonResponse({ ok: false, error: 'Account not found.' }, 404);

  let userPortals = [];
  try { userPortals = JSON.parse(user.portals || '[]'); } catch (e) {}
  const LOGIN_URL = buildLoginUrl(user.role, user.division, userPortals);
  const emailSent = await sendEmail(env, user.name, user.email, 'Termac One Login Link Resent',
    'Here is your Termac One sign-in link again: ' + LOGIN_URL +
    '. Use the Sign in with Microsoft button with this email address, ' + user.email +
    ', and your normal company email password.');

  return jsonResponse({ ok: true, emailSent });
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
        case '/sso-exchange': return await handleSsoExchange(request, env);
        case '/list': return await handleList(env);
        case '/revoke': return await handleRevoke(request, env);
        case '/reactivate': return await handleReactivate(request, env);
        case '/revoke-by-email': return await handleRevokeByEmail(request, env);
        case '/update-access': return await handleUpdateAccess(request, env);
        case '/resend-invite': return await handleResendInvite(request, env);
        case '/my-access': return await handleMyAccess(request, env);
        case '/send-mail': return await handleSendMail(request, env);
        default: return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Server error.' }, 500);
    }
  },
};
