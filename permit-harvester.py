#!/usr/bin/env python3
"""UniPro permit harvester - pulls last 30 days of Philadelphia L&I permits
and posts kitchen/fire-relevant ones as leads directly to Termac One's D1
database. Required env var: D1_API_SECRET. Optional: TARGET_ZIPS
(comma-separated).

Rewritten 2026-07-09: previously posted to a legacy Google Sheets Apps
Script backend (SHEET_API_URL) -- per Ted, nothing in the system should be
going to Sheets anymore, everything routes to D1. This version posts
straight to the working D1 API proxy (unipro-ai-proxy) instead.

Also implements Ted's rep-weighting request: the majority of harvested
leads go to Ted directly, with a random 2-5 leads per run funneled to
other reps, so they still get some inbound activity without bypassing
Ted's primary scope (commercial kitchen hood construction/installation
and fire suppression, which falls under his territory anyway).
"""
import os, sys, json, time, random
import urllib.request, urllib.parse, urllib.error

CARTO = "https://phl.carto.com/api/v2/sql"
D1_API_URL = "https://unipro-ai-proxy.termac-one.workers.dev/db/leads"
D1_API_SECRET = os.environ.get("D1_API_SECRET", "").strip()
TARGET_ZIPS = [z.strip() for z in os.environ.get("TARGET_ZIPS", "").split(",") if z.strip()]

KEYWORDS = ["HOOD", "SUPPRESSION", "KITCHEN", "EXHAUST", "RESTAURANT", "ANSUL", "RANGE"]

QUERY = "SELECT * FROM permits WHERE permitissuedate >= current_date - 30 ORDER BY permitissuedate DESC LIMIT 3000"

# Majority of leads route to Ted directly, per his scope (commercial kitchen
# hood construction/installation and fire suppression inside hoods). A
# random handful (2-5, re-rolled each run) go to other reps so they still
# get some inbound activity.
PRIMARY_REP = "Ted Scholl"
OTHER_REPS = ["Tom Pittakas", "TJ O'Reilly", "Brad Fickes", "Dan Rini",
              "Chris Carzo", "Joe McDonnell", "Matt Belz", "Todd Grill"]


def fetch_permits():
    url = CARTO + "?" + urllib.parse.urlencode({"q": QUERY})
    req = urllib.request.Request(url, headers={"User-Agent": "UniPro-harvester/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print("CARTO ERROR", e.code, ":", e.read().decode()[:800])
        sys.exit(1)
    return data.get("rows", [])


def text(p, key):
    v = p.get(key)
    return str(v).strip() if v is not None else ""


def is_relevant(p):
    com = text(p, "commercialorresidential").upper()
    if com and "COMMERCIAL" not in com:
        return False
    blob = " ".join([
        text(p, "permittype"), text(p, "permitdescription"),
        text(p, "typeofwork"), text(p, "approvedscopeofwork"),
    ]).upper()
    if "MECHANICAL" in text(p, "permittype").upper():
        return True
    if "FIRE" in text(p, "permittype").upper():
        return True
    return any(kw in blob for kw in KEYWORDS)


def assign_reps(leads):
    """Majority to Ted; a random 2-5 leads (re-rolled each run) go to a
    rotating set of other reps, per Ted's 2026-07-09 request."""
    n_others = min(random.randint(2, 5), len(leads))
    other_indices = set(random.sample(range(len(leads)), n_others)) if leads else set()
    for i, lead in enumerate(leads):
        if i in other_indices:
            lead["assigned_rep"] = random.choice(OTHER_REPS)
        else:
            lead["assigned_rep"] = PRIMARY_REP
    return leads


def permit_to_lead(p):
    num = text(p, "permitnumber") or text(p, "objectid")
    scope = text(p, "approvedscopeofwork") or text(p, "permitdescription")
    issued = text(p, "permitissuedate")[:10]
    addr = text(p, "address")
    zip5 = text(p, "zip")
    business = text(p, "opa_owner") or ("New build at " + (addr or "unknown address"))
    return {
        "id": "PH" + num.replace(" ", ""),
        "business": business[:80],
        "contact_name": text(p, "contractorname")[:60],
        "phone": "",
        "email": "",
        "address": (addr + ", Philadelphia PA " + zip5).strip(", "),
        "division": "unipro",
        "source": "Philly permit " + text(p, "permittype"),
        "lifecycle_stage": "lead",
        "notes": ("Permit " + num + " issued " + issued + ". Scope: " + scope)[:480],
    }


def post_lead(lead):
    body = json.dumps(lead).encode()
    req = urllib.request.Request(
        D1_API_URL, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-API-Secret": D1_API_SECRET},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        print("D1 ERROR", e.code, ":", detail)
        return {"ok": False, "error": detail}


def main():
    if not D1_API_SECRET:
        print("ERROR: D1_API_SECRET env var not set")
        sys.exit(1)
    rows = fetch_permits()
    print(f"Fetched {len(rows)} total permits from the last 30 days")
    rows = [p for p in rows if is_relevant(p)]
    print(f"{len(rows)} look kitchen/fire relevant")
    if TARGET_ZIPS:
        rows = [p for p in rows if text(p, "zip")[:5] in TARGET_ZIPS]
        print(f"{len(rows)} after zip filter")
    if not rows:
        print("No matching permits this run.")
        return

    leads = [permit_to_lead(p) for p in rows]
    leads = assign_reps(leads)

    added, failed = 0, 0
    for lead in leads:
        res = post_lead(lead)
        if res.get("ok"):
            added += 1
        else:
            failed += 1
        time.sleep(0.2)  # gentle on the Worker

    print(f"Posted {added} leads to D1 (INSERT OR REPLACE, so re-runs update rather than duplicate).")
    if failed:
        print(f"{failed} leads failed to post -- see D1 ERROR lines above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
