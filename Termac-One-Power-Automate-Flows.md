# Termac One — Power Automate Flows
## Department Workflow Automation Spec
### For Altek Imaging — M365 Go-Live Handoff

**Prepared by:** Ted Scholl, Senior Account & Operations Manager  
**Platform:** Termac One Revenue OS  
**Backend target:** Azure / Cosmos DB / M365 (migration in progress with Altek)  
**Trigger condition:** These flows activate at Azure SSO + Cosmos DB go-live. Termac One generates the structured data; Power Automate moves it to the right people.

---

## Overview

Three flows cover the highest-friction document handoffs between departments. Each flow reads structured JSON that Termac One already produces, routes it to the right person or channel in Teams, and optionally writes a record to SharePoint for audit purposes.

---

## Flow 1: AP Invoice — Warehouse to Accounting

**Problem it solves:** Vendor invoices scanned at the warehouse currently save to localStorage on the warehouse manager's device. Accounting cannot see them. Invoices risk being missed and payments go late.

**Trigger:** A warehouse manager clicks "Save AP Record" in Termac One. The platform writes a JSON document to Cosmos DB with this shape:

```json
{
  "id": "ap_1719500000000",
  "ts": 1719500000000,
  "warehouse": "termac",
  "vendor": "Vendor Name",
  "invoiceNumber": "INV-12345",
  "invoiceDate": "2026-06-27",
  "dueDate": "2026-07-27",
  "paymentTerms": 30,
  "total": 1250.00,
  "status": "pending",
  "lines": [
    { "description": "Dish Machine Detergent", "qty": 10, "unit": "gal", "unitPrice": 14.00, "lineTotal": 140.00, "matchedSKU": "chem_det" }
  ],
  "pricingAlerts": ["Dish Machine Detergent: was $13.50, now $14.00 (+4%)"]
}
```

**Flow steps:**

1. **Trigger:** Cosmos DB document created in `ap_invoices` container.
2. **Condition:** `status == "pending"`.
3. **Action 1:** Post an Adaptive Card to the **Accounting** Teams channel. Card shows: vendor, invoice number, company, amount, due date, and a line-item table. Two action buttons: "Mark Paid" (calls back to update Cosmos status) and "View Full Record".
4. **Action 2:** If `pricingAlerts` array is non-empty, post a separate notice to **Dennis Muracco (COO)** via Teams direct message: "Price change detected on [vendor] invoice — [alert details]. Review before approving."
5. **Action 3:** Append a row to a SharePoint Excel file `AP-Ledger.xlsx` in the Termac shared drive: one row per invoice with all header fields.
6. **Recurrence check:** A scheduled flow runs every Monday morning. It reads all `ap_invoices` where `status == "pending"` and `dueDate` is within 7 days, and posts a summary Adaptive Card to the Accounting Teams channel as a weekly reminder.

**Responsible for setup:** Altek Imaging configures the Cosmos DB trigger connector and the Accounting Teams channel. Ted provides the Adaptive Card JSON template.

---

## Flow 2: Field Report / Deficiency Quote — Tech or Driver to Office Queue

**Problem it solves:** Techs submit field reports and deficiency findings through Termac One's field assistant, but they land in a chat channel. The office (Lexi Cranfield, quotes) has to hunt for them. There's no structured handoff and no confirmation the report was received.

**Trigger:** A tech or driver submits a field report with type `"deficiency"` or `"repair_needed"`. Termac One writes to Cosmos DB:

```json
{
  "id": "fr_1719500000000",
  "ts": 1719500000000,
  "submittedBy": "Marcus Williams",
  "division": "UniPro",
  "accountId": "acct_abc123",
  "accountName": "Iron Hill Brewery",
  "address": "1940 Olney Ave, Cherry Hill NJ",
  "type": "deficiency",
  "findings": "Suppression system pull station corroded. Needs replacement before next inspection.",
  "photos": ["https://r2.../photo_1.jpg"],
  "urgency": "high",
  "status": "pending_quote"
}
```

**Flow steps:**

1. **Trigger:** Cosmos DB document created in `field_reports` container where `type` is `"deficiency"` or `"repair_needed"`.
2. **Action 1:** Post an Adaptive Card to **Lexi Cranfield** via Teams direct message. Card shows: tech name, account name and address, division, finding summary, urgency badge, and a photo thumbnail if present. Action buttons: "Open Quote Tool" (deep link into Termac One sales portal on that account) and "Mark Quoted".
3. **Action 2:** Post a notification to the **UniPro** (or relevant division) Teams channel so the Service Manager sees it too.
4. **Action 3:** Update the Cosmos `field_reports` document: set `routedToQuote: true`, `routedAt: timestamp`.
5. **SLA check:** A scheduled flow runs every 4 hours during business hours. Any field report with `status == "pending_quote"` and `ts` older than 24 hours gets a follow-up ping to Lexi and her manager (Tom Pittakas).

**Responsible for setup:** Altek configures Cosmos trigger. Lexi's Teams ID needed. Ted provides urgency logic (high = immediate ping; normal = batched daily summary).

---

## Flow 3: Compliance Certificate — Generated to Client Portal and Customer Email

**Problem it solves:** Inspection certificates and GTO FOG service reports are generated inside Termac One but there's no automatic delivery path to the customer or the client portal. Someone has to manually send them.

**Trigger:** A compliance form is marked "completed and signed" in Termac One. Cosmos DB document:

```json
{
  "id": "cert_1719500000000",
  "ts": 1719500000000,
  "type": "nfpa10_cert",
  "accountId": "acct_abc123",
  "accountName": "Iron Hill Brewery",
  "contactEmail": "danielle@ironhill.com",
  "division": "UniPro",
  "techName": "Marcus Williams",
  "serviceDate": "2026-06-27",
  "pdfUrl": "https://r2.../cert_abc123_2026-06-27.pdf",
  "expiresDate": "2027-06-27",
  "status": "completed"
}
```

**Flow steps:**

1. **Trigger:** Cosmos DB document created in `compliance_docs` container where `status == "completed"`.
2. **Action 1:** Send an email to `contactEmail` from `service@termac.com` (shared M365 mailbox). Subject: "Your [NFPA 10 / FOG Service] Certificate — [Account Name]". Body: professional template with service date, tech name, PDF attachment link, and next service due date.
3. **Action 2:** Write the certificate record to the client's portal record in Cosmos (so it appears in the Client Portal "Documents" tab without the customer needing to ask for it).
4. **Action 3:** Post a notification to the **Office** Teams channel: "[Tech] completed [cert type] for [Account]. Certificate sent to customer. Next due: [date]."
5. **Action 4:** Append to a SharePoint Excel `Compliance-Master.xlsx`: account name, certificate type, service date, expiry date, tech, PDF link. This gives management a master compliance tracker without building a custom report.
6. **Expiry reminder:** A scheduled flow runs monthly. It reads `compliance_docs` where `expiresDate` is within 60 days and posts renewal opportunities to the relevant Sales Rep via Teams.

**Responsible for setup:** Altek configures shared `service@termac.com` mailbox and Cosmos trigger. Ted provides email template HTML. SharePoint folder structure needed from Sean or Terence O'Reilly.

---

## Implementation Priority

| Priority | Flow | Business Impact |
|---|---|---|
| 1 | AP Invoice to Accounting | Prevents late payments, pricing surprises |
| 2 | Field Report to Quote Queue | Speeds deficiency-to-revenue cycle |
| 3 | Certificate to Client | Reduces admin work, improves client experience |

---

## What Altek Needs From Termac Before Building

- Confirm M365 tenant and SharePoint site structure
- Provide Teams channel IDs for: Accounting, Office, UniPro, Dispatch, Sales
- Confirm shared mailboxes: `service@termac.com`, `bids@termac.com` (already requested)
- Cosmos DB containers to create: `ap_invoices`, `field_reports`, `compliance_docs`, `messaging` (for the chat sync)
- Power Automate license level: Premium connectors required for Cosmos DB trigger (check current M365 plan)

## What Termac One Will Provide at Go-Live

- Structured JSON in the correct shape for each trigger (all defined above)
- R2 photo/PDF URLs already accessible publicly
- All field reports, AP records, and compliance docs written to Cosmos by the platform
- Teams deep links formatted for Adaptive Cards

---

*This document is the handoff spec from Termac One to the M365/Power Automate layer. No custom middleware or third-party services required — everything runs on M365, Cosmos, and existing Cloudflare infrastructure.*

