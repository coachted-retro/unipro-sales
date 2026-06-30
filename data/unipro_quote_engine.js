/**
 * UniPro Deficiency Quote Generator
 * ----------------------------------
 * Consumes unipro_deficiency_quote_reference.json (the price book / taxonomy /
 * boilerplate dataset) and turns a raw deficiency description + system info
 * into a structured quote draft, matching the real quote format used by
 * Universal Fire Protection (UP quote numbering, Code/Parts/Labor/Items table,
 * tax-by-jurisdiction, standard disclaimers).
 *
 * Two-stage design:
 *   1. Deterministic matcher (this file) - handles the ~80% of cases that
 *      map cleanly onto known deficiency categories and part codes. No AI
 *      call needed, instant, fully auditable.
 *   2. AI fallback prompt (buildAiDraftPrompt below) - for free-text
 *      deficiency descriptions that don't cleanly match a category, or that
 *      need judgment calls (how many nozzles, how much pipe, repipe scope).
 *      Feeds the same reference dataset to Claude as grounding context so
 *      the model prices things the way UniPro actually prices them instead
 *      of guessing.
 *
 * Intended runtime: browser (deficiency-portal.html, loaded via <script> tag)
 * or any Node/edge environment. No external deps.
 */
 
// ---------------------------------------------------------------------------
// 1. LOAD REFERENCE DATA
// ---------------------------------------------------------------------------
 
/**
 * @param {object} referenceData - parsed unipro_deficiency_quote_reference.json
 */
function createQuoteEngine(referenceData) {
  const priceBook = referenceData.standard_part_price_book;
  const taxonomy = referenceData.deficiency_taxonomy;
  const manufacturers = referenceData.manufacturer_systems_observed;
  const boilerplate = referenceData.boilerplate_text_blocks;
  const taxRates = referenceData.tax_rates_by_jurisdiction;
  const laborRates = referenceData.labor_rates;
 
  // -------------------------------------------------------------------------
  // 2. JURISDICTION / TAX LOOKUP
  // -------------------------------------------------------------------------
 
  /**
   * Resolve a tax rate from a service address. Falls back to PA suburb
   * rate (6%) if state can't be determined, since that's the most common
   * non-Philadelphia rate observed in the dataset.
   */
  function resolveTaxRate({ city, state, zip } = {}) {
    if (!state) return { rate: 0.06, source: "default_fallback", needsConfirmation: true };
    const s = state.trim().toUpperCase();
    if (s === "NJ") return { rate: taxRates.NJ_statewide, source: "NJ_statewide" };
    if (s === "PA") {
      if (city && /philadelphia/i.test(city)) {
        return { rate: taxRates.Philadelphia_PA, source: "Philadelphia_PA" };
      }
      // Tool note: PA local rate varies by county/ZIP in real life (6% vs
      // 6.625% both observed in source data). Default to 6% and flag for
      // human confirmation rather than silently guessing which PA county
      // rate applies.
      return { rate: taxRates.PA_other_observed, source: "PA_other_observed", needsConfirmation: true };
    }
    return { rate: 0.06, source: "default_fallback", needsConfirmation: true };
  }
 
  // -------------------------------------------------------------------------
  // 3. DEFICIENCY CATEGORY MATCHING
  // -------------------------------------------------------------------------
 
  const KEYWORD_MAP = [
    { category: "12-Year Hydrostatic Test Due", keywords: ["12 year", "12yr", "hydro test", "hydrostatic"] },
    { category: "Discharge Nozzles Impaired / Not Positioned / Clogged / Outdated", keywords: ["nozzle", "clogged", "not positioned", "impaired", "outdated"] },
    { category: "Detection / Link Line Frozen or Inoperable (grease build-up)", keywords: ["link line", "frozen", "fusible link", "scissor link", "detection line"] },
    { category: "Control Head / Microswitch / Pull Station Replacement", keywords: ["control head", "microswitch", "pull station"] },
    { category: "Fire Extinguisher - 6-Year Maintenance / Hydro Test / Expired Agent", keywords: ["6 year maintenance", "extinguisher", "agent expired", "abc", "k-class", "k class", "wet k"] },
    { category: "System Coverage Gap / New Appliance Added to Cook Line", keywords: ["new appliance", "add piping", "cook line", "additional appliance"] },
    { category: "Post-Discharge / Emergency System Reset", keywords: ["system dumped", "fire and system", "discharged", "no nitrogen", "flush system"] },
    { category: "Legacy/Unsupported System - Full Cylinder & Control Replacement", keywords: ["no longer supported", "unsupported", "legacy"] }
  ];
 
  /**
   * Naive but transparent keyword scorer. Returns ranked category matches
   * with confidence so the UI can show "best guess" + alternates rather
   * than silently committing to one category.
   */
  function matchDeficiencyCategories(freeText) {
    const text = (freeText || "").toLowerCase();
    const scored = KEYWORD_MAP.map(({ category, keywords }) => {
      const hits = keywords.filter((k) => text.includes(k)).length;
      return { category, hits, confidence: hits / keywords.length };
    }).filter((s) => s.hits > 0);
 
    scored.sort((a, b) => b.hits - a.hits);
 
    return scored.map((s) => ({
      ...s,
      taxonomyEntry: taxonomy.find((t) => t.category === s.category)
    }));
  }
 
  // -------------------------------------------------------------------------
  // 4. MANUFACTURER-AWARE PART CODE RESOLUTION
  // -------------------------------------------------------------------------
 
  /**
   * Given a manufacturer name + part role (e.g. "nozzle", "cylinder",
   * "cartridge"), return the correct part code + price from the price book.
   */
  function resolvePartCode(manufacturerKey, role) {
    const mfg = manufacturers[manufacturerKey];
    if (!mfg) return null;
 
    const roleToFieldMap = {
      nozzle: "nozzle_code",
      cylinder: "cylinder_code",
      cartridge: "cartridge_codes",
      control_head: "control_head_code",
      microswitch: "microswitch_code",
      pull_station: "pull_station_code",
      swivel: "swivel_adapter_code"
    };
 
    const field = roleToFieldMap[role];
    if (!field || !mfg[field]) return null;
 
    const code = typeof mfg[field] === "string" ? mfg[field] : null;
    if (!code) return { note: "Multiple variants - resolve specific model", options: mfg[field] };
 
    const priceEntry = priceBook.find((p) => p.code === code);
    return priceEntry || null;
  }
 
  // -------------------------------------------------------------------------
  // 5. LINE ITEM BUILDER
  // -------------------------------------------------------------------------
 
  function buildLineItem(code, description, quantity, unitPrice, taxRate) {
    const lineSubtotal = quantity * unitPrice;
    const lineTax = round2(lineSubtotal * taxRate);
    return {
      code,
      description,
      quantity,
      unitPrice,
      tax: lineTax,
      total: round2(lineSubtotal + lineTax)
    };
  }
 
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
 
  // -------------------------------------------------------------------------
  // 6. DETERMINISTIC QUOTE DRAFT (the deterministic 80% path)
  // -------------------------------------------------------------------------
 
  /**
   * @param {object} input
   *   input.freeTextDeficiency  - raw tech note, e.g. "3 nozzles clogged on R102 3gal"
   *   input.manufacturer        - "Ansul" | "Pyro Chem (PCL)" | "Kidde / Range Guard" | "Buckeye" | "Protex / Protex II"
   *   input.serviceAddress      - { city, state, zip }
   *   input.quantities          - optional explicit override, e.g. { nozzles: 3, links: 2 }
   *   input.preparedBy          - tech/rep name
   *   input.customer            - { name, address, phone }
   *   input.laborHours          - estimated hours (default 2)
   *   input.emergencyDispatch   - boolean, applies premium labor rate
   */
  function draftQuote(input) {
    const {
      freeTextDeficiency,
      manufacturer,
      serviceAddress = {},
      quantities = {},
      preparedBy = "",
      customer = {},
      laborHours = 2,
      emergencyDispatch = false
    } = input;
 
    const matches = matchDeficiencyCategories(freeTextDeficiency || "");
    const topMatch = matches[0];
    const { rate: taxRate, source: taxSource, needsConfirmation } = resolveTaxRate(serviceAddress);
 
    const lineItems = [];
    const flags = [];
 
    if (!topMatch) {
      flags.push({
        type: "NO_CATEGORY_MATCH",
        message: "Free text did not match a known deficiency category. Route to AI fallback (buildAiDraftPrompt) or human review."
      });
    } else {
      flags.push({
        type: "CATEGORY_MATCHED",
        category: topMatch.category,
        confidence: topMatch.confidence,
        alternates: matches.slice(1).map((m) => m.category)
      });
    }
 
    // Nozzle line items (common across nearly every category)
    if (quantities.nozzles && manufacturer) {
      const nozzlePart = resolvePartCode(manufacturer, "nozzle");
      if (nozzlePart && nozzlePart.price) {
        lineItems.push(
          buildLineItem(nozzlePart.code, nozzlePart.description, quantities.nozzles, nozzlePart.price, taxRate)
        );
      } else {
        flags.push({ type: "MISSING_PART_CODE", role: "nozzle", manufacturer });
      }
    }
 
    // Fusible link / detector bracket line items
    if (quantities.links) {
      const linkPart = priceBook.find((p) => p.code === "UP7020");
      lineItems.push(buildLineItem(linkPart.code, linkPart.description, quantities.links, linkPart.price, taxRate));
    }
    if (quantities.brackets) {
      const bracketPart =
        priceBook.find((p) => p.code === "UP7348") || priceBook.find((p) => (p.description || "").includes("BRACKET"));
      if (bracketPart) {
        lineItems.push(
          buildLineItem(bracketPart.code, bracketPart.description, quantities.brackets, bracketPart.price, taxRate)
        );
      }
    }
 
    // Cylinder/tank swap (single unit, category-driven)
    if (quantities.cylinderSwap && manufacturer) {
      const cylPart = resolvePartCode(manufacturer, "cylinder");
      if (cylPart && cylPart.price) {
        lineItems.push(buildLineItem(cylPart.code, cylPart.description, 1, cylPart.price, taxRate));
      } else {
        flags.push({
          type: "CYLINDER_NEEDS_MODEL_SELECTION",
          manufacturer,
          message:
            "Multiple cylinder size variants exist for this manufacturer - confirm exact model (e.g. BFR-10 vs BFR-15 vs BFR-20) before finalizing."
        });
      }
    }
 
    // Repipe (judgment line - always flagged for human confirmation on price)
    if (quantities.repipeNeeded) {
      const repipeEntry = priceBook.find(
        (p) => p.description === "REPIPE (labor/material bundle line for re-routing drops)"
      );
      const repipePrice = quantities.repipePrice || (repipeEntry && repipeEntry.typical) || 250;
      lineItems.push(buildLineItem(null, "REPIPE", 1, repipePrice, taxRate));
      flags.push({
        type: "VARIABLE_PRICE_LINE",
        line: "REPIPE",
        note: "Repipe pricing ranges $50-$300 in historical data depending on scope/footage. Defaulted to typical ($250) unless overridden - confirm against actual job scope before sending."
      });
    }
 
    // Labor (always present)
    const laborRate = emergencyDispatch
      ? referenceData.labor_rates.after_hours_emergency.premium_rate_example
      : laborRates.kitchen_suppression_labor.current_rate;
    lineItems.push(buildLineItem("UP7031", "KITCHEN SUPPRESSION LABOR", laborHours, laborRate, taxRate));
    if (emergencyDispatch) {
      flags.push({
        type: "EMERGENCY_DISPATCH",
        message: "After-hours/emergency premium labor rate applied. Confirm 2-technician dispatch is warranted (see operational_signal_patterns)."
      });
    }
 
    const subtotal = round2(lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0));
    const taxTotal = round2(lineItems.reduce((sum, li) => sum + li.tax, 0));
    const grandTotal = round2(subtotal + taxTotal);
 
    if (needsConfirmation) {
      flags.push({
        type: "TAX_RATE_NEEDS_CONFIRMATION",
        appliedRate: taxRate,
        source: taxSource,
        message: "PA local tax rate varies by county (6% vs 6.625% both seen in historical data). Confirm correct rate for this ZIP before sending."
      });
    }
 
    return {
      quoteType: emergencyDispatch ? "Service Call" : "Upgrade",
      preparedBy,
      customer,
      descriptionOfWork: {
        narrative: boilerplate.code_compliance_notice,
        deficiencyBullets: freeTextDeficiency ? [freeTextDeficiency] : [],
        matchedCategory: topMatch ? topMatch.category : null
      },
      lineItems,
      subtotal,
      taxRate,
      taxTotal,
      grandTotal,
      standardDisclaimers: [
        boilerplate.hours_notice,
        boilerplate.scope_exclusion_standard,
        boilerplate.approval_and_payment_terms,
        boilerplate.code_compliance_notice
      ],
      flags
    };
  }
 
  // -------------------------------------------------------------------------
  // 7. AI FALLBACK PROMPT BUILDER (for the ~20% deterministic matching misses)
  // -------------------------------------------------------------------------
 
  /**
   * Builds a grounded prompt for Claude to draft a quote when the
   * deterministic matcher can't confidently categorize the deficiency
   * (e.g. highly specific multi-appliance jobs like ST13/ST27/ST29 in the
   * reference set). Feeds the relevant slices of the reference dataset as
   * context rather than the whole file, to keep the prompt tight.
   */
  function buildAiDraftPrompt({ freeTextDeficiency, manufacturer, serviceAddress, customer }) {
    const relevantTaxonomy = taxonomy.filter((t) =>
      freeTextDeficiency
        ? t.trigger_language
            .toLowerCase()
            .split(" ")
            .some((w) => freeTextDeficiency.toLowerCase().includes(w))
        : true
    );
    const relevantMfg = manufacturer ? { [manufacturer]: manufacturers[manufacturer] } : manufacturers;
 
    return `You are drafting a fire suppression system deficiency quote for Universal Fire Protection, following their exact historical quoting conventions.
 
CUSTOMER / JOB CONTEXT:
${JSON.stringify({ customer, serviceAddress, manufacturer }, null, 2)}
 
RAW DEFICIENCY NOTE FROM TECHNICIAN:
"${freeTextDeficiency}"
 
REFERENCE PRICE BOOK (use these codes/prices exactly - do not invent new ones):
${JSON.stringify(priceBook, null, 2)}
 
RELEVANT DEFICIENCY CATEGORY PATTERNS (for structure/tone matching):
${JSON.stringify(relevantTaxonomy, null, 2)}
 
MANUFACTURER SYSTEM DATA:
${JSON.stringify(relevantMfg, null, 2)}
 
STANDARD BOILERPLATE (include verbatim, do not paraphrase):
${JSON.stringify(boilerplate, null, 2)}
 
INSTRUCTIONS:
1. Identify every distinct deficiency in the technician's note and map each to a "Services to be completed" entry using the bracketed category tags observed in real quotes: [Fire Suppression], [Kitchen Suppression], or [Portable Extinguishers].
2. Build a Code/Parts/Labor/Items table using ONLY codes from the reference price book above. If a needed part has no code in the price book, list it with code "null" and flag it explicitly as "NEEDS PRICE BOOK ENTRY" rather than guessing a price.
3. Always include UP7031 KITCHEN SUPPRESSION LABOR with a defensible hour estimate based on job complexity (compare to similar real_quote_index entries in scope).
4. If the job involves microswitch wiring or gas valve work, insert the licensed electrician / licensed plumber disclaimer exactly as worded in boilerplate_text_blocks.
5. Calculate subtotal, tax (look up correct rate for the service address state/city), and grand total.
6. Flag anything you are uncertain about (tax rate, part quantities, repipe scope) instead of silently guessing - historical quotes show repipe and pipe/fitting costs vary widely by job, so do not over-commit to a price without noting the uncertainty.
7. Output structured JSON matching the draftQuote() return shape: { quoteType, preparedBy, customer, descriptionOfWork, lineItems, subtotal, taxRate, taxTotal, grandTotal, standardDisclaimers, flags }.`;
  }
 
  return {
    resolveTaxRate,
    matchDeficiencyCategories,
    resolvePartCode,
    draftQuote,
    buildAiDraftPrompt
  };
}
 
// ---------------------------------------------------------------------------
// EXAMPLE USAGE
// ---------------------------------------------------------------------------
//
// const referenceData = require("./unipro_deficiency_quote_reference.json");
// const engine = createQuoteEngine(referenceData);
//
// const draft = engine.draftQuote({
//   freeTextDeficiency: "3 nozzles clogged on the Ansul R102 3gal, also fusible link frozen",
//   manufacturer: "Ansul",
//   serviceAddress: { city: "Philadelphia", state: "PA", zip: "19136" },
//   quantities: { nozzles: 3, links: 1 },
//   preparedBy: "Lexi Canfield",
//   customer: { name: "Example Diner", address: "123 Main St", phone: "555-1234" },
//   laborHours: 2
// });
// console.log(JSON.stringify(draft, null, 2));
//
// For an ambiguous/complex job, route to the AI fallback instead:
// const prompt = engine.buildAiDraftPrompt({
//   freeTextDeficiency: "Whole back hood needs upgrade, drops are wrong size, gas valve is in the ceiling...",
//   manufacturer: "Kidde / Range Guard",
//   serviceAddress: { city: "Sussex", state: "NJ", zip: "07461" },
//   customer: { name: "Example Hibachi", address: "205 NJ-23", phone: "973-875-1414" }
// });
// // send `prompt` to the Claude API via the unipro-ai-proxy Worker
 
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createQuoteEngine };
}
if (typeof window !== "undefined") {
  window.UniProQuoteEngine = { createQuoteEngine };
}
