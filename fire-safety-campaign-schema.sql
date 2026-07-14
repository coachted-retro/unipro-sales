-- Fire Safety Drip Campaign schema, added 2026-07-14 per Ted.
-- Sends real email through the existing Resend integration (termac-notify
-- worker's /send-report endpoint, same one Report Settings already uses),
-- on a daily cron inside unipro-ai-proxy. No Brevo dependency. When Brevo
-- eventually goes live, campaign_content/campaign_sends stay as the data
-- model either way -- only the send mechanism would change.

-- Rotating email copy for each track. sequence_number controls rotation
-- order per recipient (send #1 gets sequence_number 1, send #2 gets
-- sequence_number 2, wrapping back to 1 after the last active row).
CREATE TABLE IF NOT EXISTS campaign_content (
  id              TEXT PRIMARY KEY,
  campaign        TEXT NOT NULL,     -- 'customer_monthly' | 'prospect_biweekly'
  sequence_number INTEGER NOT NULL,
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  active          INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- One row per email actually sent. This is both the audit trail and the
-- gate that stops anyone from being double-touched -- the cron checks
-- for a row here newer than the campaign's interval before sending again.
CREATE TABLE IF NOT EXISTS campaign_sends (
  id              TEXT PRIMARY KEY,
  campaign        TEXT NOT NULL,
  target_type     TEXT NOT NULL,     -- 'account' | 'lead'
  target_id       TEXT NOT NULL,
  content_id      TEXT,
  recipient_email TEXT,
  status          TEXT DEFAULT 'sent', -- 'sent' | 'failed' | 'skipped_no_email'
  sent_at         INTEGER NOT NULL
);

-- Anyone who clicks the unsubscribe link in a campaign email lands here.
-- Checked before every send, separate from account/lead status so it
-- never touches the real account or lead record.
CREATE TABLE IF NOT EXISTS campaign_optouts (
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  opted_out_at    INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

-- ─────────────────────────────────────────────────────────────
-- CUSTOMER TRACK (customer_monthly) — existing accounts, monthly,
-- educational + cross-sell, low pressure.
-- ─────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO campaign_content (id, campaign, sequence_number, subject, body_html, active, created_at, updated_at) VALUES
('CC-CUST-01','customer_monthly',1,
 'Quick reminder on your hood suppression system',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted with Termac.</p>
<p>Quick one for you: NFPA 96 requires your kitchen hood suppression system to be inspected every six months, not once a year. It is the most commonly missed compliance detail we run into, and it is usually what an insurance adjuster or fire marshal checks first if there is ever an incident.</p>
<p>If you are not sure when your last inspection was, just reply to this email and we will pull it up for you.</p>
<p>Also worth knowing: Termac is not just your hood suppression vendor. We run the full system for commercial kitchens, extinguishers, emergency exit lighting, grease trap service, filter exchange, dish machines and chemicals, and custom stainless fabrication. If any of that would be useful to consolidate under one vendor, let me know.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-CUST-02','customer_monthly',2,
 'The gauge you should be checking on your extinguishers',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted.</p>
<p>Small thing that gets missed a lot: the pressure gauge on a fire extinguisher should sit in the green zone. If the needle has drifted into the red on either side, that unit is not compliant even if the tag looks current. Worth a quick walk-through of your units between our annual visits.</p>
<p>While I have you, a lot of our fire suppression customers do not realize we also handle grease trap cleaning and the filter exchange program that keeps your hood filters from turning into a fire risk between cleanings. Two things worth bundling in if you are not already using them.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-CUST-03','customer_monthly',3,
 'Grease trap backups are the most avoidable call we get',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted.</p>
<p>A grease trap backup is one of the most preventable, most disruptive things that can happen to a kitchen mid-service. If yours is not on a set cleaning schedule with us, it should be, since the cost of a service call is always smaller than the cost of a shutdown.</p>
<p>Same logic applies to your hood filters. Our filter exchange program swaps them on a set rotation so grease never builds up past what a normal cleaning can handle.</p>
<p>Happy to take a look at your current schedule for either one, just reply here.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-CUST-04','customer_monthly',4,
 'Emergency exit lighting: the 90-minute test nobody remembers',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted.</p>
<p>NFPA 101 requires emergency and exit lighting to hold a charge and stay lit for 90 minutes on battery power alone, tested annually. It is one of the easiest things to let slide since nobody notices a dead battery until the power actually goes out.</p>
<p>If it has been a while since yours were tested, let us know and we will get it on the schedule with your next visit.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-CUST-05','customer_monthly',5,
 'One vendor, full kitchen',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted.</p>
<p>Worth a reminder every so often: Termac Family of Companies is not just fire suppression. Between our divisions we cover hood suppression systems, fire extinguishers, emergency exit lighting, dish machines, cleaning chemicals, custom stainless fabrication, grease trap cleaning, and the filter exchange program. If any part of your kitchen is being handled by a second or third vendor right now, there is a good chance we can bring it under one roof and one point of contact.</p>
<p>No pressure, just wanted it on your radar. Reply here if you want to talk through what that would look like.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-CUST-06','customer_monthly',6,
 'Fusible links: the small part that fails your inspection',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hey, it is Ted.</p>
<p>Fusible links on a hood suppression system have a service life, and once they are contaminated with grease or heat-damaged, NFPA 96 requires them replaced regardless of how the rest of the system looks. It is a cheap part that causes an outsized number of failed inspections when it is overlooked.</p>
<p>If you cannot remember the last time yours were swapped, it is worth flagging for your next visit.</p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000);

-- ─────────────────────────────────────────────────────────────
-- PROSPECT TRACK (prospect_biweekly) — non-customers, every two weeks,
-- persuasive, aimed at booking a free site safety survey with Ted.
-- ─────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO campaign_content (id, campaign, sequence_number, subject, body_html, active, created_at, updated_at) VALUES
('CC-PROS-01','prospect_biweekly',1,
 'A free look at your kitchen''s fire compliance',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Hi, I am Ted Scholl with Termac Family of Companies. We handle fire suppression for commercial kitchens across Eastern PA, NJ, DE, MD and DC, hood systems, extinguishers, and emergency exit lighting.</p>
<p>I would like to offer your location a free, no-obligation site safety survey. I will walk your kitchen, check your suppression system, extinguishers, and exit lighting against current NFPA code, and hand you a plain-English summary of anything that needs attention. No cost, no pressure, just a real look at where you stand.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-PROS-02','prospect_biweekly',2,
 'The inspection detail most kitchens get wrong',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>NFPA 96 requires commercial kitchen hood suppression systems to be inspected every six months, not annually. It is the single most common compliance gap we find on a walkthrough, and it is usually the first thing checked after any kitchen fire incident when insurance gets involved.</p>
<p>If you are not sure where your kitchen stands, I will come take a look at no cost.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-PROS-03','prospect_biweekly',3,
 'One vendor for your whole kitchen, not just suppression',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Most fire protection companies stop at hood suppression. Termac is a full system: hood suppression, fire extinguishers, emergency exit lighting, grease trap cleaning, filter exchange, commercial dish machines and cleaning chemicals, and custom stainless fabrication for any kitchen project.</p>
<p>If you are juggling more than one vendor for any of this, a single point of contact tends to be worth exploring. The free site survey is a low-pressure way to see what that would look like for your kitchen specifically.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-PROS-04','prospect_biweekly',4,
 'What a failed extinguisher inspection actually costs you',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>A fire extinguisher that fails inspection, wrong gauge pressure, missing tag, physical damage, is not just a fine waiting to happen. It is a liability question if anything ever goes wrong and that unit was not actually functional.</p>
<p>My free site survey checks every extinguisher, every hood system, and every exit light against current code and hands you a plain summary of exactly where you stand, no cost, no obligation.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-PROS-05','prospect_biweekly',5,
 'Former chef, now I inspect kitchens for a living',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>Before I did this, I worked as a professional chef, so I know what a working kitchen actually needs from a fire protection vendor: someone who shows up, knows the equipment, and does not slow the line down.</p>
<p>That is the survey I run. Fifteen to thirty minutes, no disruption to service, and you walk away with a real picture of your compliance status and what, if anything, needs attention.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000),

('CC-PROS-06','prospect_biweekly',6,
 'Last note on this, then I will leave it be',
'<div style="font-family:Barlow,Arial,sans-serif;color:#1A1D21;max-width:560px;margin:0 auto">
<div style="background:#1A1D21;padding:18px 24px"><span style="font-family:Barlow Condensed,sans-serif;font-weight:800;color:#fff;font-size:20px;letter-spacing:.5px">TERMAC <span style="color:#C8102E">ONE</span></span></div>
<div style="padding:24px">
<p>I have reached out a few times now about a free fire safety survey for your kitchen. I will keep this one short: fifteen minutes, no cost, and you will know exactly where your hood suppression, extinguishers, and exit lighting stand against code.</p>
<p>If now is not the right time, no problem, just let me know and I will follow up down the road instead.</p>
<p><a href="{{BOOKING_LINK}}" style="display:inline-block;background:#C8102E;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-family:Barlow Condensed,sans-serif;letter-spacing:.05em">BOOK YOUR FREE SURVEY</a></p>
<p>Ted Scholl<br>Termac Family of Companies<br>267-421-6336</p>
</div></div>'
,1,strftime('%s','now')*1000,strftime('%s','now')*1000);
