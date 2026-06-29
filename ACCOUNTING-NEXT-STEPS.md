# Termac One — Accounting and Controller Next Steps

Working list to track what is built, what is next, and what to leave to NetSuite.
Keep this current as items ship.

## In progress

1. Labor into gross margin
   . The Labor Cost Dashboard, HR per tech hourly rate plus burden, and the $35/hr default already exist. Do not rebuild them.
   . Wire the live tech portal and delivery to write termac_labor_ledger on completion, using the geo on-site minutes, with rate from HR per tech, else the general default, times burden. This populates the existing dashboard.
   . Read that same ledger into the P&L and the Accounting Office Margin tab so gross margin subtracts labor.
   . Per tech accuracy improves on its own as HR fills in each staff member's rate and burden.

## Next, in order

2. Cash forecast
   . Project cash several weeks out. Inflows from AR aging, outflows from AP due dates. The data is already captured.

3. Controller KPI strip on the Overview
   . DSO, percent current versus past due, collection effectiveness, gross margin trend. All derivable from existing data.

4. Credit terms and holds on accounts
   . Account level credit hold flag that dispatch, scheduling, and the reps can see and that stops new work. This is the control the platform can enforce where NetSuite cannot.

5. Field cash loop
   . Tie collected in the field to turned in at the office and flag the gap. The geo and delivery timestamps make this close.

6. NetSuite export bridge
   . AP, AR, and collections out with category and GL hint. Blocked until NetSuite is provisioned by Altek.

7. AP and AR assistant roles under the controller
   . New role. Roughly 4 to 6 people. Each handles different accounts for different areas of the PA NJ DE MD DC coverage.
   . AR assistants work receivables and collections for their assigned accounts. AP assistants work vendor bills for their assigned accounts.
   . Needs an assignment model so each assistant is scoped to a set of accounts or a region. Their views of AR aging, collections, and payables filter to that scope. The controller still sees everyone.
   . Each assistant gets a work queue, their overdue accounts to chase and their bills to process, not the whole book.
   . Needs from ownership: the list of assistants and which accounts or regions each one owns. Deploys with the rest of staff, gated on Azure SSO.

## Leave to NetSuite or its add ons, do not build in the platform

. Multi state sales tax. Avalara or the NetSuite tax engine. Delaware has no sales tax, which is exactly the edge case not to hand roll.
. Bank reconciliation. NetSuite bank feeds.
. Formal financial statements, balance sheet and cash flow. NetSuite.
. AP approval routing. Power Automate or NetSuite once on M365.

## Dependencies

. Per tech labor accuracy needs all staff entered in HR with hourly rate and burden.
. NetSuite export bridge needs NetSuite live, gated on Altek.
. Square card reconciliation and Brevo dunning are go live items, also gated on Altek and account setup.
