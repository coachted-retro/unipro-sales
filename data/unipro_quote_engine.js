{
  "_meta": {
    "title": "UniPro Fire Protection - Deficiency Quote AI Reference Dataset",
    "purpose": "Reference data extracted from 30 historical Universal Fire Protection kitchen suppression quotes/invoices (ST1-ST30) for use by the Termac One deficiency quoting tool to auto-draft accurate, on-brand quotes.",
    "source_count": 30,
    "date_range_observed": "12/2023 - 06/2026",
    "preparers_observed": ["Ken Palmore", "Lexi Canfield", "Brian O'Rourke"],
    "company": {
      "name": "Universal Fire Protection",
      "address": "7330 Tulip Street, Philadelphia PA 19136",
      "phone": "(215) 928-9191",
      "website": "www.unifirepro.com"
    },
    "notes": [
      "Labor rate increased from $125/hr (observed through mid-2024) to $150/hr (observed late 2024 onward). Use $150/hr as current default; flag if user wants historical rate.",
      "UP7031 = KITCHEN SUPPRESSION LABOR is the universal labor line item across nearly every quote type.",
      "REPIPE and PIPE AND FITTINGS pricing is highly variable ($50-$300) depending on scope - treat as judgment line, not fixed price.",
      "Quote Type field observed values: Upgrade, Service Call, Warranty Call (no charge to customer).",
      "Approval capture pattern: 'Approved by [Name] on [date] [time] from IP address [ip]' - this is the e-signature audit trail format used in the live system."
    ]
  },

  "tax_rates_by_jurisdiction": {
    "note": "Tax rate used is keyed to the service location, not the billing office.",
    "Philadelphia_PA": 0.08,
    "PA_other_observed": 0.06,
    "PA_observed_alt": 0.06625,
    "NJ_statewide": 0.06625,
    "guidance": "PA city/county quotes in Philadelphia proper trend 8%. Other PA suburb/county quotes split between 6% and 6.625% in the sample - likely a per-job entry choice rather than a strict rule, so the tool should look up the correct PA local rate by ZIP rather than assume a flat PA rate. NJ is consistently 6.625% (NJ state sales tax)."
  },

  "labor_rates": {
    "kitchen_suppression_labor": {
      "code": "UP7031",
      "description": "KITCHEN SUPPRESSION LABOR",
      "unit": "per hour",
      "current_rate": 150.00,
      "legacy_rate_pre_late_2024": 125.00
    },
    "two_technician_dispatch": {
      "description": "Used for large/overflow jobs (broken systems, emergency flush, major upgrades). Billed as '2 TECHNICIANS @ N HRS EA' i.e. 2x the hourly rate x hours per tech.",
      "rate_per_tech_hour": 150.00,
      "example_observed": "2 technicians x 8 hrs each = 16 hours total at $225/hr blended (ST14, after-hours emergency) or $150/hr standard (ST29)"
    },
    "after_hours_emergency": {
      "note": "ST14 (system dump emergency) billed labor at $225/hr blended for 2 techs x 8 hrs = $3,838.50 total labor - suggests an after-hours/emergency premium over the standard $150/hr rate.",
      "premium_rate_example": 225.00
    },
    "fuel_charge": {
      "code": "UP9999",
      "description": "FUEL CHARGE",
      "rate": 5.00,
      "applies_to": "Larger upgrade/repair jobs, not every quote"
    },
    "compliance_fee": {
      "code": "UP7829",
      "description": "COMPLIANCE FEE",
      "rate": 25.00,
      "applies_to": "Inspection invoices"
    }
  },

  "standard_part_price_book": [
    {"code": "UP7001", "description": "KITCHEN FIRE SUPP SYS INSPECTION", "price": 137.99, "category": "inspection"},
    {"code": "UP7002", "description": "KITCHEN FSSI - ADDL CYLINDER INSPECTION", "price": 35.00, "category": "inspection"},
    {"code": "UP2003", "description": "EXT ANNUAL INSPECTION FIRE EXT (EA ADDITIONAL UNIT)", "price": 7.50, "category": "inspection"},
    {"code": "UP2013", "description": "EXT TAMPER INDICATING DEVICE FLAG SEAL", "price": 5.00, "category": "extinguisher"},
    {"code": "UP2015", "description": "EXT EXT HUNG/RELOCATE", "price": 14.00, "category": "extinguisher"},
    {"code": "UP3040", "description": "SWAP OUT DRY CHEM 5LB EXT", "price": 70.00, "category": "extinguisher"},
    {"code": "UP3041", "description": "SWAP OUT DRY CHEM 10LB", "price": 95.00, "category": "extinguisher"},
    {"code": "UP1010", "description": "NEW EXT 10 LB ABC", "price": 124.99, "category": "extinguisher"},
    {"code": "UP1525", "description": "NEW EXT K CLASS 6.0 LITER", "price": 349.00, "category": "extinguisher"},
    {"code": "UP5007", "description": "EXT FIRE EXTINGUISHER SIGN", "price": 7.50, "category": "extinguisher"},
    {"code": "UP5010", "description": "EXT FIRE EXTINGUISHER HANGER", "price": 15.00, "category": "extinguisher"},
    {"code": "UP7020", "description": "FUSIBLE LINK", "price": 17.50, "category": "suppression_system"},
    {"code": "UP7040", "description": "PIPE AND FITTINGS", "price_range": [75, 300], "typical": 150.00, "category": "suppression_system", "note": "Scales with job scope/footage"},
    {"code": "UP7084", "description": "MISC QUICK SEAL", "price": 25.00, "category": "suppression_system"},
    {"code": "UP7099", "description": "NOZZLE SWIVEL ADAPTER", "price": 85.00, "category": "suppression_system"},
    {"code": "UP7338", "description": "ANSUL CART101-30", "price": 325.00, "category": "ansul"},
    {"code": "UP7342", "description": "ANSUL CART LT-30-R", "price": 250.00, "category": "ansul"},
    {"code": "UP7344", "description": "ANSUL CART R-102 DUAL TANK", "price": 795.00, "category": "ansul"},
    {"code": "UP7348", "description": "ANSUL DETECTOR, SERIES (INC SCISSOR LINK HOLDER)", "price": 40.00, "category": "ansul"},
    {"code": "UP7371", "description": "Ansul Automan", "price": 1253.00, "category": "ansul"},
    {"code": "UP7399", "description": "NOZZLE - ANSUL", "price": 95.00, "category": "ansul"},
    {"code": "UP7501", "description": "PCL300 SWAP (Pyro Chem 3gal tank replacement)", "price": 825.00, "category": "pyrochem"},
    {"code": "UP7502", "description": "PCL460 SWAP (Pyro Chem 4.6gal tank replacement)", "price": 975.00, "category": "pyrochem"},
    {"code": "UP7505", "description": "Ansul 3.0 Gallon SWAP", "price": 864.00, "category": "ansul"},
    {"code": "UP7604", "description": "UN1044 FIRE EXTINGUISHER 2.2 PYRO CHEM PCL-600 Agent Cylinder", "price": 1450.00, "category": "pyrochem"},
    {"code": "UP7622", "description": "PYRO CHEM ALARM MICROSWITCH", "price": 98.00, "category": "pyrochem"},
    {"code": "UP7699", "description": "PYRO CHEM NOZZLE", "price": 95.00, "category": "pyrochem"},
    {"code": "UP7456", "description": "UN1044 FIRE EXTINGUISHER 2.2 KIDDE/RG-6G CYLINDER & VALVE (Range Guard)", "price": 1375.00, "category": "rangeguard"},
    {"code": "UP7472", "description": "KIDDE/RG NITROGEN SYSTEM CARTRIDGE - XV/UCH", "price": 95.00, "category": "rangeguard"},
    {"code": "UP7475", "description": "KIDDE/RG MICRO SWITCH-SPDT ALARM", "price": 125.00, "category": "rangeguard"},
    {"code": "UP7488", "description": "KIDDE/RG XV/UCH CONTROL HEAD ASSM", "price": 900.00, "category": "rangeguard"},
    {"code": "UP7499", "description": "NOZZLE KIDDE/RANGE GUARD", "price": 95.00, "category": "rangeguard"},
    {"code": null, "description": "RANGEGUARD MICROSWITCH - ALARM", "price": 160.00, "category": "rangeguard"},
    {"code": "UP7711", "description": "UN1044 FIRE EXTINGUISHER 2.2 BUCKEYE BFR-10 FLOW PT CYL W/VALVE", "price": 1175.00, "category": "buckeye"},
    {"code": "UP7712", "description": "UN1044 FIRE EXTINGUISHER 2.2 BUCKEYE BFR-15 FLOW PT CYL W/VALVE", "price": 1495.00, "category": "buckeye"},
    {"code": "UP7713", "description": "UN1044 FIRE EXTINGUISHER 2.2 BUCKEYE BFR-20 FLOW PT CYL W/VALVE", "price": 1850.00, "category": "buckeye"},
    {"code": "UP7720", "description": "BUCKEYE RPS-M REMOTE PULL STATION - MECHANICAL", "price": 153.00, "category": "buckeye"},
    {"code": "UP7799", "description": "NOZZLE - BUCKEYE", "price": 95.00, "category": "buckeye"},
    {"code": null, "description": "BRACKET (link bracket, generic)", "price": 10.00, "category": "suppression_system"},
    {"code": null, "description": "CONDUIT (per stick/8ft section)", "price_range": [19.99, 25.00], "category": "suppression_system"},
    {"code": null, "description": "PIPE (generic, per job)", "price": 65.00, "category": "suppression_system"},
    {"code": null, "description": "REPIPE (labor/material bundle line for re-routing drops)", "price_range": [50, 300], "typical": 250.00, "category": "suppression_system"},
    {"code": null, "description": "HOSE (actuation hose)", "price": 50.00, "category": "ansul"},
    {"code": "UP8888", "description": "MISCELLANEOUS SYSTEM PARTS", "price_range": [75, 250], "category": "suppression_system"},
    {"code": "UP1500", "description": "Discount (negative line item, goodwill/loyalty adjustment)", "price": "variable, negative", "category": "adjustment"},
    {"code": null, "description": "FLUSH SYSTEM (full system flush after activation/discharge)", "price": 450.00, "category": "emergency"},
    {"code": null, "description": "REFILL 5.25 GALLONS ANSUL PIRANHA CHEMICAL", "price": 830.17, "category": "emergency"},
    {"code": null, "description": "REPLACE LINK LINE", "price": 50.00, "category": "suppression_system"}
  ],

  "manufacturer_systems_observed": {
    "Ansul": {
      "models": ["R-102 3gal", "R-102 6gal", "R-102 9gal (3 tanks)"],
      "tank_swap_code": "UP7505",
      "cartridge_codes": {"LT-30-R": "UP7342", "101-30": "UP7338", "dual_tank": "UP7344"},
      "nozzle_code": "UP7399",
      "detector_bracket_code": "UP7348",
      "automan_code": "UP7371"
    },
    "Pyro Chem (PCL)": {
      "models": ["PCL-300 (3gal)", "PCL-460 (4.6gal)", "PCL-550 (5.5gal)", "PCL-600 (6gal)"],
      "swap_codes": {"PCL300": "UP7501", "PCL460": "UP7502", "PCL600": "UP7604"},
      "nozzle_code": "UP7699",
      "microswitch_code": "UP7622"
    },
    "Kidde / Range Guard": {
      "models": ["RG-6G (6gal)"],
      "cylinder_code": "UP7456",
      "control_head_code": "UP7488",
      "nitrogen_cartridge_code": "UP7472",
      "microswitch_code": "UP7475",
      "nozzle_code": "UP7499"
    },
    "Buckeye": {
      "models": ["BFR-10 (10gal)", "BFR-15 (6gal class)", "BFR-20 (20gal)"],
      "cylinder_codes": {"BFR10": "UP7711", "BFR15": "UP7712", "BFR20": "UP7713"},
      "nozzle_code": "UP7799",
      "swivel_adapter_code": "UP7099",
      "pull_station_code": "UP7720"
    },
    "Protex / Protex II": {
      "models": ["L4600 (4.6gal)", "L6000 (6gal)"],
      "note": "Legacy/older systems observed; no longer always supported by manufacturer at 12-year service interval - typically requires full swap to a currently-supported model (Range Guard, Pyro Chem, etc.) rather than like-for-like cylinder swap."
    }
  },

  "deficiency_taxonomy": [
    {
      "category": "12-Year Hydrostatic Test Due",
      "code_ref": "NFPA17A 7.5.1",
      "trigger_language": "Kitchen Hood Suppression System Cylinder is due for 12 year hydro test",
      "resolution_pattern": "Either (a) hydro test the existing cylinder if manufacturer still supports it, or (b) full cylinder SWAP if cylinder is past manufacturer support window (commonly cited as 12 years from a ~2012 install date in later quotes).",
      "typical_line_items": ["Tank/cylinder swap code per manufacturer", "UP7031 labor 2-6 hrs depending on scope"],
      "price_range_observed": [1039.47, 3298.19],
      "real_examples": ["ST3 (Quote 0002310, $2,846.10 total)", "ST12 (Quote 0003679, PCL460 swap, $1,359.47)", "ST13 (Quote 0003995, R102 swap + full rebuild, $3,298.19)"]
    },
    {
      "category": "Discharge Nozzles Impaired / Not Positioned / Clogged / Outdated",
      "trigger_language": "Discharge nozzles are impaired / not positioned correctly and must be replaced or repiped. Suppression system will not work as designed in its present state.",
      "resolution_pattern": "Replace nozzle(s) at $95 each (manufacturer-matched code), often paired with repipe if positioning (not just clogging) is the issue.",
      "typical_line_items": ["Nozzle code x quantity at $95 ea", "REPIPE if positioning issue ($250 typical)", "UP7040 pipe and fittings if rerouting", "UP7031 labor"],
      "price_range_observed": [266.56, 1452.60],
      "real_examples": ["ST16 (Quote 0003681, $826.34)", "ST10 (Quote 0003496, 11 nozzles, $1,452.60)", "ST25 (Quote 0003689, UL300 repipe compliance, $837.00)"]
    },
    {
      "category": "Detection / Link Line Frozen or Inoperable (grease build-up)",
      "trigger_language": "Detection Link Line is inoperable/frozen due to grease build and will not operate as designed.",
      "resolution_pattern": "Replace fusible links, scissor link/detector brackets, conduit, cable, and S-hooks along the link line run.",
      "typical_line_items": ["UP7020 fusible link x qty", "UP7348 detector/scissor link bracket x qty", "Conduit per stick", "UP7031 labor"],
      "price_range_observed": [524.70, 6733.52],
      "real_examples": ["ST23 (Quote 0004484, minor 2-link fix, $524.70)", "ST14 (Quote 0004102, full post-discharge rebuild, $6,733.52)"]
    },
    {
      "category": "Control Head / Microswitch / Pull Station Replacement",
      "trigger_language": "Replace and update control head / Electrician needs new microswitch / Replace pull station",
      "resolution_pattern": "Control head and pull station replacement is UniPro scope; microswitch CONNECTION/DISCONNECTION is always called out as customer's responsibility requiring a licensed electrician - UniPro supplies and drops off the part only.",
      "boilerplate_required": "RESPONSIBILITY OF CUSTOMER TO HIRE LICENSED ELECTRICIAN TO CONNECT/DISCONNECT",
      "typical_line_items": ["Manufacturer-specific control head code", "Microswitch part code", "UP7720 pull station if needed", "UP7031 labor"],
      "real_examples": ["ST18 (Quote 0003475, full RG6G rebuild incl. control head/pull station, $5,599.95)", "ST21 (Quote 0003549, microswitch drop-off only, $435.24)"]
    },
    {
      "category": "Fire Extinguisher - 6-Year Maintenance / Hydro Test / Expired Agent",
      "trigger_language": "[Size] [type] fire extinguisher due for 6 year maintenance / hydro test / Extinguishing agent expired",
      "resolution_pattern": "SWAP (not refill) is the standard resolution - exchange for serviced unit. ABC dry chem uses UP3040 (5lb)/UP3041 (10lb); K-Class uses UP1525 new unit.",
      "typical_line_items": ["UP3040/UP3041 swap code", "UP1525 if K-Class new unit needed", "UP2013 tamper seal", "UP5007/UP5010 sign/hanger if relocating"],
      "price_range_observed": [210.60, 475.15],
      "real_examples": ["ST28 (Quote 0002698, 2x 10lb swap, $210.60)", "ST19 (Quote 0001853, mixed sizes, $475.15)"]
    },
    {
      "category": "System Coverage Gap / New Appliance Added to Cook Line",
      "trigger_language": "add piping for additional appliances / appliance line up which will require additional nozzles for proper fire protection",
      "resolution_pattern": "May require tank upsize (e.g., PCL460 -> PCL600) if total nozzle/appliance count exceeds existing cylinder capacity, plus new detector(s) over added equipment.",
      "real_examples": ["ST2 (Quote 0001886, PCL460->PCL600 upsize for 2 new appliances, $2,780.77)", "ST24 (Quote 0001215, add 6-burner range, $3,261.60)"]
    },
    {
      "category": "Post-Discharge / Emergency System Reset",
      "trigger_language": "Customer has fire and system dumped / Tank has no nitrogen / Suppression activated",
      "resolution_pattern": "Full system flush + chemical refill + complete consumables replacement (links, brackets, conduit, nozzles, cartridge) - treated as emergency/after-hours dispatch, often 2 technicians.",
      "typical_line_items": ["FLUSH SYSTEM ($450)", "Chemical refill (varies by gallon)", "Full link/bracket/nozzle replacement set", "2-tech labor, possible after-hours premium"],
      "price_range_observed": [6733.52, 9085.77],
      "real_examples": ["ST14 (Zaras Restaurant, $6,733.52)", "ST29 (Wow Que Rico, full BFR10/BFR20 rebuild, $9,085.77)"]
    },
    {
      "category": "Legacy/Unsupported System - Full Cylinder & Control Replacement",
      "trigger_language": "due for 12 year service (2012) but is no longer supported by the manufacturer and requires the cylinder to be replaced with new",
      "resolution_pattern": "Triggers a full rebuild rather than simple swap: new cylinder, new control head, all-new nozzles (typically 10-15), new pull station, new microswitch, possibly new K-Class extinguisher for added coverage.",
      "price_range_observed": [2915.00, 9085.77],
      "real_examples": ["ST18", "ST30", "ST29"]
    }
  ],

  "boilerplate_text_blocks": {
    "scope_exclusion_standard": "*The following is not included with this quotation: Certified Electrician for connection of microswitch, tie in to fire alarm and or shut down connections, Installation of gas valves, Permits, Designs or associated fees (charged if incurred) Any additional requirement by the Authority Having Jurisdiction.",
    "scope_exclusion_with_plumber": "Add 'Certified Plumber for gas valve installation' when gas valve work/relocation is in scope (seen on ST27 for gas valve in ceiling above hood).",
    "approval_and_payment_terms": "*If the service is approved to proceed, please click on the accept button. 50% down payment of the total amount presented is required prior to scheduling the service. An office admin will reach after approval. Note: if using credit card a 3% fee will be added.",
    "code_compliance_notice": "*All inspection reports and deficiencies noted are to be filed with the local Authority Having Jurisdiction if required (NFPA17a 7.3.3.5.1). The prompt repair of deficiencies is a requirement of local and State codes and is important to overall life safety.",
    "hours_notice": "*Any time or material exceeding this proposal will be quoted separately. Perform during normal business hours. Non-holiday.",
    "sign_off": "Thank you\\n[Preparer Name]",
    "warranty_clause_summary": "90-day limited warranty on parts/workmanship; liability capped at lesser of half of trailing-12-month invoices or $1,000 liquidated damages; customer waives subrogation; 1-year statute of limitations on claims; customer indemnifies company; PA law/Philadelphia County jurisdiction governs."
  },

  "quote_structure_schema": {
    "header_fields": ["Quote No. (format 000XXXX, 7 digits)", "Type (Upgrade | Service Call | Warranty Call)", "Prepared By", "Created On", "Valid Until (typically Created On + 30-45 days)", "Quote For (customer/location name and address/phone)"],
    "body_sections": ["Description of Work (narrative + bulleted deficiency list)", "Services to be completed (bracketed category tag + system description + specific finding + repair note, optionally with Estimated Completion date range)", "Code/Parts/Labor/Items table (Code, Description, Quantity, Unit Price, Tax, Total)", "Subtotal / Tax @ rate / Grand Total", "Terms and Conditions (standard 7-clause legal block, unchanged across all quotes)", "Approval signature block (typed name, date/time, IP address) once accepted", "Photos (optional, appended for documentation/before-state evidence)"],
    "services_category_tags_observed": ["[Fire Suppression]", "[Kitchen Suppression]", "[Portable Extinguishers]"],
    "invoice_variant_fields": ["Invoice No.", "Customer PO No.", "Invoice For (Inspection Job #)", "Transaction Date", "Due Date (often 'Due Upon Receipt')", "Service Location", "Bill To", "Additional Customer Information (Adagio Unipro #/Adagio GTO # cross-reference fields)"]
  },

  "real_quote_index": [
    {"id": "ST1/doc1", "quote_no": "0002310", "customer": "ZAC'S HAMBURGERS - CRUM LYNNE", "date": "09/17/2024", "type": "Upgrade", "total": 2846.10, "deficiencies": ["12yr hydro", "control head", "4 nozzles", "5lb ABC 6yr maint"]},
    {"id": "ST2/doc2", "quote_no": "0001886", "customer": "SUMMER SALT", "date": "06/05/2024", "type": "Upgrade", "total": 2780.77, "deficiencies": ["tank upsize PCL460->PCL600", "add piping 2 appliances", "add detectors"]},
    {"id": "ST3/doc3", "quote_no": "0001925", "customer": "EAST COAST WINGS", "date": "06/13/2024", "type": "Upgrade", "total": 1128.60, "deficiencies": ["12yr hydro", "nozzles impaired", "link line frozen"]},
    {"id": "ST4/doc4", "invoice_no": "10041926", "customer": "EGGCETERA", "date": "06/29/2026", "type": "Invoice/Inspection", "total": 827.81, "deficiencies": ["routine inspection + extinguisher swaps/relocates"]},
    {"id": "ST5/doc5", "quote_no": "0003264", "customer": "WELL FED", "date": "05/06/2025", "type": "Upgrade", "total": 1160.70, "deficiencies": ["dual tank cartridge replacement"]},
    {"id": "ST6-7/doc6-7", "quote_no": "0002336", "customer": "MARAKANDA", "date": "09/20/2024", "type": "Service Call", "total": 1825.19, "deficiencies": ["12yr hydro Protex 6000", "duct nozzles impaired", "charcoal nozzle adjust"]},
    {"id": "ST8/doc8", "quote_no": "0001105", "customer": "Little Italy Pizza", "date": "12/22/2023", "type": "Upgrade", "total": 4280.00, "deficiencies": ["extinguisher hydro/maint", "full 3gal tank/control head/cartridge/link bracket replacement", "5 nozzles clogged/wrong"]},
    {"id": "ST9/doc9", "quote_no": "0001529", "customer": "BROTHERS PIZZA - MILLFORD RD", "date": "04/09/2024", "type": "Warranty Call", "total": 0.00, "deficiencies": ["tank leaked pressure (warranty)", "extinguisher rehang"]},
    {"id": "ST10/doc10", "quote_no": "0003496", "customer": "Zuzu's Kitchen", "date": "07/23/2025", "type": "Upgrade", "total": 1452.60, "deficiencies": ["11 nozzles to replace (duct/plenum/appliance)"]},
    {"id": "ST11/doc11", "quote_no": "0002825", "customer": "ZORBA'S TAVERN", "date": "01/20/2025", "type": "Upgrade", "total": 612.80, "deficiencies": ["char grill/duct nozzles grease buildup", "scissor link", "bracket"], "note": "includes $100 discount line item UP1500"},
    {"id": "ST12/doc12", "quote_no": "0003679", "customer": "ZOGGIES 2 - TRUCK", "date": "10/06/2025", "type": "Upgrade", "total": 1359.47, "deficiencies": ["12yr hydro PCL460 swap"]},
    {"id": "ST13/doc13", "quote_no": "0003995", "customer": "ZAYTOON", "date": "01/16/2026", "type": "Upgrade", "total": 3298.19, "deficiencies": ["12yr hydro R102 swap", "cartridge", "3 links/brackets", "4 nozzles/2 swivels", "full repipe 4 appliance groups"], "note": "marked '3RD & FINAL QUOTE' - customer deferred twice pending hood extension"},
    {"id": "ST14/doc14", "quote_no": "0004102", "customer": "ZARAS RESTAURANT", "date": "02/16/2026", "type": "Upgrade", "total": 6733.52, "deficiencies": ["post-discharge full system flush/refill/rebuild"], "note": "after-hours emergency, 2 techs x 8hrs"},
    {"id": "ST15/doc15", "quote_no": "0002142", "customer": "ZAKES CAFE", "date": "08/05/2024", "type": "Upgrade", "total": 2992.38, "deficiencies": ["12yr hydro", "electrical wire removal from control box (electrician required)"]},
    {"id": "ST16/doc16", "quote_no": "0003681", "customer": "Wilson's Restaurant & Live Music", "date": "10/06/2025", "type": "Upgrade", "total": 826.34, "deficiencies": ["nozzles not positioned, repipe for full appliance coverage"]},
    {"id": "ST17/doc17", "quote_no": "0001362", "customer": "ZABOLI'S PIZZA", "date": "03/05/2024", "type": "Upgrade", "total": 1630.80, "deficiencies": ["12yr hydro", "2 extinguishers hydro due", "nozzles/duct nozzle change"]},
    {"id": "ST18/doc18", "quote_no": "0003475", "customer": "Z&C ROLLIN RESTAURANT", "date": "07/14/2025", "type": "Upgrade", "total": 5599.95, "deficiencies": ["unsupported legacy cylinder full replace", "11 nozzles", "control head", "pull station", "microswitch (electrician)", "2 ext swap + 1 new K-class"]},
    {"id": "ST19/doc19", "quote_no": "0001853", "customer": "SEVEN LOUNGE", "date": "06/03/2024", "type": "Upgrade", "total": 475.15, "deficiencies": ["wet K hydro", "5lb/10lb ABC 6yr maint"]},
    {"id": "ST20/doc20", "quote_no": "0002615", "customer": "YUMMY PHO", "date": "11/25/2024", "type": "Upgrade", "total": 3758.40, "deficiencies": ["12yr hydro BFR-15 swap", "13 nozzles across multiple appliance drops"]},
    {"id": "ST21/doc21", "quote_no": "0003549", "customer": "Yuan East", "date": "08/12/2025", "type": "Upgrade", "total": 435.24, "deficiencies": ["microswitch drop-off for electrician install"]},
    {"id": "ST22/doc22", "quote_no": "0003895", "customer": "YORI'S BAKERY", "date": "12/12/2025", "type": "Upgrade", "total": 1192.50, "deficiencies": ["2x 10lb ABC expired", "K-class discharged", "PCL300 hydro swap"]},
    {"id": "ST23/doc23", "quote_no": "0004484", "customer": "YARD PUB", "date": "06/02/2026", "type": "Upgrade", "total": 524.70, "deficiencies": ["2 scissor links", "2 quick seals", "pipe replacement"]},
    {"id": "ST24/doc24", "quote_no": "0001215", "customer": "YAO'S COLD BEER & FOOD", "date": "02/05/2024", "type": "Upgrade", "total": 3261.60, "deficiencies": ["5 nozzles outdated", "add 6-burner range to lineup, 3 new nozzles + double cartridge"]},
    {"id": "ST25/doc25", "quote_no": "0003689", "customer": "YANAGA KOPPO IZAKAYA", "date": "10/08/2025", "type": "Upgrade", "total": 837.00, "deficiencies": ["UL300 compliance repipe - straight-down drops required by new Ansul rule", "nozzle repositioning"]},
    {"id": "ST26/doc26", "quote_no": "0004013", "customer": "YAMAZA GROCERY", "date": "01/20/2026", "type": "Upgrade", "total": 3810.56, "deficiencies": ["12yr hydro R102 swap", "6 nozzles", "CO2 cartridge/actuator/hose", "10lb ext swap", "link line frozen"]},
    {"id": "ST27/doc27", "quote_no": "0002742", "customer": "YAMATO HIBACHI STEAKHOUSE", "date": "01/02/2025", "type": "Upgrade", "total": 5672.45, "deficiencies": ["dual-tank Range Guard full upgrade", "15 nozzles", "cartridge/control head/microswitch", "gas valve relocation flagged for licensed plumber"]},
    {"id": "ST28/doc28", "quote_no": "0002698", "customer": "WRAP SHACK", "date": "12/17/2024", "type": "Upgrade", "total": 210.60, "deficiencies": ["2x 10lb ABC 6yr maint swap"]},
    {"id": "ST29/doc29", "quote_no": "0002904", "customer": "WOW QUE RICO", "date": "01/31/2025", "type": "Upgrade", "total": 9085.77, "deficiencies": ["dual-cylinder (BFR10+BFR20) full rebuild", "14 nozzles", "8 swivels", "frozen link line", "torn-out pull station", "no K-class on system", "language barrier flagged - 2 techs all-day, named tech (Vince) requested"]},
    {"id": "ST30/doc30", "quote_no": "0003819", "customer": "WING TO GO (WILLOW GROVE)", "date": "11/13/2025", "type": "Upgrade", "total": 2915.00, "deficiencies": ["unsupported legacy cylinder, PCL600 full swap", "10 nozzles", "repipe bottle"]}
  ],

  "operational_signal_patterns": {
    "purpose": "Free-text patterns in 'Description of Work' that signal something beyond a standard parts-and-labor quote - useful for the AI to flag for human review rather than auto-send.",
    "patterns": [
      {"signal": "**SEND VINCE** or named-technician request", "meaning": "Job requires a specific technician's expertise (e.g. control head disassembly); route to scheduling with that constraint, do not auto-assign."},
      {"signal": "No one speaks English / language barrier note", "meaning": "Flag for scheduling - may need bilingual tech or extra coordination time; affects on-site duration estimate."},
      {"signal": "Customer wants to wait / planned construction (e.g. hood extension)", "meaning": "Quote marked as deferred - track as open/follow-up rather than expecting immediate approval; do not chase for 50% down."},
      {"signal": "RESPONSIBILITY OF CUSTOMER / licensed electrician / licensed plumber required", "meaning": "Always auto-insert this disclaimer when scope touches microswitch wiring or gas valve relocation - this is a liability boundary, not optional."},
      {"signal": "UPDATED FOR AFTER HOURS / system dumped / customer has fire", "meaning": "Emergency dispatch - apply premium labor rate and 2-technician default; this is the highest-total-value category and should route to dispatch immediately, not standard quote queue."}
    ]
  },

  "recommended_uses_beyond_quoting_tool": [
    "Tech training / Learning Center module: deficiency_taxonomy + manufacturer_systems_observed map cleanly to a 'Common Kitchen Suppression Deficiencies' course module for the existing 25+ module Learning Center.",
    "AHJ compliance content: the NFPA17A 7.5.1 (12-yr hydro) and 7.3.3.5.1 (filing with AHJ) citations recur constantly and could feed the compliance forms / AHJ jurisdiction auto-detect feature already built.",
    "Sales/lifecycle engine trigger: 12-year hydro test deficiencies are date-driven (install year + 12) - this is a clean automated trigger for the Lifecycle Engine to proactively generate a deficiency quote draft before the tech even arrives on site, based on system install/last-12yr-service date in DMS records.",
    "Pricing governance: part_price_book should become the canonical price list referenced by AR/AP Assistant and Bid Submission Intelligence System so manual quote entry and bid pricing intelligence stay in sync.",
    "Dispatcher/GPS routing signal: the 'operational_signal_patterns' (named tech, language barrier, emergency) are exactly the kind of metadata the GPS dispatch board could use to avoid mis-assigning a job.",
    "HR/quality flag: language-barrier and named-technician-request patterns suggest documenting which techs handle which account relationships - useful context for the talent pipeline/scheduling system."
  ]
}
