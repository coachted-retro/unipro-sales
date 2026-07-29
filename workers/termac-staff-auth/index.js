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
  return 'https://sales.mytermac.com/staff-login.html?dest=' + encodeURIComponent(dest);
}

async function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': (request && request.headers && ['https://v2.mytermac.com','https://sales.mytermac.com','https://termac-one-v2.pages.dev'].includes(request.headers.get('Origin'))) ? request.headers.get('Origin') : 'https://sales.mytermac.com',
      'Access-Control-Allow-Credentials': 'true'
    },
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
  // Extract origin for CORS -- must match what browser sends
  const reqOrigin = request.headers.get('Origin') || '';
  const allowedOrigins = ['https://sales.mytermac.com','https://v2.mytermac.com','https://my.mytermac.com','https://termac-one-v2.pages.dev','https://unipro-sales.pages.dev','https://sbx.unipro-sales.pages.dev'];
  const corsOrigin = allowedOrigins.includes(reqOrigin) ? reqOrigin : 'https://sales.mytermac.com';

  function ssoJson(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Credentials': 'true',
      }
    });
  }

  const body = await request.json();
  const code = (body.code || '').trim();
  if (!code) return ssoJson({ ok: false, error: 'Missing authorization code.' }, 400);
  if (!env.SSO_CLIENT_SECRET) {
    return ssoJson({ ok: false, error: 'SSO is not fully configured yet. Contact your admin.' }, 500);
  }

  const tokenUrl = 'https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token';
  // Accept the redirect URI from the browser so any registered mytermac.com
  // subdomain works without a Worker secret change. Validate it is one of
  // our known domains before sending to Azure.
  const ALLOWED_REDIRECT_ORIGINS = ['https://sales.mytermac.com', 'https://my.mytermac.com', 'https://v2.mytermac.com', 'https://termac-one-v2.pages.dev', 'https://unipro-sales.pages.dev', 'https://sbx.unipro-sales.pages.dev'];
  let redirectUri = (body.redirect_uri || '').trim();
  const originOk = ALLOWED_REDIRECT_ORIGINS.some(o => redirectUri.startsWith(o));
  if (!redirectUri || !originOk) {
    redirectUri = env.SSO_REDIRECT_URI;
  }
  const params = new URLSearchParams({
    client_id: env.SSO_CLIENT_ID,
    client_secret: env.SSO_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
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
      return ssoJson({ ok: false, error: tokenData.error_description || 'Microsoft sign-in failed.' }, 401);
    }
  } catch (e) {
    return ssoJson({ ok: false, error: 'Could not reach Microsoft to complete sign-in.' }, 502);
  }

  let claims;
  try {
    claims = decodeJwtPayload(tokenData.id_token);
  } catch (e) {
    return ssoJson({ ok: false, error: 'Could not read Microsoft sign-in response.' }, 502);
  }

  const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  if (!email) return ssoJson({ ok: false, error: 'Microsoft did not return an email for this account.' }, 401);

  const user = await env.DB.prepare('SELECT * FROM staff_auth WHERE email = ?').bind(email).first();
  if (!user || user.status !== 'active') {
    return ssoJson({ ok: false, error: 'No active Termac One account for ' + email + '. Contact your admin.' }, 403);
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

  return ssoJson({
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

// ── CALENDAR SYNC ────────────────────────────────────────────────────────
async function handleCalendarPush(request, env) {
  const body = await request.json();
  const fromEmail = String(body.from_email || '').trim().toLowerCase();
  const event = body.event;
  const termacApptId = body.termac_appt_id || '';
  if (!fromEmail || !event) return jsonResponse({ ok: false, error: 'Missing from_email or event.' }, 400);

  let tokenRow = await env.DB.prepare('SELECT * FROM staff_graph_tokens WHERE staff_email = ?').bind(fromEmail).first();
  if (!tokenRow || !tokenRow.access_token) return jsonResponse({ ok: false, error: 'no_graph_token', message: 'Sign out and back in to enable calendar sync.' }, 409);

  // Refresh if near expiry
  if (tokenRow.expires_at < Date.now() + 60000 && tokenRow.refresh_token) {
    try {
      const rp = new URLSearchParams({ client_id: env.SSO_CLIENT_ID, client_secret: env.SSO_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: tokenRow.refresh_token, scope: 'openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite' });
      const rr = await fetch('https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: rp.toString() });
      const rd = await rr.json();
      if (rd.access_token) {
        await env.DB.prepare('UPDATE staff_graph_tokens SET access_token=?,refresh_token=?,expires_at=?,updated_at=? WHERE staff_email=?').bind(rd.access_token, rd.refresh_token || tokenRow.refresh_token, Date.now() + (rd.expires_in || 3600) * 1000, Date.now(), fromEmail).run();
        tokenRow = Object.assign({}, tokenRow, { access_token: rd.access_token });
      }
    } catch(e) {}
  }

  // Check for existing sync mapping to avoid duplicates
  let outlookEventId = null;
  if (termacApptId) {
    try {
      const ex = await env.DB.prepare('SELECT outlook_event_id FROM calendar_sync WHERE termac_appt_id=? AND staff_email=?').bind(termacApptId, fromEmail).first();
      if (ex) outlookEventId = ex.outlook_event_id;
    } catch(e) {}
  }

  try {
    const graphRes = outlookEventId
      ? await fetch('https://graph.microsoft.com/v1.0/me/events/' + outlookEventId, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + tokenRow.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
      : await fetch('https://graph.microsoft.com/v1.0/me/events', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tokenRow.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });

    if (!graphRes.ok) { const t = await graphRes.text(); return jsonResponse({ ok: false, error: 'graph_calendar_failed', message: t.slice(0, 300) }, 502); }
    const created = await graphRes.json();
    const eventId = created.id;
    if (termacApptId && eventId) {
      try { await env.DB.prepare('INSERT OR REPLACE INTO calendar_sync (termac_appt_id, staff_email, outlook_event_id, synced_at) VALUES (?,?,?,?)').bind(termacApptId, fromEmail, eventId, Date.now()).run(); } catch(e) {}
    }
    return jsonResponse({ ok: true, eventId });
  } catch(e) { return jsonResponse({ ok: false, error: e.message }, 502); }
}

async function handleCalendarPull(request, env) {
  const url = new URL(request.url);
  const fromEmail = (url.searchParams.get('email') || '').trim().toLowerCase();
  const start = url.searchParams.get('start') || new Date().toISOString().slice(0,10);
  const end   = url.searchParams.get('end')   || new Date(Date.now() + 7*86400000).toISOString().slice(0,10);
  if (!fromEmail) return jsonResponse({ ok: false, error: 'Missing email.' }, 400);

  const tokenRow = await env.DB.prepare('SELECT access_token FROM staff_graph_tokens WHERE staff_email = ?').bind(fromEmail).first();
  if (!tokenRow || !tokenRow.access_token) return jsonResponse({ ok: true, events: [] });

  try {
    const gr = await fetch('https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=' + encodeURIComponent(start + 'T00:00:00') + '&endDateTime=' + encodeURIComponent(end + 'T23:59:59') + '&$select=id,subject,start,end,location,categories&$top=50', { headers: { 'Authorization': 'Bearer ' + tokenRow.access_token } });
    if (!gr.ok) return jsonResponse({ ok: true, events: [] });
    const data = await gr.json();
    const events = (data.value || []).filter(ev => !(ev.categories || []).includes('Termac One'));
    return jsonResponse({ ok: true, events });
  } catch(e) { return jsonResponse({ ok: true, events: [] }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION REFRESH -- called every 5 minutes by termac-d1-sync.js
// Returns the current authoritative session state from D1. No localStorage.
// Any change made in D1 (coverage, portals, role, status) surfaces within
// 5 minutes to every active user without them touching anything.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSessionRefresh(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return jsonResponse({ ok: false, error: 'email required' }, 400);

  const user = await env.DB.prepare(
    'SELECT id, email, name, role, division, portals, status, covering_for FROM staff_auth WHERE email = ?'
  ).bind(email).first();

  if (!user) return jsonResponse({ ok: false, error: 'not_found' });
  if (user.status !== 'active') return jsonResponse({ ok: false, error: 'suspended', active: false });

  let portals = [];
  try { portals = JSON.parse(user.portals || '[]'); } catch (e) {}

  return jsonResponse({
    ok: true,
    active: true,
    name: user.name,
    role: user.role || 'employee',
    division: user.division || '',
    portals: portals,
    coveringFor: user.covering_for || null,
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// AllPro Site Survey Webhook
// Called by JotForm webhook on every survey submission.
// Also callable directly from the sales portal "Start Site Survey" button.
//
// Responsibilities:
//  1. Parse the incoming survey payload (JotForm POST or JSON from portal)
//  2. Deduplicate against locations, accounts, contacts, leads in D1
//     (same 2-of-3 signal logic as the sales portal spCheckPhoneDuplicate)
//  3. Create or link the Location record in D1
//  4. Create a new AllPro Opportunity on that Location
//  5. Write the survey record to allpro_site_surveys
//  6. Return { ok, survey_id, location_id, opportunity_id, quote_builder_url }
// ─────────────────────────────────────────────────────────────────────────────
async function handleAllProSurveySubmit(request, env) {
  let body;
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      // JotForm sends application/x-www-form-urlencoded
      const text = await request.text();
      const params = new URLSearchParams(text);
      body = {};
      for (const [k, v] of params.entries()) { body[k] = v; }
      // JotForm also sends a rawRequest JSON field with the full submission
      if (body.rawRequest) {
        try { const raw = JSON.parse(body.rawRequest); Object.assign(body, raw); } catch(e) {}
      }
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Invalid payload: ' + e.message }, 400);
  }

  // ── Extract core identity fields ──────────────────────────────────────────
  const customerName  = (body.customer_name || body.q1_customerName || '').trim();
  const siteAddress   = (body.site_address  || body.q3_siteAddress  || '').trim();
  const siteZip       = (body.site_zip      || body.q4_siteZip      || '').trim();
  const customerPhone = (body.customer_phone || body.q6_customerPhone || '').replace(/\D/g, '');
  const customerEmail = (body.customer_email || body.q7_customerEmail || '').trim().toLowerCase();
  const customerContact = (body.customer_contact || body.q5_customerContact || '').trim();
  const repName       = (body.rep_name      || body.q2_repName      || 'Ted Scholl').trim();
  const projectType   = (body.project_type  || body.q8_projectType  || 'hood_install').trim();
  const jotformSubId  = (body.submissionID  || body.submission_id   || '').trim();

  if (!customerName && !siteAddress) {
    return jsonResponse({ ok: false, error: 'Customer name or address required.' }, 400);
  }

  const now = Date.now();

  // ── Dedup check: 2-of-3 signals across locations, accounts, contacts, leads ─
  let existingLocationId = body.location_id || null; // pre-linked from portal button
  let existingAccountId  = null;
  let dupeMatch          = null;

  if (!existingLocationId) {
    // Build parallel dedup queries
    const queries = [];

    // name + address match in locations
    if (customerName && siteAddress) {
      queries.push(
        env.DB.prepare(
          "SELECT id, 'location' as src, name, address FROM locations WHERE LOWER(name) LIKE ? AND LOWER(address) LIKE ? LIMIT 1"
        ).bind('%' + customerName.toLowerCase() + '%', '%' + siteAddress.toLowerCase().slice(0, 20) + '%').first()
      );
    } else {
      queries.push(Promise.resolve(null));
    }

    // phone + name match in locations
    if (customerPhone && customerName) {
      queries.push(
        env.DB.prepare(
          "SELECT id, 'location' as src, name, address FROM locations WHERE phone LIKE ? AND LOWER(name) LIKE ? LIMIT 1"
        ).bind('%' + customerPhone.slice(-7) + '%', '%' + customerName.toLowerCase() + '%').first()
      );
    } else {
      queries.push(Promise.resolve(null));
    }

    // phone + address match in accounts
    if (customerPhone && siteAddress) {
      queries.push(
        env.DB.prepare(
          "SELECT id, 'account' as src, name, address FROM accounts WHERE phone LIKE ? AND LOWER(address) LIKE ? LIMIT 1"
        ).bind('%' + customerPhone.slice(-7) + '%', '%' + siteAddress.toLowerCase().slice(0, 20) + '%').first()
      );
    } else {
      queries.push(Promise.resolve(null));
    }

    // name + address match in accounts (chain restaurant fallback)
    if (customerName && siteAddress) {
      queries.push(
        env.DB.prepare(
          "SELECT id, 'account' as src, name, address FROM accounts WHERE LOWER(name) LIKE ? AND LOWER(address) LIKE ? LIMIT 1"
        ).bind('%' + customerName.toLowerCase() + '%', '%' + siteAddress.toLowerCase().slice(0, 20) + '%').first()
      );
    } else {
      queries.push(Promise.resolve(null));
    }

    const [locByNameAddr, locByPhoneName, accByPhoneAddr, accByNameAddr] = await Promise.all(queries);

    dupeMatch = locByNameAddr || locByPhoneName || accByPhoneAddr || accByNameAddr;

    if (dupeMatch) {
      if (dupeMatch.src === 'location') {
        existingLocationId = dupeMatch.id;
      } else if (dupeMatch.src === 'account') {
        existingAccountId = dupeMatch.id;
        // Try to find the linked location for this account
        const locForAcc = await env.DB.prepare(
          "SELECT id FROM locations WHERE account_id = ? LIMIT 1"
        ).bind(dupeMatch.id).first();
        if (locForAcc) existingLocationId = locForAcc.id;
      }
    }
  }

  // ── If caller passed ?confirm_link=false, return dupe info for UI prompt ──
  if (dupeMatch && body.confirm_link === 'false') {
    return jsonResponse({
      ok: true,
      dupe_found: true,
      dupe: {
        id: dupeMatch.id,
        src: dupeMatch.src,
        name: dupeMatch.name,
        address: dupeMatch.address,
        location_id: existingLocationId,
      },
      message: 'Existing record found. Pass confirm_link=true to link, or create_new=true to create a new location.',
    });
  }

  // ── Create or resolve Location ────────────────────────────────────────────
  let locationId = existingLocationId;
  if (!locationId && body.create_new !== 'false') {
    const newLocId = 'LOC-AP-' + now + '-' + Math.floor(Math.random() * 9000 + 1000);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO locations
        (id, name, address, phone, parent_company, assigned_rep, source, status,
         division, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'allpro_survey', 'active', 'allpro', ?, ?)`
    ).bind(
      newLocId,
      customerName,
      siteAddress + (siteZip ? ', ' + siteZip : ''),
      customerPhone || null,
      customerName, // parent_company defaults to business name
      repName,
      now, now
    ).run();
    locationId = newLocId;

    // Create a contact on the new location if contact name provided
    if (customerContact) {
      const conId = 'CON-AP-' + now + '-' + Math.floor(Math.random() * 9000 + 1000);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO contacts
          (id, location_id, name, phone, email, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Primary Contact', ?, ?)`
      ).bind(conId, locationId, customerContact, customerPhone || null, customerEmail || null, now, now).run();
    }
  }

  if (!locationId) {
    return jsonResponse({ ok: false, error: 'Could not resolve or create location.' }, 500);
  }

  // ── Create AllPro Opportunity ─────────────────────────────────────────────
  const oppId = 'OPP-AP-' + now + '-' + Math.floor(Math.random() * 9000 + 1000);
  const oppDivision = projectType === 'dishwasher' ? 'termac_dish' : 'allpro';
  const oppLabel = projectType === 'tm_service'
    ? 'T&M Service - ' + customerName
    : projectType === 'custom_stainless'
    ? 'Custom Stainless - ' + customerName
    : projectType === 'dishwasher'
    ? 'Dishwasher - ' + customerName
    : 'Hood Install - ' + customerName;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO opportunities
      (id, locationId, division, status, notes, assigned_rep,
       source, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, 'allpro_site_survey', ?, ?)`
  ).bind(
    oppId, locationId, oppDivision,
    'AllPro site survey submitted ' + new Date(now).toLocaleDateString('en-US'),
    repName,
    now, now
  ).run();

  // ── Write the full survey record ──────────────────────────────────────────
  const surveyId = 'ASS-' + now + '-' + Math.floor(Math.random() * 9000 + 1000);

  // Map all survey fields -- supports both JotForm field names and direct JSON keys
  const hood_type      = body.hood_type      || body.q_hood_type      || null;
  const hood_style     = body.hood_style     || body.q_hood_style     || null;
  const hood_length    = parseFloat(body.hood_length_in  || body.q_hood_length  || 0) || null;
  const hood_width     = parseFloat(body.hood_width_in   || body.q_hood_width   || 0) || null;
  const hood_height    = parseFloat(body.hood_height_in  || body.q_hood_height  || 0) || null;
  const ceiling_ht     = parseFloat(body.ceiling_height_in || body.q_ceiling_ht || 108) || 108;
  const wall_mat       = body.wall_material  || body.q_wall_material  || null;
  const cx_duct        = body.complexity_duct  || body.q_cx_duct  || 'L1';
  const cx_wall        = body.complexity_wall  || body.q_cx_wall  || 'L1';
  const cx_deck        = body.complexity_deck  || body.q_cx_deck  || 'L1';
  const cx_notes       = body.complexity_notes || body.q_cx_notes || null;
  const supp_required  = body.suppression_required  || null;
  const supp_preferred = body.suppression_preferred || null;
  const supp_in_scope  = body.suppression_in_scope  || '0';
  const timeline       = body.project_timeline || body.q_timeline || null;
  const budget_range   = body.budget_range     || body.q_budget   || null;
  const field_notes    = body.field_notes      || body.q_field_notes || null;
  const fe_count       = parseInt(body.fire_ext_count || 0) || 0;
  const fe_condition   = body.fire_ext_condition  || null;
  const fe_needed      = parseInt(body.fire_ext_units_needed || 0) || 0;
  const el_count       = parseInt(body.exit_light_count || 0) || 0;
  const el_condition   = body.exit_light_condition || null;
  const sign_condition = body.exit_sign_condition  || null;
  const fe_sign_cond   = body.fe_signage_condition || null;
  const svc_hood       = body.service_hood_cleaning    || 'none';
  const svc_fe         = body.service_fe_inspection    || 'none';
  const svc_el         = body.service_exit_light       || 'none';

  // Auto-generate upsell flags from fire safety assessment
  const upsellFlags = [];
  if (fe_condition && fe_condition !== 'adequate') upsellFlags.push({ type: 'fire_extinguisher', condition: fe_condition, units: fe_needed });
  if (el_condition && el_condition !== 'good')      upsellFlags.push({ type: 'exit_light', condition: el_condition, count: el_count });
  if (sign_condition && sign_condition !== 'all_present_lit') upsellFlags.push({ type: 'exit_sign', condition: sign_condition });
  if (fe_sign_cond && fe_sign_cond !== 'present')   upsellFlags.push({ type: 'fe_signage', condition: fe_sign_cond });

  await env.DB.prepare(
    `INSERT INTO allpro_site_surveys
      (id, opportunity_id, location_id, rep_name, survey_date,
       customer_name, customer_contact, customer_phone, customer_email,
       site_address, site_zip, project_type, project_timeline, budget_range,
       hood_type, hood_style, hood_length_in, hood_width_in, hood_height_in,
       ceiling_height_in, wall_material,
       complexity_duct, complexity_wall, complexity_deck, complexity_notes,
       suppression_required, suppression_preferred, suppression_in_scope,
       fire_ext_count, fire_ext_condition, fire_ext_units_needed,
       exit_light_count, exit_light_condition, exit_sign_condition,
       fe_signage_condition, upsell_flags_json,
       service_hood_cleaning, service_fe_inspection, service_exit_light,
       field_notes, jotform_submission_id,
       status, submitted_at, created_at, updated_at)
     VALUES
      (?,?,?,?,?,
       ?,?,?,?,
       ?,?,?,?,?,
       ?,?,?,?,?,
       ?,?,
       ?,?,?,?,
       ?,?,?,
       ?,?,?,
       ?,?,?,
       ?,?,
       ?,?,?,
       ?,?,
       ?,?,?,?)`
  ).bind(
    surveyId, oppId, locationId, repName, new Date(now).toISOString().slice(0,10),
    customerName, customerContact || null, customerPhone || null, customerEmail || null,
    siteAddress, siteZip || null, projectType, timeline || null, budget_range || null,
    hood_type, hood_style, hood_length, hood_width, hood_height,
    ceiling_ht, wall_mat,
    cx_duct, cx_wall, cx_deck, cx_notes,
    supp_required, supp_preferred, supp_in_scope === '1' || supp_in_scope === 'yes' ? 1 : 0,
    fe_count, fe_condition, fe_needed,
    el_count, el_condition, sign_condition,
    fe_sign_cond, JSON.stringify(upsellFlags),
    svc_hood, svc_fe, svc_el,
    field_notes, jotformSubId || null,
    'submitted', now, now, now
  ).run();

  // ── Build quote builder pre-fill URL ─────────────────────────────────────
  const qbUrl = 'https://sales.mytermac.com/allpro-quote-builder.html'
    + '?survey_id=' + encodeURIComponent(surveyId)
    + '&opp_id='    + encodeURIComponent(oppId)
    + '&loc_id='    + encodeURIComponent(locationId)
    + '&rep='       + encodeURIComponent(repName);

  return jsonResponse({
    ok: true,
    survey_id:       surveyId,
    opportunity_id:  oppId,
    location_id:     locationId,
    dupe_found:      !!dupeMatch,
    dupe_linked:     !!existingLocationId,
    quote_builder_url: qbUrl,
    message: dupeMatch
      ? 'Survey linked to existing location. Opportunity created.'
      : 'New location and opportunity created from survey.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AllPro Proposal Send
// Pre-populates the JotForm customer proposal with quote data and sends
// a pre-filled link to the customer via Graph email.
//
// POST body: { quote_id, sender_email (from session) }
// Returns: { ok, prefill_url, sent_to }
// ─────────────────────────────────────────────────────────────────────────────
const ALLPRO_PROPOSAL_FORM_ID = '262035509253049';
const JOTFORM_PREPOPULATE_BASE = 'https://form.jotform.com/' + ALLPRO_PROPOSAL_FORM_ID;

async function handleAllProProposalSend(request, env) {
  let body;
  try { body = await request.json(); } catch(e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }

  const quoteId   = body.quote_id;
  const senderEmail = body.sender_email || 'tscholl@termac.com';
  if (!quoteId) return jsonResponse({ ok: false, error: 'quote_id required' }, 400);

  // Fetch quote from D1
  const q = await env.DB.prepare('SELECT * FROM allpro_quotes WHERE id = ?').bind(quoteId).first();
  if (!q) return jsonResponse({ ok: false, error: 'Quote not found' }, 404);

  // Fetch line items
  const lines = await env.DB.prepare(
    'SELECT * FROM allpro_quote_lines WHERE quote_id = ? ORDER BY sort_order, line_number'
  ).bind(quoteId).all();

  const lineRows = lines.results || [];

  // Build scope text from line items
  const scopeLines = lineRows.map(function(l, i) {
    var dimStr = '';
    if (l.dim_length) dimStr += l.dim_length + '"L';
    if (l.dim_width)  dimStr += ' x ' + l.dim_width + '"W';
    if (l.dim_height) dimStr += ' x ' + l.dim_height + '"H';
    var price = (l.line_total || 0).toLocaleString('en-US', { style:'currency', currency:'USD' });
    return (i+1) + '. ' + (l.description || l.item_type) + (dimStr ? ' (' + dimStr + ')' : '') + ' -- ' + price;
  }).join('\n');

  // Complexity label
  const cxMap = { L1: 'Level 1 Standard', L2: 'Level 2 Complex', L3: 'Level 3 Extreme' };
  const cxLabel = [
    q.complexity_duct !== 'L1' ? 'Duct: ' + cxMap[q.complexity_duct] : '',
    q.complexity_wall !== 'L1' ? 'Wall: ' + cxMap[q.complexity_wall] : '',
    q.complexity_deck !== 'L1' ? 'Deck: ' + cxMap[q.complexity_deck] : ''
  ].filter(Boolean).join(', ') || 'Level 1 Standard (no complexity adjustment)';

  // Format currency
  function usd(n) { return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }); }

  // Build JotForm pre-fill URL using field name parameters
  // JotForm pre-population uses: ?fieldName[]=value or ?q{id}_fieldName=value
  // We use the readable field name format since we built the form with descriptive names
  var today = new Date().toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' });
  var params = new URLSearchParams({
    'customerBusinessName':     q.customer_name || '',
    'contactName':              q.customer_contact || '',
    'siteAddress':              q.customer_address || '',
    'phone':                    q.customer_phone || '',
    'email':                    q.customer_email || '',
    'proposalNumber':           q.project_number || quoteId,
    'proposalDate':             today,
    'projectDescriptionAndScope': scopeLines,
    'suppressionSystemScope':   q.suppression_system_notes || 'To be determined based on AHJ requirements',
    'complexityLevel':          cxLabel,
    'fabricationAndMaterials':  usd(q.subtotal),
    'complexityAdjustment':     usd(q.complexity_add),
    'taxPercent':               ((q.tax_rate || 0.06) * 100).toFixed(0) + '%',
    'taxAmount':                usd(q.tax_amount),
    'totalInvestment':          usd(q.grand_total),
    'authorizedAllProRepresentative': q.created_by || 'Ted Scholl',
  });

  var prefillUrl = JOTFORM_PREPOPULATE_BASE + '?' + params.toString();

  // Update quote status to 'sent'
  await env.DB.prepare(
    'UPDATE allpro_quotes SET status=?, sent_at=?, updated_at=? WHERE id=?'
  ).bind('sent', Date.now(), Date.now(), quoteId).run();

  // Send email via Graph if sender token available
  var customerEmail = q.customer_email;
  var emailSent = false;

  if (customerEmail) {
    var tokenRow = await env.DB.prepare(
      'SELECT * FROM staff_graph_tokens WHERE staff_email = ?'
    ).bind(senderEmail).first();

    if (tokenRow && tokenRow.access_token) {
      var customerName = q.customer_name || 'Valued Customer';
      var proposalNum  = q.project_number || quoteId;
      var emailHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
        + '<img src="https://sales.mytermac.com/allpro-letterhead.png" alt="AllPro Stainless Steel" style="width:260px;height:auto;margin-bottom:16px"><br>'
        + '<p>Dear ' + customerName + ',</p>'
        + '<p>Thank you for the opportunity to provide this proposal for your custom fabrication project.</p>'
        + '<p>Please review your proposal and sign electronically by clicking the button below. Once signed, you will receive a copy for your records and our team will contact you within 24 hours to confirm your project schedule.</p>'
        + '<div style="text-align:center;margin:28px 0">'
        + '<a href="' + prefillUrl + '" style="background:#F2B705;color:#1A1D21;text-decoration:none;padding:14px 32px;border-radius:8px;font-family:Arial,sans-serif;font-weight:700;font-size:16px;display:inline-block">Review and Sign Proposal</a>'
        + '</div>'
        + '<p><strong>Proposal Number:</strong> ' + proposalNum + '<br>'
        + '<strong>Proposal Total:</strong> ' + usd(q.grand_total) + '<br>'
        + '<strong>Valid Until:</strong> ' + new Date(Date.now() + 30*24*60*60*1000).toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'}) + '</p>'
        + '<p>If you have any questions, please call us at <strong>215-928-9191</strong> or reply to this email.</p>'
        + '<p>Thank you for choosing AllPro Stainless Steel and Metal Fabrication.</p>'
        + '<hr style="margin:24px 0;border:none;border-top:1px solid #E5E7EB">'
        + '<p style="font-size:12px;color:#6B7280">AllPro Stainless Steel and Metal Fabrication | 7330 Tulip Street, Philadelphia PA 19136<br>'
        + 'Phone: 215-928-9191 | Fax: 215-333-9133 | Toll-Free: 1-800-601-4663</p>'
        + '</div>';

      // Refresh token if needed
      if (tokenRow.expires_at && tokenRow.expires_at < Date.now() + 60000) {
        try {
          var refreshRes = await fetch('https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token', {
            method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body: new URLSearchParams({
              grant_type:'refresh_token', client_id: env.SSO_CLIENT_ID,
              client_secret: env.SSO_CLIENT_SECRET, refresh_token: tokenRow.refresh_token,
              scope:'openid profile email Mail.Send offline_access'
            })
          });
          var refreshJson = await refreshRes.json();
          if (refreshJson.access_token) {
            await env.DB.prepare('UPDATE staff_graph_tokens SET access_token=?,expires_at=?,updated_at=? WHERE staff_email=?')
              .bind(refreshJson.access_token, Date.now()+(refreshJson.expires_in||3600)*1000, Date.now(), senderEmail).run();
            tokenRow.access_token = refreshJson.access_token;
          }
        } catch(e) {}
      }

      var graphRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method:'POST',
        headers:{ 'Authorization':'Bearer '+tokenRow.access_token, 'Content-Type':'application/json' },
        body: JSON.stringify({
          message: {
            subject: 'AllPro Proposal #' + proposalNum + ' — ' + customerName,
            body: { contentType:'HTML', content: emailHtml },
            toRecipients: [{ emailAddress:{ address: customerEmail } }]
          }
        })
      });
      emailSent = graphRes.status === 202;
    }
  }

  return jsonResponse({
    ok: true,
    prefill_url: prefillUrl,
    sent_to: customerEmail || null,
    email_sent: emailSent,
    quote_id: quoteId,
    status: 'sent',
    message: emailSent
      ? 'Proposal emailed to ' + customerEmail + ' with pre-filled signing link.'
      : 'Proposal URL ready. Email not sent -- check Graph token or send manually.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TERMAC DISH MACHINE PROPOSAL SEND
// Builds a JotForm pre-fill URL from the termac_dish_quotes D1 row,
// emails the customer a signing link via Graph (sendMailAsMe pattern),
// and marks the quote status 'sent'.
// Uses the same Termac letterhead as AllPro but with Termac branding text.
// ─────────────────────────────────────────────────────────────────────────────
const TERMAC_DISH_PROPOSAL_FORM_ID = '262037458503052';
const TERMAC_DISH_JOTFORM_BASE = 'https://form.jotform.com/' + TERMAC_DISH_PROPOSAL_FORM_ID;

async function handleTermacDishProposalSend(request, env) {
  var body;
  try { body = await request.json(); } catch(e) { return jsonResponse({ ok:false, error:'Invalid JSON' }, 400); }

  var quoteId = body.quote_id;
  var senderEmail = body.sender_email || 'tpittakas@termac.com';
  if (!quoteId) return jsonResponse({ ok:false, error:'quote_id required' }, 400);

  var q = await env.DB.prepare('SELECT * FROM termac_dish_quotes WHERE id = ?').bind(quoteId).first();
  if (!q) return jsonResponse({ ok:false, error:'Quote not found' }, 404);

  function usd(n) { return '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }); }

  var RENTAL_MACHINES = [
    { model:'ADC-44', leaseService:400, deposit:800 },
    { model:'ADC-66', leaseService:490, deposit:800 },
    { model:'AFB / AFBC', leaseService:310, deposit:600 },
    { model:'ASQ', leaseService:290, deposit:600 },
    { model:'Double Tank Straight / Corner', leaseService:330, deposit:600 },
    { model:'ET / ETPD / ET3', leaseService:290, deposit:600 },
    { model:'HT-25', leaseService:310, deposit:600 },
    { model:'Single Tank Straight / Corner', leaseService:290, deposit:600 },
    { model:'UC-180', leaseService:310, deposit:600 }
  ];
  var SELL_MACHINES = [
    { model:'5AG-S', price:7651.49 },
    { model:'5-CD-LF', price:8762.44 },
    { model:'5-CD-RF', price:8762.44 },
    { model:'ASQ II', price:7195.55 },
    { model:'ET-AF-M-PH', price:6122.66 },
    { model:'ET-AF-3-PH', price:6242.68 },
    { model:'L-90-3DW-S', price:5867.97 },
    { model:'L-90-3DWC-S', price:6001.17 },
    { model:'AFB w/Bakery', price:7017.71 },
    { model:'AFB-C', price:7142.12 },
    { model:'HT-25', price:11202.43 },
    { model:'ADC-44 L-R', price:17240.19 },
    { model:'ADC-44 R-L', price:17240.19 },
    { model:'ADC-66 L-R', price:27650.76 },
    { model:'ADC-66 R-L', price:27650.76 }
  ];
  var SOFTENERS = [
    { model:'Small Water Softener', leaseService:100 },
    { model:'Large Water Softener', leaseService:120 }
  ];

  var isRental = q.machine_mode === 'rental';
  var machineLabel = 'Not selected';
  var monthlyTotal = 0;
  var depositTotal = 0;
  var oneTimeTotal = 0;

  if (q.machine_model_val) {
    if (isRental && q.machine_model_val.startsWith('r_')) {
      var rm = RENTAL_MACHINES[parseInt(q.machine_model_val.slice(2))];
      if (rm) { machineLabel = rm.model; monthlyTotal += rm.leaseService; depositTotal = rm.deposit; }
    } else if (!isRental && q.machine_model_val.startsWith('s_')) {
      var sm = SELL_MACHINES[parseInt(q.machine_model_val.slice(2))];
      if (sm) { machineLabel = sm.model; oneTimeTotal += sm.price; }
    }
  }
  if (q.softener_model_idx !== '' && q.softener_model_idx != null) {
    var sf = SOFTENERS[parseInt(q.softener_model_idx)];
    if (sf) { monthlyTotal += sf.leaseService * (parseInt(q.softener_qty) || 1); }
  }

  var today = new Date().toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' });
  var proposalNum = quoteId;

  var scopeLines = [];
  scopeLines.push('Equipment: ' + machineLabel + (isRental ? ' (Monthly Rental)' : ' (Purchase)'));
  if (q.install_notes) scopeLines.push('Installation: ' + q.install_notes);
  if (q.detergent_sku) scopeLines.push('Detergent: ' + q.detergent_sku + (q.detergent_qty ? ' x ' + q.detergent_qty + '/mo' : ''));
  if (q.rinse_sku) scopeLines.push('Rinse Aid: ' + q.rinse_sku + (q.rinse_qty ? ' x ' + q.rinse_qty + '/mo' : ''));
  if (q.sanitizer_sku) scopeLines.push('Sanitizer: ' + q.sanitizer_sku + (q.sanitizer_qty ? ' x ' + q.sanitizer_qty + '/mo' : ''));
  if (q.pot_sink === 'yes') scopeLines.push('Pot Sink Chemical Program included — ' + (q.pot_sink_comp || '3') + '-compartment');
  if (q.chem_notes) scopeLines.push('Notes: ' + q.chem_notes);

  var rentalTermsText = isRental ? [
    'RENTAL TERMS:',
    'This agreement is month-to-month with no long-term contract. Either party may terminate with 30 days written notice. Termac may terminate immediately for cause.',
    'AUTHORIZED PRODUCTS: Only Termac-supplied chemicals may be used on Termac-owned equipment. Use of any third-party chemicals on leased equipment constitutes a material breach of this agreement and entitles Termac Family of Companies to immediate repossession of the equipment without refund of any deposit or prior payments, and without further obligation to the customer.',
    'PAYMENT: Monthly lease-service fee is due on the ' + (q.charge_date || '1st') + ' of each month. A valid payment method must remain on file at all times. Payments more than 5 days past due may result in a late fee. Payments more than 10 days past due trigger Termac\'s right of repossession per Pennsylvania UCC Article 9.',
    'EQUIPMENT OWNERSHIP: Termac Family of Companies retains title to all leased equipment at all times. The customer has no ownership interest and may not sell, sublease, encumber, or modify the equipment.',
    'REPOSSESSION: Termac may repossess equipment without court process for any material breach, including unauthorized chemical use, non-payment, attempted transfer, or unauthorized modification.',
    'CARD ON FILE AUTHORIZATION: By signing this agreement, the customer authorizes Termac to charge the monthly lease-service fee to the card on file automatically on the agreed billing date.',
    'DEPOSIT: Security deposit of ' + usd(depositTotal) + ' is due at signing. Deposit is non-refundable if equipment is repossessed due to breach. Deposit is refunded within 30 days of equipment return in acceptable condition.',
    'MAINTENANCE: Termac is responsible for normal machine maintenance and repair. Damage resulting from misuse, unauthorized chemicals, or negligence is billed to the customer.',
    'INDEMNIFICATION: Customer indemnifies Termac against all claims, losses, and liabilities arising from customer\'s use or misuse of the equipment.',
  ].join('\n\n') : 'PAYMENT TERMS: Price covers equipment and installation. Chemical program billed separately per consumption. Tax not included. Price subject to change after 30 days.';

  var params = new URLSearchParams({
    'customerBusinessName':   q.customer_name || '',
    'contactName':            q.customer_contact || '',
    'siteAddress':            q.customer_address || '',
    'phone':                  q.customer_phone || '',
    'email':                  q.customer_email || '',
    'proposalNumber':         proposalNum,
    'proposalDate':           today,
    'agreementType':          isRental ? 'Rental Agreement' : 'Equipment Purchase',
    'machineModel':           machineLabel,
    'equipmentScope':         scopeLines.join('\n'),
    'monthlyLeaseService':    isRental ? usd(monthlyTotal) + '/month' : 'N/A',
    'depositAmount':          isRental ? usd(depositTotal) : 'N/A',
    'purchasePrice':          !isRental ? usd(oneTimeTotal) : 'N/A',
    'billingDate':            isRental ? (q.charge_date || '1st') + ' of each month' : 'N/A',
    'rentalTermsAndConditions': rentalTermsText,
    'authorizedRepresentative': senderEmail.split('@')[0].replace('.', ' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); }),
  });

  var prefillUrl = TERMAC_DISH_JOTFORM_BASE + '?' + params.toString();

  await env.DB.prepare('UPDATE termac_dish_quotes SET status=?, sent_at=?, updated_at=? WHERE id=?')
    .bind('sent', Date.now(), Date.now(), quoteId).run();

  var customerEmail = q.customer_email;
  var emailSent = false;

  if (customerEmail) {
    var tokenRow = await env.DB.prepare('SELECT * FROM staff_graph_tokens WHERE staff_email = ?').bind(senderEmail).first();
    if (tokenRow && tokenRow.access_token) {
      var customerName = q.customer_name || 'Valued Customer';
      var emailHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
        + '<img src="https://sales.mytermac.com/allpro-letterhead.png" alt="Termac" style="width:260px;height:auto;margin-bottom:16px"><br>'
        + '<p>Dear ' + customerName + ',</p>'
        + '<p>Thank you for the opportunity to serve your commercial warewashing and chemical program needs.</p>'
        + '<p>Please review your proposal and ' + (isRental ? 'rental agreement' : 'purchase agreement') + ' by clicking the button below. Once signed, you will receive a copy for your records and our team will contact you within 24 hours to confirm your installation schedule.</p>'
        + '<div style="text-align:center;margin:28px 0">'
        + '<a href="' + prefillUrl + '" style="background:#C8102E;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-family:Arial,sans-serif;font-weight:700;font-size:16px;display:inline-block">Review and Sign ' + (isRental ? 'Rental Agreement' : 'Proposal') + '</a>'
        + '</div>'
        + '<p><strong>Proposal Number:</strong> ' + proposalNum + '<br>'
        + (isRental ? '<strong>Monthly Service:</strong> ' + usd(monthlyTotal) + '/month<br>'
            + '<strong>Security Deposit:</strong> ' + usd(depositTotal) + ' (due at signing)<br>'
            + '<strong>Billing Date:</strong> ' + (q.charge_date || '1st') + ' of each month' : '<strong>Equipment Total:</strong> ' + usd(oneTimeTotal)) + '</p>'
        + (isRental ? '<p style="background:#FEF3C7;border-left:4px solid #D97706;padding:12px;font-size:13px"><strong>Important:</strong> This is a month-to-month rental with no long-term commitment. Only Termac-supplied chemicals may be used on leased equipment. Unauthorized chemicals void this agreement and trigger immediate repossession rights.</p>' : '')
        + '<p>If you have any questions, please call us at <strong>215-676-5200</strong> or reply to this email.</p>'
        + '<p>Thank you for choosing Termac Family of Companies.</p>'
        + '<hr style="margin:24px 0;border:none;border-top:1px solid #E5E7EB">'
        + '<p style="font-size:12px;color:#6B7280">Termac Family of Companies | Philadelphia, PA<br>'
        + 'Payment processed by TerPro LLC</p>'
        + '</div>';

      if (tokenRow.expires_at && tokenRow.expires_at < Date.now() + 60000) {
        try {
          var refreshRes = await fetch('https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token', {
            method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body: new URLSearchParams({ grant_type:'refresh_token', client_id:env.SSO_CLIENT_ID, client_secret:env.SSO_CLIENT_SECRET, refresh_token:tokenRow.refresh_token, scope:'openid profile email Mail.Send offline_access' })
          });
          var refreshJson = await refreshRes.json();
          if (refreshJson.access_token) {
            await env.DB.prepare('UPDATE staff_graph_tokens SET access_token=?,expires_at=?,updated_at=? WHERE staff_email=?')
              .bind(refreshJson.access_token, Date.now()+(refreshJson.expires_in||3600)*1000, Date.now(), senderEmail).run();
            tokenRow.access_token = refreshJson.access_token;
          }
        } catch(e) {}
      }

      var graphRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method:'POST',
        headers:{ 'Authorization':'Bearer '+tokenRow.access_token, 'Content-Type':'application/json' },
        body: JSON.stringify({ message: { subject: 'Termac ' + (isRental ? 'Rental Agreement' : 'Proposal') + ' #' + proposalNum + ' - ' + customerName, body:{ contentType:'HTML', content:emailHtml }, toRecipients:[{ emailAddress:{ address:customerEmail } }] } })
      });
      emailSent = graphRes.status === 202;
    }
  }

  return jsonResponse({ ok:true, prefill_url:prefillUrl, sent_to:customerEmail||null, email_sent:emailSent, quote_id:quoteId, status:'sent', message: emailSent ? 'Proposal emailed to ' + customerEmail + ' with signing link.' : 'Proposal URL ready. Send manually or check Graph token.' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      const reqOrigin = request.headers.get('Origin') || '';
      const allowedOrigins = ['https://sales.mytermac.com','https://v2.mytermac.com','https://my.mytermac.com','https://termac-one-v2.pages.dev','https://unipro-sales.pages.dev','https://sbx.unipro-sales.pages.dev'];
      const corsOrigin = allowedOrigins.includes(reqOrigin) ? reqOrigin : 'https://sales.mytermac.com';
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }
    if (request.method !== 'POST' && request.url.indexOf('/list') === -1 && request.url.indexOf('/my-access') === -1 && request.url.indexOf('/session-refresh') === -1) {
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
        case '/session-refresh': return await handleSessionRefresh(request, env);
        case '/my-access': return await handleMyAccess(request, env);
        case '/send-mail': return await handleSendMail(request, env);
        case '/calendar-push': return await handleCalendarPush(request, env);
        case '/calendar-pull': return await handleCalendarPull(request, env);
        case '/allpro-survey-submit': return await handleAllProSurveySubmit(request, env);
        case '/allpro-assessment-save': return await handleAssessmentSave(request, env);
        case '/allpro-proposal-send': return await handleAllProProposalSend(request, env);
        case '/allpro-draw-send': return await handleAllProDrawSend(request, env);
        case '/allpro-final-send': return await handleAllProFinalSend(request, env);
        case '/allpro-payment-logged': return await handleAllProPaymentLogged(request, env);
        case '/square-webhook': return await handleSquareWebhook(request, env);
        case '/termac-dish-proposal-send': return await handleTermacDishProposalSend(request, env);
        default: return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Server error.' }, 500);
    }
  },

  // ── CRON: fires hourly to process payment reminders ──────────────────────────
  // Set in wrangler.toml: [triggers] crons = ["0 * * * *"]
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPaymentReminders(env));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ALLPRO PAYMENT MILESTONE EMAILS — 40% Draw and 10% Final Balance
// ─────────────────────────────────────────────────────────────────────────────
//
// Square is used via the Square app on Samsung tablets (no API).
// Payment links are configured once in the SQUARE_LINKS env variable or
// pasted directly by Ted when sending. The system handles all email
// automation, drip reminders, and stage-gate logic.
//
// ENV VARIABLE: SQUARE_DEPOSIT_LINK (set in Cloudflare Worker env settings)
// Format: the Square payment link URL from your Square dashboard
// If not set, emails include a placeholder and Ted pastes the link manually.
// ─────────────────────────────────────────────────────────────────────────────

function allproPaymentEmailHtml({ customerName, milestoneLabel, milestonePct, amount, totalContract, squareLink, jobDescription, proposalNum, isReminder, reminderNum, blockMessage }) {
  var usd = function(n) { return '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var linkHtml = squareLink
    ? '<div style="text-align:center;margin:28px 0"><a href="' + squareLink + '" style="background:#F2B705;color:#1A1D21;text-decoration:none;padding:14px 32px;border-radius:8px;font-family:Arial,sans-serif;font-weight:700;font-size:16px;display:inline-block">Pay ' + usd(amount) + ' via Square →</a></div>'
    : '<div style="background:#FFF8E6;border:1px solid #F2B705;border-radius:8px;padding:14px 18px;margin:24px 0;font-family:Arial,sans-serif;font-size:14px"><strong>Payment Amount Due: ' + usd(amount) + '</strong><br>Ted Scholl will send you a Square payment link shortly at this email address, or you may pay in person via the AllPro tablet.</div>';
  var subjectPrefix = isReminder ? ('REMINDER ' + (reminderNum === 2 ? '— FINAL NOTICE ' : '') + '— ') : '';
  var urgencyHtml = '';
  if (isReminder && reminderNum === 1) {
    urgencyHtml = '<div style="background:#FEF3C7;border-left:4px solid #F2B705;padding:12px 16px;margin-bottom:20px;font-size:14px"><strong>Friendly Reminder:</strong> We have not yet received your ' + milestoneLabel + ' payment of ' + usd(amount) + '. Please complete payment at your earliest convenience to keep your project on schedule.</div>';
  }
  if (isReminder && reminderNum === 2) {
    urgencyHtml = '<div style="background:#FEE2E2;border-left:4px solid #C8102E;padding:12px 16px;margin-bottom:20px;font-size:14px"><strong>⚠️ Action Required:</strong> Your ' + milestoneLabel + ' payment of ' + usd(amount) + ' is outstanding. ' + (blockMessage || '') + ' Please contact Ted Scholl at 267-421-6336 or reply to this email immediately.</div>';
  }
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
    + '<img src="https://my.termac.com/allpro-letterhead.png" alt="AllPro Stainless Steel" style="width:260px;height:auto;margin-bottom:16px"><br>'
    + '<p>Dear ' + customerName + ',</p>'
    + urgencyHtml
    + '<p>' + (isReminder ? 'This is a reminder that your ' : 'Your project has reached the ') + '<strong>' + milestoneLabel + ' (' + milestonePct + '%)</strong>' + (isReminder ? ' payment remains outstanding.' : ' milestone.') + '</p>'
    + '<p>As outlined in your signed proposal, a payment of <strong>' + usd(amount) + '</strong> is due at this stage of your project.</p>'
    + '<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">'
    + '<tr><td style="padding:8px 12px;background:#F8F9FA;font-weight:700">Project</td><td style="padding:8px 12px;background:#F8F9FA">' + (jobDescription || proposalNum) + '</td></tr>'
    + '<tr><td style="padding:8px 12px">Proposal #</td><td style="padding:8px 12px">' + proposalNum + '</td></tr>'
    + '<tr><td style="padding:8px 12px;background:#F8F9FA">Contract Total</td><td style="padding:8px 12px;background:#F8F9FA">' + usd(totalContract) + '</td></tr>'
    + '<tr><td style="padding:8px 12px"><strong>' + milestoneLabel + ' Due</strong></td><td style="padding:8px 12px"><strong style="color:#C8102E">' + usd(amount) + '</strong></td></tr>'
    + '</table>'
    + linkHtml
    + (squareLink ? '<p style="font-size:12px;color:#6B7280;text-align:center">You can also pay in person at the job site via the AllPro Samsung tablet.</p>' : '')
    + '<p>Questions? Call Ted Scholl directly at <strong>267-421-6336</strong> or reply to this email.</p>'
    + '<p>Thank you — we look forward to completing your project.</p>'
    + '<hr style="margin:24px 0;border:none;border-top:1px solid #E5E7EB">'
    + '<p style="font-size:12px;color:#6B7280">AllPro Stainless Steel and Metal Fabrication | 7330 Tulip Street, Philadelphia PA 19136<br>'
    + 'Phone: 215-928-9191 | Fax: 215-333-9133 | Toll-Free: 1-800-601-4663<br>'
    + 'Payment processed by TerPro LLC · Primary Contact: Ted Scholl — tscholl@termac.com | 267-421-6336</p>'
    + '</div>';
}

async function sendAllProMilestoneEmail(env, { customerEmail, customerName, subject, htmlBody, senderEmail }) {
  senderEmail = senderEmail || 'tscholl@termac.com';
  if (!customerEmail) return false;
  var tokenRow = await env.DB.prepare('SELECT * FROM staff_graph_tokens WHERE staff_email = ?').bind(senderEmail).first();
  if (!tokenRow || !tokenRow.access_token) return false;
  // Refresh if needed
  if (tokenRow.expires_at && tokenRow.expires_at < Date.now() + 60000) {
    try {
      var refreshRes = await fetch('https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.SSO_CLIENT_ID, client_secret: env.SSO_CLIENT_SECRET, refresh_token: tokenRow.refresh_token, scope: 'openid profile email Mail.Send offline_access' })
      });
      var rj = await refreshRes.json();
      if (rj.access_token) { await env.DB.prepare('UPDATE staff_graph_tokens SET access_token=?,expires_at=?,updated_at=? WHERE staff_email=?').bind(rj.access_token, Date.now() + (rj.expires_in || 3600) * 1000, Date.now(), senderEmail).run(); tokenRow.access_token = rj.access_token; }
    } catch(e) {}
  }
  var res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tokenRow.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: htmlBody }, toRecipients: [{ emailAddress: { address: customerEmail } }], ccRecipients: [{ emailAddress: { address: 'tscholl@termac.com' } }] } })
  });
  return res.status === 202;
}

// ── 40% PRE-CONSTRUCTION DRAW ─────────────────────────────────────────────────
// POST: { quote_id, sender_email, square_link? }
// Triggered when stage advances to Pre-Construction (Stage 3)
async function handleAllProDrawSend(request, env) {
  var body; try { body = await request.json(); } catch(e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }
  var quoteId = body.quote_id;
  var senderEmail = body.sender_email || 'tscholl@termac.com';
  var squareLink = body.square_link || env.SQUARE_DRAW_LINK || null;
  if (!quoteId) return jsonResponse({ ok: false, error: 'quote_id required' }, 400);

  var q = await env.DB.prepare('SELECT * FROM allpro_quotes WHERE id = ?').bind(quoteId).first();
  if (!q) return jsonResponse({ ok: false, error: 'Quote not found' }, 404);

  var total = parseFloat(q.grand_total || 0);
  var depositPaid = parseFloat(q.deposit_paid || total * 0.50);
  var drawAmount = total * 0.40;
  var proposalNum = q.project_number || quoteId;
  var customerName = q.customer_name || 'Valued Customer';
  var customerEmail = q.customer_email;
  var jobDescription = q.customer_address || '';

  var htmlBody = allproPaymentEmailHtml({ customerName, milestoneLabel: 'Pre-Construction Draw', milestonePct: 40, amount: drawAmount, totalContract: total, squareLink, jobDescription, proposalNum, isReminder: false });
  var subject = 'AllPro Project #' + proposalNum + ' — Pre-Construction Draw (' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(drawAmount) + ' due)';

  var emailSent = await sendAllProMilestoneEmail(env, { customerEmail, customerName, subject, htmlBody, senderEmail });

  // Log milestone in D1
  await env.DB.prepare('UPDATE allpro_quotes SET draw_sent_at=?, payment_stage=?, updated_at=? WHERE id=?').bind(Date.now(), 'draw_sent', Date.now(), quoteId).run().catch(()=>{});

  // Schedule reminder emails via D1 table (Worker cron will pick these up)
  // Reminder 1: 48 hours; Reminder 2: 5 days (with block warning)
  var reminders = [
    { fire_at: Date.now() + 48*60*60*1000, reminder_num: 1, milestone: 'draw', block_message: '' },
    { fire_at: Date.now() + 5*24*60*60*1000, reminder_num: 2, milestone: 'draw', block_message: 'Fabrication cannot begin until this payment is received.' }
  ];
  for (var r of reminders) {
    await env.DB.prepare('INSERT OR REPLACE INTO allpro_payment_reminders (quote_id, milestone, reminder_num, fire_at, sent, created_at) VALUES (?,?,?,?,0,?)').bind(quoteId, r.milestone, r.reminder_num, r.fire_at, Date.now()).run().catch(()=>{});
  }

  return jsonResponse({ ok: true, email_sent: emailSent, draw_amount: drawAmount, quote_id: quoteId, milestone: 'draw', message: emailSent ? 'Draw invoice emailed to ' + customerEmail : 'Email not sent — check Graph token. Ted CC\'d on all AllPro payment emails.' });
}

// ── 10% FINAL BALANCE ─────────────────────────────────────────────────────────
// POST: { quote_id, sender_email, square_link? }
// Triggered when installation is marked complete (Stage 5 → 6)
async function handleAllProFinalSend(request, env) {
  var body; try { body = await request.json(); } catch(e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }
  var quoteId = body.quote_id;
  var senderEmail = body.sender_email || 'tscholl@termac.com';
  var squareLink = body.square_link || env.SQUARE_FINAL_LINK || null;
  if (!quoteId) return jsonResponse({ ok: false, error: 'quote_id required' }, 400);

  var q = await env.DB.prepare('SELECT * FROM allpro_quotes WHERE id = ?').bind(quoteId).first();
  if (!q) return jsonResponse({ ok: false, error: 'Quote not found' }, 404);

  var total = parseFloat(q.grand_total || 0);
  var finalAmount = total * 0.10;
  var proposalNum = q.project_number || quoteId;
  var customerName = q.customer_name || 'Valued Customer';
  var customerEmail = q.customer_email;
  var jobDescription = q.customer_address || '';

  var htmlBody = allproPaymentEmailHtml({ customerName, milestoneLabel: 'Final Balance', milestonePct: 10, amount: finalAmount, totalContract: total, squareLink, jobDescription, proposalNum, isReminder: false });
  var subject = 'AllPro Project #' + proposalNum + ' — Final Balance (' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(finalAmount) + ' due) — Installation Complete';

  var emailSent = await sendAllProMilestoneEmail(env, { customerEmail, customerName, subject, htmlBody, senderEmail });

  await env.DB.prepare('UPDATE allpro_quotes SET final_sent_at=?, payment_stage=?, updated_at=? WHERE id=?').bind(Date.now(), 'final_sent', Date.now(), quoteId).run().catch(()=>{});

  var reminders = [
    { fire_at: Date.now() + 48*60*60*1000, reminder_num: 1, milestone: 'final', block_message: '' },
    { fire_at: Date.now() + 5*24*60*60*1000, reminder_num: 2, milestone: 'final', block_message: 'AHJ inspection sign-off, warranty filing, and ongoing service account setup are on hold pending final payment.' }
  ];
  for (var r of reminders) {
    await env.DB.prepare('INSERT OR REPLACE INTO allpro_payment_reminders (quote_id, milestone, reminder_num, fire_at, sent, created_at) VALUES (?,?,?,?,0,?)').bind(quoteId, r.milestone, r.reminder_num, r.fire_at, Date.now()).run().catch(()=>{});
  }

  return jsonResponse({ ok: true, email_sent: emailSent, final_amount: finalAmount, quote_id: quoteId, milestone: 'final', message: emailSent ? 'Final balance invoice emailed to ' + customerEmail : 'Email not sent — check Graph token.' });
}

// ── LOG PAYMENT RECEIVED ──────────────────────────────────────────────────────
// POST: { quote_id, milestone ('deposit'|'draw'|'final'), amount_received, payment_method, logged_by }
// Called manually by Ted when Square confirms payment cleared
async function handleAllProPaymentLogged(request, env) {
  var body; try { body = await request.json(); } catch(e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }
  var quoteId = body.quote_id;
  var milestone = body.milestone; // 'deposit', 'draw', 'final'
  var amount = parseFloat(body.amount_received || 0);
  var method = body.payment_method || 'Square';
  var loggedBy = body.logged_by || 'tscholl@termac.com';
  if (!quoteId || !milestone) return jsonResponse({ ok: false, error: 'quote_id and milestone required' }, 400);

  var fieldMap = { deposit: 'deposit_paid_at', draw: 'draw_paid_at', final: 'final_paid_at' };
  var amtMap   = { deposit: 'deposit_paid', draw: 'draw_paid', final: 'final_paid' };
  var field = fieldMap[milestone];
  var amtField = amtMap[milestone];
  if (!field) return jsonResponse({ ok: false, error: 'Invalid milestone' }, 400);

  await env.DB.prepare('UPDATE allpro_quotes SET ' + field + '=?, ' + amtField + '=?, payment_stage=?, updated_at=? WHERE id=?').bind(Date.now(), amount, milestone + '_paid', Date.now(), quoteId).run().catch(()=>{});

  // Cancel pending reminders for this milestone
  await env.DB.prepare('UPDATE allpro_payment_reminders SET sent=1, cancelled=1 WHERE quote_id=? AND milestone=? AND sent=0').bind(quoteId, milestone).run().catch(()=>{});

  return jsonResponse({ ok: true, quote_id: quoteId, milestone, amount_received: amount, payment_method: method, logged_by: loggedBy, message: milestone.charAt(0).toUpperCase() + milestone.slice(1) + ' payment of $' + amount.toLocaleString('en-US',{minimumFractionDigits:2}) + ' logged via ' + method + '.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// SQUARE WEBHOOK RECEIVER
// ─────────────────────────────────────────────────────────────────────────────
// Setup in Square Dashboard:
//   Developers → Webhooks → Add webhook endpoint
//   URL: https://termac-staff-auth.termac-one.workers.dev/square-webhook
//   Events: payment.completed
//   Signature Key: set SQUARE_WEBHOOK_SIGNATURE_KEY in Cloudflare env vars
//
// When a customer pays via Square (tap, card, or link), Square POSTs here.
// We match the payment amount to the right project milestone, log it as paid,
// cancel reminders, advance the stage, and email Ted a notification.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSquareWebhook(request, env) {
  // Verify Square webhook signature (HMAC-SHA256)
  var signatureKey = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (signatureKey) {
    var bodyText = await request.text();
    var squareSig = request.headers.get('x-square-hmacsha256-signature') || '';
    // Compute expected signature
    var encoder = new TextEncoder();
    var keyData = encoder.encode(signatureKey);
    var msgData = encoder.encode(request.url + bodyText);
    var cryptoKey = await crypto.subtle.importKey('raw', keyData, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    var sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    var sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    if (sigB64 !== squareSig) {
      console.error('Square webhook signature mismatch');
      return new Response('Unauthorized', { status: 401 });
    }
    var payload;
    try { payload = JSON.parse(bodyText); } catch(e) { return new Response('Bad JSON', { status: 400 }); }
    return await processSquarePayment(payload, env);
  }
  // If no signature key configured yet (during setup), still process but log warning
  var payload;
  try { payload = await request.json(); } catch(e) { return new Response('Bad JSON', { status: 400 }); }
  console.warn('Square webhook: no signature key configured -- set SQUARE_WEBHOOK_SIGNATURE_KEY in env');
  return await processSquarePayment(payload, env);
}

async function processSquarePayment(payload, env) {
  // Square sends: { type: 'payment.completed', data: { object: { payment: { amount_money: { amount, currency }, note, order_id, buyer_email_address, ... } } } }
  if (payload.type !== 'payment.completed' && payload.type !== 'payment.updated') {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'Event type not payment.completed' }), { status: 200 });
  }

  var payment = payload?.data?.object?.payment;
  if (!payment) return new Response('No payment object', { status: 400 });

  var amountCents = payment.amount_money?.amount || 0;
  var amountDollars = amountCents / 100;
  var note = (payment.note || '').toLowerCase();
  var buyerEmail = payment.buyer_email_address || payment.buyer_email || '';
  var squarePaymentId = payment.id || '';

  // Try to identify project from payment note
  // Recommended note format when generating Square link: "AllPro #QUOTE_ID Draw" or "AllPro #QUOTE_ID Final"
  // e.g. "AllPro #Q1A2B3 Draw" or "AllPro #Q1A2B3 Final"
  var quoteIdMatch = note.match(/allpro\s+#?([a-z0-9]+)/i);
  var milestoneMatch = note.match(/\b(deposit|draw|final)\b/i);
  var quoteId = quoteIdMatch ? quoteIdMatch[1].toUpperCase() : null;
  var milestone = milestoneMatch ? milestoneMatch[1].toLowerCase() : null;

  // If we can't identify from note, try to match by email + amount
  if (!quoteId && buyerEmail) {
    var match = await env.DB.prepare(
      'SELECT id, customer_name, customer_email, grand_total, payment_stage FROM allpro_quotes WHERE customer_email = ? AND payment_stage NOT IN (\'paid_in_full\') ORDER BY created_at DESC LIMIT 5'
    ).bind(buyerEmail).all();
    var rows = match.results || [];
    for (var r of rows) {
      var total = parseFloat(r.grand_total || 0);
      var pcts = [0.50, 0.40, 0.10];
      var milestones = ['deposit', 'draw', 'final'];
      for (var i = 0; i < pcts.length; i++) {
        var expected = Math.round(total * pcts[i] * 100); // cents
        if (Math.abs(expected - amountCents) < 100) { // within $1 tolerance
          quoteId = r.id;
          milestone = milestones[i];
          break;
        }
      }
      if (quoteId) break;
    }
  }

  if (!quoteId || !milestone) {
    // Can't match -- send Ted an alert and log it
    await notifyTed(env, {
      subject: 'Square Payment Received — Could Not Auto-Match (' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amountDollars) + ')',
      body: '<p>A Square payment of <strong>' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amountDollars) + '</strong> was received but could not be automatically matched to a project.</p><p>Square Payment ID: ' + squarePaymentId + '<br>Buyer Email: ' + buyerEmail + '<br>Note on payment: ' + (payment.note || '(none)') + '</p><p>Please log this manually in the AllPro CRM.</p><p><strong>Tip:</strong> When generating Square payment links, add a note like "AllPro #QUOTE_ID Draw" so future payments match automatically.</p>'
    });
    return new Response(JSON.stringify({ ok: false, matched: false, reason: 'Could not match payment to project', amount: amountDollars }), { status: 200 });
  }

  // Log payment
  var fieldMap = { deposit: 'deposit_paid_at', draw: 'draw_paid_at', final: 'final_paid_at' };
  var amtMap   = { deposit: 'deposit_paid', draw: 'draw_paid', final: 'final_paid' };
  var nextStageMap = { deposit: 'deposit_paid', draw: 'draw_paid', final: 'final_paid' };

  // Determine new payment_stage and whether all paid
  var q = await env.DB.prepare('SELECT * FROM allpro_quotes WHERE id = ?').bind(quoteId).first();
  var totalPaid = (parseFloat(q?.deposit_paid || 0)) + (parseFloat(q?.draw_paid || 0)) + (parseFloat(q?.final_paid || 0)) + amountDollars;
  var grandTotal = parseFloat(q?.grand_total || 0);
  var newPaymentStage = totalPaid >= grandTotal * 0.99 ? 'paid_in_full' : nextStageMap[milestone];

  await env.DB.prepare(
    'UPDATE allpro_quotes SET ' + fieldMap[milestone] + '=?, ' + amtMap[milestone] + '=?, payment_stage=?, square_payment_id=?, updated_at=? WHERE id=?'
  ).bind(Date.now(), amountDollars, newPaymentStage, squarePaymentId, Date.now(), quoteId).run().catch(()=>{});

  // Cancel reminders for this milestone
  await env.DB.prepare(
    'UPDATE allpro_payment_reminders SET sent=1, cancelled=1 WHERE quote_id=? AND milestone=? AND sent=0'
  ).bind(quoteId, milestone).run().catch(()=>{});

  // Auto-advance stage in CRM opportunities
  var stageAdvanceMap = { deposit: 'Pre-Construction', draw: 'Fabrication', final: 'Inspection / Closeout' };
  var newApStage = stageAdvanceMap[milestone];
  if (newApStage) {
    var opps = await env.DB.prepare('SELECT * FROM allpro_quotes WHERE id = ?').bind(quoteId).all().catch(()=>({ results: [] }));
    // Update opportunity apStage field
    await env.DB.prepare('UPDATE allpro_quotes SET ap_stage=?, updated_at=? WHERE id=?').bind(newApStage, Date.now(), quoteId).run().catch(()=>{});
  }

  var milestoneLabel = { deposit: '50% Deposit', draw: '40% Pre-Construction Draw', final: '10% Final Balance' };
  var usd = function(n) { return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n); };

  // Notify Ted
  await notifyTed(env, {
    subject: '✅ AllPro Payment Received — ' + milestoneLabel[milestone] + ' (' + usd(amountDollars) + ') — Project ' + quoteId,
    body: '<div style="font-family:Arial,sans-serif;max-width:600px"><img src="https://my.termac.com/allpro-letterhead.png" style="width:200px;margin-bottom:12px"><br>'
      + '<h2 style="color:#16A34A">✅ Payment Received — Stage Advanced Automatically</h2>'
      + '<table style="border-collapse:collapse;font-size:14px;width:100%">'
      + '<tr><td style="padding:8px 12px;background:#F8F9FA;font-weight:700">Project</td><td style="padding:8px 12px">' + (q?.customer_name || quoteId) + '</td></tr>'
      + '<tr><td style="padding:8px 12px;font-weight:700">Quote ID</td><td style="padding:8px 12px">' + quoteId + '</td></tr>'
      + '<tr><td style="padding:8px 12px;background:#F8F9FA;font-weight:700">Milestone</td><td style="padding:8px 12px">' + milestoneLabel[milestone] + '</td></tr>'
      + '<tr><td style="padding:8px 12px;font-weight:700">Amount Received</td><td style="padding:8px 12px" style="color:#16A34A"><strong>' + usd(amountDollars) + '</strong></td></tr>'
      + '<tr><td style="padding:8px 12px;background:#F8F9FA;font-weight:700">Stage Advanced To</td><td style="padding:8px 12px">' + (newApStage || '(see CRM)') + '</td></tr>'
      + '<tr><td style="padding:8px 12px;font-weight:700">Payment via</td><td style="padding:8px 12px">Square (TerPro LLC)</td></tr>'
      + '<tr><td style="padding:8px 12px;background:#F8F9FA;font-weight:700">Square Payment ID</td><td style="padding:8px 12px">' + squarePaymentId + '</td></tr>'
      + (newPaymentStage === 'paid_in_full' ? '<tr><td colspan="2" style="padding:10px 12px;background:#D1FAE5;color:#065F46;font-weight:700;text-align:center">🎉 PROJECT PAID IN FULL — ' + usd(grandTotal) + ' collected</td></tr>' : '')
      + '</table>'
      + '<p style="margin-top:16px">Reminders cancelled. No further action needed on payment for this milestone.</p>'
      + '<p style="font-size:12px;color:#6B7280">AllPro Project Management System · TerPro LLC · tscholl@termac.com</p>'
      + '</div>'
  });

  return new Response(JSON.stringify({ ok: true, matched: true, quote_id: quoteId, milestone, amount: amountDollars, new_stage: newApStage, payment_stage: newPaymentStage }), { status: 200 });
}

async function notifyTed(env, { subject, body }) {
  // Send notification email to Ted via Graph
  var tedEmail = 'tscholl@termac.com';
  var tokenRow = await env.DB.prepare('SELECT * FROM staff_graph_tokens WHERE staff_email = ?').bind(tedEmail).first().catch(()=>null);
  if (!tokenRow?.access_token) return;
  // Refresh if needed
  if (tokenRow.expires_at && tokenRow.expires_at < Date.now() + 60000) {
    try {
      var r = await fetch('https://login.microsoftonline.com/' + env.SSO_TENANT_ID + '/oauth2/v2.0/token', {
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({ grant_type:'refresh_token', client_id:env.SSO_CLIENT_ID, client_secret:env.SSO_CLIENT_SECRET, refresh_token:tokenRow.refresh_token, scope:'openid profile email Mail.Send offline_access' })
      });
      var rj = await r.json();
      if (rj.access_token) { await env.DB.prepare('UPDATE staff_graph_tokens SET access_token=?,expires_at=?,updated_at=? WHERE staff_email=?').bind(rj.access_token, Date.now()+(rj.expires_in||3600)*1000, Date.now(), tedEmail).run(); tokenRow.access_token = rj.access_token; }
    } catch(e) {}
  }
  await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method:'POST',
    headers:{'Authorization':'Bearer '+tokenRow.access_token,'Content-Type':'application/json'},
    body: JSON.stringify({ message: { subject, body:{ contentType:'HTML', content:body }, toRecipients:[{ emailAddress:{ address:tedEmail } }] } })
  }).catch(()=>{});
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON: PROCESS PAYMENT REMINDERS (runs hourly via scheduled trigger)
// ─────────────────────────────────────────────────────────────────────────────
async function processPaymentReminders(env) {
  var now = Date.now();
  // Find all due, unsent, uncancelled reminders
  var due = await env.DB.prepare(
    'SELECT r.*, q.customer_name, q.customer_email, q.grand_total, q.project_number, q.customer_address FROM allpro_payment_reminders r LEFT JOIN allpro_quotes q ON r.quote_id = q.id WHERE r.fire_at <= ? AND r.sent = 0 AND r.cancelled = 0 LIMIT 50'
  ).bind(now).all().catch(()=>({ results: [] }));

  var rows = due.results || [];
  var processed = 0;

  for (var row of rows) {
    var total = parseFloat(row.grand_total || 0);
    var pctMap = { deposit: 0.50, draw: 0.40, final: 0.10 };
    var labelMap = { deposit: '50% Deposit', draw: '40% Pre-Construction Draw', final: '10% Final Balance' };
    var blockMap = {
      deposit: 'Your project cannot be scheduled until the deposit is received.',
      draw: 'Fabrication cannot begin until this payment is received.',
      final: 'AHJ inspection sign-off, warranty filing, and ongoing service setup are on hold pending final payment.'
    };
    var amount = total * (pctMap[row.milestone] || 0);
    var milestoneLabel = labelMap[row.milestone] || row.milestone;
    var blockMessage = row.reminder_num >= 2 ? blockMap[row.milestone] : '';

    var htmlBody = allproPaymentEmailHtml({
      customerName: row.customer_name || 'Valued Customer',
      milestoneLabel,
      milestonePct: Math.round((pctMap[row.milestone] || 0) * 100),
      amount,
      totalContract: total,
      squareLink: null, // Ted will send Square link separately if needed
      jobDescription: row.customer_address || '',
      proposalNum: row.project_number || row.quote_id,
      isReminder: true,
      reminderNum: row.reminder_num,
      blockMessage
    });

    var subjectPrefix = row.reminder_num === 1 ? 'REMINDER — ' : '⚠️ FINAL NOTICE — ';
    var usd = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount);
    var subject = subjectPrefix + 'AllPro Payment Due: ' + milestoneLabel + ' (' + usd + ') — Project ' + (row.project_number || row.quote_id);

    var sent = await sendAllProMilestoneEmail(env, {
      customerEmail: row.customer_email,
      customerName: row.customer_name || 'Valued Customer',
      subject,
      htmlBody,
      senderEmail: 'tscholl@termac.com'
    });

    await env.DB.prepare(
      'UPDATE allpro_payment_reminders SET sent=1, sent_at=? WHERE id=?'
    ).bind(now, row.id).run().catch(()=>{});

    // Notify Ted that a reminder went out
    if (sent) {
      await notifyTed(env, {
        subject: '📧 AllPro Reminder Sent — ' + milestoneLabel + ' (' + usd + ') — ' + (row.customer_name || row.quote_id),
        body: '<p>Reminder #' + row.reminder_num + ' was automatically sent to <strong>' + row.customer_email + '</strong> for the ' + milestoneLabel + ' payment of <strong>' + usd + '</strong> on project ' + (row.project_number || row.quote_id) + '.</p>' + (blockMessage ? '<p><strong>Message included:</strong> ' + blockMessage + '</p>' : '') + '<p>If payment has already been received via Square, log it in the AllPro system to cancel further reminders.</p>'
      });
    }

    processed++;
  }

  console.log('Payment reminder cron: processed ' + processed + ' of ' + rows.length + ' due reminders');
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLPRO INSTALL ASSESSMENT — Save and Score
// POST /allpro-assessment-save
// Body: all allpro_install_assessments fields as JSON
// Returns: { ok, assessment_id, install_tier, risk_score, co_allowance, risk_flags, co_line_items }
// ─────────────────────────────────────────────────────────────────────────────
function scoreInstallAssessment(a) {
  var score = 0;
  var flags = [];
  var coItems = []; // { label, low, high, trigger }
  var solidFuelOverride = false;

  // Solid fuel — AUTO L3 OVERRIDE
  var sfType = a.solid_fuel_type;
  if (sfType && sfType !== 'none' && sfType !== '') {
    solidFuelOverride = true;
    score = Math.max(score, 9);
    flags.push('SOLID FUEL (' + sfType + '): Automatic L3 — dedicated duct run and NFPA 96 Ch.14 compliance required');
    coItems.push({ label: 'Dedicated Secondary Duct Run (Solid Fuel — NFPA 96 Ch.14)', low: 3500, high: 8500, trigger: 'sf_duct' });
    if (a.solid_fuel_spark_arrestors !== 'present') {
      coItems.push({ label: 'Spark Arrestor Filter Set (UL-listed)', low: 400, high: 900, trigger: 'sf_spark' });
      flags.push('Spark arrestor filters not confirmed — UL-listed set required');
    }
    if (a.solid_fuel_floor === 'combustible' || a.solid_fuel_floor === 'unknown') {
      flags.push('COMBUSTIBLE FLOOR — non-combustible hearth pad (3ft clearance) required. GC/customer scope.');
    }
    if (a.solid_fuel_firebox_size === 'over5' && a.solid_fuel_water_line !== 'yes') {
      coItems.push({ label: 'Plumbing / Water Line & Hose Reel (firebox >5 cu ft)', low: 1200, high: 2800, trigger: 'sf_plumbing' });
      flags.push('Firebox over 5 cu ft — dedicated water line and hose reel required by code');
    }
    if (a.solid_fuel_mist_system === 'required' || a.solid_fuel_mist_system === 'recommended') {
      coItems.push({ label: 'Water-Wash / Mist Suppression System', low: 2000, high: 5000, trigger: 'sf_mist' });
    }
    var doorCount = parseInt(a.solid_fuel_door_count) || 0;
    if (a.solid_fuel_access_doors === 'none' || a.solid_fuel_access_doors === 'partial' || doorCount > 0) {
      var dc = doorCount || 2;
      coItems.push({ label: 'Creosote Cleanout Access Doors (' + dc + ' est.)', low: 300 * dc, high: 600 * dc, trigger: 'sf_doors' });
    }
    if (a.solid_fuel_creosote === 'heavy') { flags.push('HEAVY CREOSOTE — professional cleaning required before work begins'); }
    if (a.solid_fuel_duct === 'shared') { flags.push('CODE VIOLATION: Shared duct with solid fuel — separate run mandatory'); }
  }

  // Structural
  if (a.struct_drop_ceiling) { score += 2; flags.push('Drop ceiling present — unistrut framing required'); coItems.push({ label: 'Structural Unistrut / Trapeze Framing', low: 800, high: 2500, trigger: 'drop_ceiling' }); }
  if (!a.struct_support_above || a.struct_support_above === 'none' || a.struct_support_above === 'unknown') { score += 3; flags.push('No structural support directly above hood footprint'); }
  if (a.struct_fire_rated_wrap) { score += 2; flags.push('Fire-rated duct wrap required (NFPA 96)'); coItems.push({ label: 'Fire-Rated Duct Wrap (NFPA 96)', low: 1500, high: 4500, trigger: 'fire_rated_wrap' }); }
  if (a.struct_multi_story) { score += 3; flags.push('Multi-story building — extended duct run and fire wrap likely'); }

  // Roof/penetration
  if (['concrete', 'brick', 'masonry'].includes((a.roof_deck_type || '').toLowerCase())) { score += 2; flags.push('Concrete/masonry roof deck — custom curbing required'); coItems.push({ label: 'Roof Penetration, Curbing & Flashing', low: 1000, high: 3000, trigger: 'hard_roof' }); }
  if (a.roof_core_drilling) { score += 2; flags.push('Core drilling required — ' + (a.roof_core_material || 'material TBD')); coItems.push({ label: 'Core Drilling / Masonry Penetration', low: 500, high: 1800, trigger: 'core_drilling' }); }
  if ((a.roof_offset_count || 0) >= 2) { score += 2; flags.push((a.roof_offset_count) + ' duct offsets required'); }
  if ((a.mech_duct_run_ft || 0) > 10) { score += 2; flags.push('Duct run over 10ft (' + a.mech_duct_run_ft + 'ft) — cleanout access doors required'); }

  // Electrical
  if (!a.elec_dedicated_circuit) { score += 2; flags.push('No dedicated circuit — new circuit required'); }
  if ((a.elec_panel_open_slots || 0) === 0) { score += 2; flags.push('Panel has no open slots — sub-panel or upgrade may be required'); coItems.push({ label: 'Electrical Panel Upgrade / Sub-Panel', low: 1200, high: 3000, trigger: 'no_panel_slots' }); }
  if (!a.elec_shunt_trip || a.elec_shunt_trip === 'missing' || a.elec_shunt_trip === 'needs_install') { score += 2; flags.push('Shunt-trip breaker not installed — required by code'); coItems.push({ label: 'Gas Solenoid Valve & Electrical Shunt-Trip', low: 1200, high: 3000, trigger: 'missing_shunt_trip' }); }
  if (!a.elec_gas_solenoid || a.elec_gas_solenoid === 'missing' || a.elec_gas_solenoid === 'needs_install') { score += 2; flags.push('Gas solenoid valve not installed — required for suppression interlock'); }
  if ((a.elec_panel_distance_ft || 0) > 25) { score += 1; flags.push('Panel over 25ft from hood — extended interlock wiring run'); }

  // Mechanical
  if (!a.mech_mua_present || a.mech_mua_present === 'none' || a.mech_mua_present === 'missing') { score += 3; flags.push('No make-up air unit — MUA integration required to prevent negative pressure'); coItems.push({ label: 'Make-Up Air Interlock / Control Package', low: 3500, high: 9000, trigger: 'no_mua' }); }

  // Fire alarm
  if (!a.fire_facp_present || a.fire_facp_present === 'unknown') { score += 1; flags.push('Fire alarm panel status unknown — verify before install'); }
  if ((a.fire_facp_distance_ft || 0) > 25) { score += 2; flags.push('FACP over 25ft from hood — extended low-voltage wiring run'); coItems.push({ label: 'Fire Alarm Panel Tie-In / Relay Module', low: 750, high: 2200, trigger: 'facp_distance' }); }

  // Determine tier and allowance
  var tier, allowance;
  if (solidFuelOverride || score > 8) { tier = 'L3'; allowance = 3000; }
  else if (score <= 3) { tier = 'L1'; allowance = 0; }
  else { tier = 'L2'; allowance = 1500; }

  return { score, tier, allowance, flags, coItems, solidFuelOverride };
}

async function handleAssessmentSave(request, env) {
  var body; try { body = await request.json(); } catch(e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }
  if (!body.survey_id && !body.opportunity_id) return jsonResponse({ ok: false, error: 'survey_id or opportunity_id required' }, 400);

  var scored = scoreInstallAssessment(body);
  var id = body.id || ('AIA-' + Date.now().toString(36).toUpperCase());
  var now = Date.now();

  await env.DB.prepare(`INSERT OR REPLACE INTO allpro_install_assessments
    (id, survey_id, opportunity_id, location_id, rep_name, assessed_date,
     struct_ceiling_access, struct_drop_ceiling, struct_deck_type, struct_support_above,
     struct_unistrut_required, struct_fire_rated_wrap, struct_multi_story,
     roof_deck_type, roof_penetration_type, roof_core_drilling, roof_core_material,
     roof_straight_run, roof_offset_count,
     elec_dedicated_circuit, elec_panel_open_slots, elec_shunt_trip, elec_gas_solenoid,
     elec_panel_distance_ft, elec_sub_panel_needed,
     mech_mua_present, mech_mua_cfm, mech_exhaust_fan_ok, mech_duct_run_ft, mech_duct_elbow_count,
     fire_facp_present, fire_facp_distance_ft, fire_facp_age, fire_prior_suppression,
     access_roof, access_ceiling, access_height_ft, access_confined_space, access_notes,
     install_risk_score, install_tier, co_allowance, risk_flags_json, co_line_items_json,
     photos_json, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, body.survey_id||null, body.opportunity_id||null, body.location_id||null,
    body.rep_name||'Ted Scholl', body.assessed_date||new Date(now).toISOString().slice(0,10),
    body.struct_ceiling_access||null, body.struct_drop_ceiling?1:0, body.struct_deck_type||null, body.struct_support_above||null,
    body.struct_unistrut_required?1:0, body.struct_fire_rated_wrap?1:0, body.struct_multi_story?1:0,
    body.roof_deck_type||null, body.roof_penetration_type||null, body.roof_core_drilling?1:0, body.roof_core_material||null,
    body.roof_straight_run!==false?1:0, body.roof_offset_count||0,
    body.elec_dedicated_circuit?1:0, body.elec_panel_open_slots||0, body.elec_shunt_trip||null, body.elec_gas_solenoid||null,
    body.elec_panel_distance_ft||null, body.elec_sub_panel_needed?1:0,
    body.mech_mua_present||null, body.mech_mua_cfm||null, body.mech_exhaust_fan_ok?1:0, body.mech_duct_run_ft||null, body.mech_duct_elbow_count||0,
    body.fire_facp_present||null, body.fire_facp_distance_ft||null, body.fire_facp_age||null, body.fire_prior_suppression?1:0,
    body.access_roof||null, body.access_ceiling||null, body.access_height_ft||null, body.access_confined_space?1:0, body.access_notes||null,
    scored.score, scored.tier, scored.allowance,
    JSON.stringify(scored.flags), JSON.stringify(scored.coItems),
    body.photos_json ? JSON.stringify(body.photos_json) : null,
    now, now
  ).run();

  return jsonResponse({
    ok: true,
    assessment_id: id,
    install_tier: scored.tier,
    risk_score: scored.score,
    co_allowance: scored.allowance,
    risk_flags: scored.flags,
    co_line_items: scored.coItems,
    message: 'Assessment saved. Install tier: ' + scored.tier + ' (score: ' + scored.score + '). ' + scored.flags.length + ' risk flag(s) identified.'
  });
}
