// ── AI QUOTE SUGGESTION ──
async function aiSuggestQuote(){
  if (!_activeDef) return;
  const btn = document.getElementById('aiSuggestBtn');
  const resultEl = document.getElementById('aiSuggestResult');
  btn.disabled = true; btn.textContent = 'Thinking...';
  resultEl.style.display = 'block';

  // Try the deterministic price-book matcher first - instant, no AI call, fully auditable
  if (_quoteEngine) {
    const draft = _quoteEngine.draftQuote({
      freeTextDeficiency: _activeDef.description,
      serviceAddress: { city: _activeDef.city, state: _activeDef.state, zip: _activeDef.zip },
      preparedBy: 'Lexi',
      customer: { name: _activeDef.account }
    });
    const matched = draft.flags.find(f => f.type === 'CATEGORY_MATCHED');
    if (matched && matched.confidence >= 0.5 && draft.lineItems.length) {
      document.getElementById('qDesc').value = matched.category;
      document.getElementById('qPrice').value = draft.grandTotal;
      document.getElementById('qQty').value = '1';
      defCalcTotal();
      resultEl.textContent = 'Matched category: ' + matched.category +
        ' (price book match, confidence ' + Math.round(matched.confidence * 100) + '%). ' +
        'Review and adjust before sending, nothing sends automatically.';
      btn.disabled = false; btn.textContent = 'Suggest Quote';
      return;
    }
  }

  resultEl.textContent = 'Pulling reference quotes and reasoning through this one...';

  const refQuotes = rqLoad();
  const adjustments = adjLoad();

  // Build a compact reference list, real seed data first, then learned adjustments, capped to keep the prompt small
  const refLines = refQuotes.slice(-40).map(q => `${q.equipment} | ${q.description||''} | $${q.price} | ${q.resolution}`);
  const adjLines = adjustments.slice(-40).map(a => `${a.equipment} | ${a.description||''} | $${a.price} | ${a.resolution} (Lexi-adjusted)`);
  const allRef = [...refLines, ...adjLines];

  if (!allRef.length) {
    resultEl.innerHTML = 'No reference quotes loaded yet. Add a few real quotes under <a href="#" onclick="document.getElementById(\'refQuotesModal\').classList.add(\'open\');return false;" style="color:#92400E;font-weight:700">Reference Quotes</a> in the top bar, even five or six, and suggestions get dramatically better.';
    btn.disabled = false; btn.textContent = 'Suggest Quote';
    return;
  }

  const prompt = 'You are helping a fire protection and commercial kitchen services company write a deficiency repair quote. '
    + 'Below are real past quotes from this company as reference pricing. Use them to find the closest match by equipment type and issue, and base your suggestion on that real pricing, not generic industry guesses.\n\n'
    + 'REFERENCE QUOTES (equipment | description | price | resolution):\n' + allRef.join('\n') + '\n\n'
    + 'NEW DEFICIENCY TO QUOTE:\n'
    + 'Account: ' + _activeDef.account + '\n'
    + 'Equipment: ' + _activeDef.equipment + '\n'
    + 'Tech notes: ' + _activeDef.description + '\n'
    + 'Severity: ' + _activeDef.severity + '\n\n'
    + 'Respond in exactly this format, plain text, no markdown symbols, no em dashes:\n'
    + 'DESCRIPTION: [a clean one-line service description for the quote]\n'
    + 'PRICE: [a single dollar number, no symbols or commas]\n'
    + 'RESOLUTION: [today or return]\n'
    + 'REASONING: [one short sentence on why, referencing the closest matching reference quote if there is one]';

  try {
    const res = await fetch('https://unipro-ai-proxy.tedscholl.workers.dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);
    const priceMatch = text.match(/PRICE:\s*\$?([\d,.]+)/i);
    const resMatch = text.match(/RESOLUTION:\s*(today|return)/i);
    const reasonMatch = text.match(/REASONING:\s*(.+)/i);

    if (descMatch) document.getElementById('qDesc').value = descMatch[1].trim();
    if (priceMatch) { document.getElementById('qPrice').value = priceMatch[1].replace(/,/g,''); }
    document.getElementById('qQty').value = '1';
    defCalcTotal();
    if (resMatch) defSelectTrip(resMatch[1].toLowerCase() === 'today' ? 0 : 1);

    resultEl.textContent = (reasonMatch ? reasonMatch[1].trim() : text) + ' Review and adjust before sending, nothing sends automatically.';
  } catch(e) {
    resultEl.textContent = 'Could not reach the suggestion engine. Check the AI proxy connection and try again, or fill in the quote manually.';
  }
  btn.disabled = false; btn.textContent = 'Suggest Quote';
}
