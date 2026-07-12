# READ THIS FIRST — Standing Rules for Termac One (unipro-sales repo)

This file exists because this has been an ongoing, multi-session project and
every new Claude session used to guess at conventions differently, causing
real breakage. Before touching ANY file in this repo, read this file in
full. Do not assume, do not guess, do not invent placeholder data — check
this file and the live repo/D1 state first.

## Rule 1 — NEVER give partial code, snippets, or "find this line and change
it" instructions. ALWAYS give the FULL file content, ready for a wholesale
copy/paste replacement. Ted has explicitly stated this is a hard rule: he
loses time hunting for the right line, deletes the wrong thing, and spends
hours undoing it. This applies to every file type in this repo — HTML, JS,
SQL, TOML, everything.

## Rule 2 — NOTHING gets built as localStorage-only, ever, full stop. This
platform is being deployed to ~50 employees. localStorage is invisible to
everyone except the one device it's on. Every feature that stores any data
— including personal tools like calendars, not just shared CRM data — MUST
sync to D1 using the existing crmLoad/crmSave + TermacD1Sync pattern, or a
dedicated D1 table. If a genuinely device-only tool ever seems appropriate
(should be rare to never), flag it to Ted and get explicit confirmation
before building it that way. Never assume.

## Rule 3 — Do not rebuild, recreate, or duplicate anything that already
exists in this repo. Before building any feature, search the live repo
first (grep/find) to check whether it already exists under a different
name than expected. This has caused real damage before — most notably a
table-name collision where two different `allpro_projects` schemas were
built independently because a prior session didn't know the other existed.

## Rule 4 — Confirm before any live code change or push. Explain what will
change and why, then wait for explicit go-ahead before committing/pushing/
deploying. Do not overwrite live files without confirmation.

## Rule 5 — Validation standard before every commit: Python div-balance
check + `node --check` on every extracted inline `<script>` block in every
HTML file touched. This has caught real shipped bugs before (unescaped
apostrophes in JS strings, missing closing braces) that div-balance alone
missed.

## Rule 6 — No em dashes in code (comments, strings, commit messages).

## Rule 7 — Commit identity: Ted Scholl / tscholl@termac.com.

## Rule 8 — GitHub tokens: single-use `ghp_` tokens only. Strip from any
remote URL and treat as dead the moment the session ends. Remind Ted to
revoke if it wasn't already done.

---

## Current Live Infrastructure (verify against the actual dashboard/API
before trusting old notes — this section should be kept updated, but
always double check for drift)

**Cloudflare account:** `termac-one`, login `tscholl@termac.com`,
account ID `bea7f3193e909464b233964390151001`

**D1 database:** `termac-crm`, current live UUID
`3ea2282d-e655-477b-9d5e-560be2a1b40b`
Dead UUID, NEVER use: `27d4d735-...` (belonged to the pre-July-7 database
that was accidentally deleted and rebuilt)

**Working D1 API proxy:** `unipro-ai-proxy.termac-one.workers.dev`
(routes everything under `/db/*` to D1; also serves an Anthropic API proxy
for AI features under POST /)
`ALLOWED_TABLES` inside this worker's own code is the single source of
truth for which D1 tables the API can read/write. Any new table must be
added there before it is usable, and the worker's D1 binding must point at
the CURRENT database UUID above or deploys silently fail (GitHub Actions
can report "success" even when the binding is stale — verify the live code
directly after any deploy touching this worker).

**Dead worker name, does not exist on this account, never reference as
live:** `termac-d1-api`

**Standard secret value used platform-wide:** `termac2026`
(used as `API_SECRET` on `unipro-ai-proxy` and `D1_API_SECRET` on any
worker that talks to it)

**Worker-to-worker calls:** Cloudflare blocks a Worker from calling
another Worker's public `*.workers.dev` URL directly via `fetch()` (returns
Cloudflare error 1042, a plain-text page, not JSON). Any worker that needs
to call `unipro-ai-proxy` (or any other internal worker) MUST use a Service
Binding, not a raw fetch to the public URL. Add the binding in that
worker's Settings -> Bindings in the dashboard AND in its `wrangler.toml`
under `[[services]]`, so it survives a redeploy from GitHub Actions.

**GitHub repo:** `coachted-retro/unipro-sales`
**Pages:** `unipro-sales.pages.dev`, auto-deploys on push to main
**Workers:** deployed via GitHub Actions, all live at
`*.termac-one.workers.dev`

**R2 photo storage:** upload worker
`termac-photo-upload.tedscholl.workers.dev`, public base
`https://pub-d1578de45ac446e1b94b0d5956f367e2.r2.dev`, bucket
`termac-photos`. Path structure: `{division}/{accountId}/current/photo_{n}.jpg`

**Authentication:** all current role gates (PIN, name dropdown) are
PLACEHOLDER ONLY. Real auth will be Azure Entra ID SSO when the Azure
subscription is live. Platform will not roll out to staff until then. Do
not build a "real" auth system to replace the placeholder without
confirming with Ted first.

---

## Known Fragile Spots (check before assuming these are simple)

- **AllPro Project Planner** — three separate tools exist:
  `allpro-project-planner.html` (real, D1-synced, 9-stage kanban),
  `design-portal.html` (Stainless Design Studio, localStorage-only,
  needs D1 conversion per Rule 2), `pm-portal.html` (phase tracker,
  localStorage-only, needs D1 conversion per Rule 2). There has been a
  table-name collision between two different schemas both named
  `allpro_projects` — confirm which schema is authoritative with Ted
  before writing to that table.
- **Site Survey vs Customer Visit** in `sales-portal.html` share an "sv"
  function-prefix naming convention but are completely unrelated
  workflows. Do not conflate them.
- **Old warehouse-portal.html AllPro job board** may still hold real data
  and may conflict with the new Project Planner — confirm supersession
  with Ted before treating the planner as the sole source of truth.
- **Worker deploys are NOT automatic just because a worker folder exists
  under `workers/`.** `.github/workflows/deploy-workers.yml` deploys a
  HARDCODED `WORKERS` list — a new worker folder does nothing until its
  name is added to that list. Two workers (`termac-vault-docs`,
  `bid-scraper`) sat fully written and pushed for a while, silently never
  deploying, because of exactly this. Fixed 2026-07-13, but check this
  list before ever assuming "I pushed it, CI must have deployed it."
- **Validating `node --check` on inline `<script>` blocks in a large HTML
  file:** a plain regex extraction (`<script>...</script>` via `.*?`) can
  be fooled by any JS string that happens to contain literal
  `<script>`/`</script>` text, silently misaligning every block after it
  and producing a false "syntax error" that isn't real. Cost real time
  tracking a phantom bug 2026-07-13. Use Python's `html.parser` module to
  extract script contents instead — it is not fooled by this. Div-balance
  counting (`<div` vs `</div>`) is a simple count, not a paired
  extraction, so it is not affected by this same issue.

---

## Session Log

### 2026-07-13 (evening session, wrapped up here, pick up tomorrow)

**Root-caused and fixed tonight:**
- Bids never actually reached D1 despite multiple earlier attempted fixes,
  because `bidsLoad`/`bidsSave` in `termac-os.html` used a completely
  separate, D1-disconnected `localStorage` key (`termac_bids`) instead of
  going through `crmLoad`/`crmSave` like every other table. Fixed to write
  through the real store.
- The Bid Pipeline's "50% Win Rate" stat seen earlier was computed from
  2 fake seed bids (`bidsSeedIfEmpty()`), not real activity. Disabled,
  board now shows an honest empty state.
- Found and deleted 5 fake demo accounts plus 4 fake demo leads that
  leaked into the live D1 database in two separate events same night
  (explicitly labeled SCENARIO A-E demo data in source: Ferraro
  Ristorante, Midtown Office Plaza, Wu Dim Sum Palace, Fairless Hills
  Retirement Center, Eastside Grille & Bar, plus 4 fake leads). Root
  cause: the purge function meant to prevent this only covered one of two
  different demo-seeder ID schemes in this file. Fixed to cover both,
  bumped purge version to re-run on every browser, added a D1-level
  safety-net delete.
- `bid-scraper` and `termac-vault-docs` workers were fully written and
  pushed but never actually live, see the deploy-pipeline note above.
  Both added to the CI deploy list tonight.
- AllPro Dashboard and Bid Pipeline now open inside `sales-portal.html`
  as an overlay (iframe kept alive, not destroyed) instead of a new
  browser tab, per Ted, switching between them is instant, nothing lost.
  Added a Home button to AllPro (had none). Fixed a ~900ms flash of the
  full Manager Dashboard before Bid Pipeline opened.
- AllPro Project Planner: detail modal now fills the screen instead of a
  small centered box. Project title is directly editable (was static
  text, the literal cause of the stuck "Untitled Project" Ted hit). New
  projects default to `Account Name — Project Type` when left blank.
  Added Delete Project with a warning, using the shared `crmDelete` so it
  actually propagates to D1.

**Left off here, pick up tomorrow:**
1. Full tab-by-tab audit of the Manager Portal Reports section (Revenue &
   Billing, PNL Financials, Operations, Sales Pipeline, Health of
   Customers). Ted flagged this is due for a real accuracy pass, not
   started yet.
2. The "504 vs 6100" active-accounts bug is back, this time specifically
   in the Reports → "All Accounts — Revenue Detail" table (same root
   cause pattern as the rep-load chart fix earlier, likely reading from
   local cache instead of a live D1 aggregate). Not yet fixed in this
   specific view.
3. Account rows in that Revenue Detail table (and per Ted, this should
   really extend to any report, chart, or number anywhere in the
   platform that represents an account or contact) are static text, need
   to be clickable through to the real account record. Scoped fix for
   the Revenue Detail table not started; the platform-wide version of
   this is a real, larger initiative, not a one-session task.
4. "Charcoal BYOB" exists as two separate account records (`PT363703`
   and `PT953572` in D1) from two different creation paths (one via CSV
   import test, one via the Start Pitch survey tool, `source:
   'pitch_tool'`). Real business per Ted, just needs the duplicate
   merged, not deleted.
5. "ABC Cafe" (`PT755831`) is Ted's own test record from testing the
   AllPro Project Planner earlier. Confirm with Ted whether to delete it
   or leave it, not touched yet.
6. `bid-scraper` and `termac-vault-docs` should auto-deploy from tonight's
   CI list fix, verify both are actually live in the Cloudflare Workers
   dashboard before assuming Check for New Bids or Bid Vault document
   upload works. If either isn't live, the CI run itself may have failed
   silently on just that one worker, check the Actions tab.

---

If anything in this file looks stale or contradicts what you find live in
the repo or dashboard, trust the live state, but flag the discrepancy to
Ted so this file can be corrected — don't silently work around it.
