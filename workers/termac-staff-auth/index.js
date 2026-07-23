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
        case '/calendar-push': return await handleCalendarPush(request, env);
        case '/calendar-pull': return await handleCalendarPull(request, env);
        case '/allpro-survey-submit': return await handleAllProSurveySubmit(request, env);
        case '/allpro-proposal-send': return await handleAllProProposalSend(request, env);
        default: return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'Server error.' }, 500);
    }
  },
};
