#!/usr/bin/env python3
"""UniPro permit harvester - pulls last 7 days of Philadelphia L&I permits
and posts them as new leads to the Apps Script backend.
Required env var: SHEET_API_URL. Optional: TARGET_ZIPS (comma-separated)."""
import os, sys, json, time
import urllib.request, urllib.parse

CARTO = "https://phl.carto.com/api/v2/sql"
SHEET_API = os.environ.get("SHEET_API_URL", "").strip()
TARGET_ZIPS = [z.strip() for z in os.environ.get("TARGET_ZIPS", "").split(",") if z.strip()]

SCOPE_KEYWORDS = ["HOOD", "SUPPRESSION", "KITCHEN", "EXHAUST", "RESTAURANT", "ANSUL", "RANGE"]

QUERY = """
SELECT permitnumber, permittype, permitdescription, typeofwork,
       approvedscopeofwork, address, zip, contractorname, opa_owner,
       permitissuedate, status
FROM permits
WHERE permitissuedate >= current_date - 7
  AND (commercialorresidential ILIKE '%COMMERCIAL%' OR commercialorresidential IS NULL)
  AND (
        permittype ILIKE '%MECHANICAL%'
     OR permittype ILIKE '%FIRE%'
     OR {scope_clause}
  )
ORDER BY permitissuedate DESC
LIMIT 300
""".strip()


def build_query():
    scope = " OR ".join(
        f"approvedscopeofwork ILIKE '%{kw}%'" for kw in SCOPE_KEYWORDS
    )
    return QUERY.format(scope_clause="(" + scope + ")")


def fetch_permits():
    url = CARTO + "?" + urllib.parse.urlencode({"q": build_query()})
    req = urllib.request.Request(url, headers={"User-Agent": "UniPro-harvester/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    return data.get("rows", [])


def permit_to_lead(p):
    scope = (p.get("approvedscopeofwork") or p.get("permitdescription") or "").strip()
    issued = (p.get("permitissuedate") or "")[:10]
    today = time.strftime("%Y-%m-%d")
    return {
        "id": "PH" + str(p.get("permitnumber", "")).replace(" ", ""),
        "sourceRef": "permit:" + str(p.get("permitnumber", "")),
        "business": (p.get("opa_owner") or "New build at " + (p.get("address") or "unknown address")).strip()[:80],
        "contact": (p.get("contractorname") or "").strip()[:60],
        "phone": "",
        "email": "",
        "address": ((p.get("address") or "") + ", Philadelphia PA " + str(p.get("zip") or "")).strip(", "),
        "territory": "Philadelphia",
        "type": "New build / permit",
        "source": "Philly permit " + (p.get("permittype") or ""),
        "services": ["Hood Fabrication", "Suppression Install"],
        "status": "new",
        "next": today,
        "notes": ("Permit " + str(p.get("permitnumber", "")) + " issued " + issued + ". Scope: " + scope)[:480],
        "created": today,
        "updated": today,
    }


def post_leads(leads):
    body = json.dumps({"action": "addLeads", "leads": leads}).encode()
    req = urllib.request.Request(
        SHEET_API, data=body, method="POST",
        headers={"Content-Type": "text/plain;charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    if not SHEET_API:
        print("ERROR: SHEET_API_URL env var not set")
        sys.exit(1)
    rows = fetch_permits()
    print(f"Fetched {len(rows)} permits from Carto")
    if TARGET_ZIPS:
        rows = [p for p in rows if str(p.get("zip", ""))[:5] in TARGET_ZIPS]
        print(f"{len(rows)} after zip filter {TARGET_ZIPS}")
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
