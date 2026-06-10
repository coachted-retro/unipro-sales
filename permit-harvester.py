#!/usr/bin/env python3
"""UniPro permit harvester - pulls last 7 days of Philadelphia L&I permits
and posts kitchen/fire-relevant ones as leads to the Apps Script backend.
Required env var: SHEET_API_URL. Optional: TARGET_ZIPS (comma-separated)."""
import os, sys, json, time
import urllib.request, urllib.parse, urllib.error

CARTO = "https://phl.carto.com/api/v2/sql"
SHEET_API = os.environ.get("SHEET_API_URL", "").strip()
TARGET_ZIPS = [z.strip() for z in os.environ.get("TARGET_ZIPS", "").split(",") if z.strip()]

KEYWORDS = ["HOOD", "SUPPRESSION", "KITCHEN", "EXHAUST", "RESTAURANT", "ANSUL", "RANGE"]

QUERY = "SELECT * FROM li_permits WHERE permitissuedate >= current_date - 7 ORDER BY permitissuedate DESC LIMIT 1000"

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


def permit_to_lead(p):
    num = text(p, "permitnumber") or text(p, "objectid")
    scope = text(p, "approvedscopeofwork") or text(p, "permitdescription")
    issued = text(p, "permitissuedate")[:10]
    today = time.strftime("%Y-%m-%d")
    addr = text(p, "address")
    return {
        "id": "PH" + num.replace(" ", ""),
        "sourceRef": "permit:" + num,
        "business": (text(p, "opa_owner") or ("New build at " + (addr or "unknown address")))[:80],
        "contact": text(p, "contractorname")[:60],
        "phone": "",
        "email": "",
        "address": (addr + ", Philadelphia PA " + text(p, "zip")).strip(", "),
        "territory": "Philadelphia",
        "type": "New build / permit",
        "source": "Philly permit " + text(p, "permittype"),
        "services": ["Hood Fabrication", "Suppression Install"],
        "status": "new",
        "next": today,
        "notes": ("Permit " + num + " issued " + issued + ". Scope: " + scope)[:480],
        "created": today,
        "updated": today,
    }


def post_leads(leads):
    body = json.dumps({"action": "addLeads", "leads": leads}).encode()
    req = urllib.request.Request(
        SHEET_API, data=body, method="POST",
        headers={"Content-Type": "text/plain;charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print("BACKEND ERROR", e.code, ":", e.read().decode()[:800])
        sys.exit(1)


def main():
    if not SHEET_API:
        print("ERROR: SHEET_API_URL env var not set")
        sys.exit(1)
    rows = fetch_permits()
    print(f"Fetched {len(rows)} total permits from the last 7 days")
    rows = [p for p in rows if is_relevant(p)]
    print(f"{len(rows)} look kitchen/fire relevant")
    if TARGET_ZIPS:
        rows = [p for p in rows if text(p, "zip")[:5] in TARGET_ZIPS]
        print(f"{len(rows)} after zip filter")
    if not rows:
        print("No matching permits this week.")
        return
    leads = [permit_to_lead(p) for p in rows]
    res = post_leads(leads)
    print("Backend response:", res)
    if not res.get("ok"):
        sys.exit(1)
    print(f"Added {res.get('added', 0)} new leads (duplicates skipped automatically).")


if __name__ == "__main__":
    main()
