'use strict';
// LLM veto: may only DROP legs (or keep them). Never adds legs, never changes probabilities.
// Fail-open: no key / timeout / bad JSON => every leg kept.
const { CFG } = require('../config');
const { SELECTION } = require('./config');

function sanitize(raw, legs) {
  const ids = new Set(legs.map(l => String(l.eventId)));
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!v || !ids.has(String(v.legId))) continue; // cannot reference unknown legs => cannot add
    out.push({ legId: String(v.legId), verdict: v.verdict === 'drop' ? 'drop' : 'keep', reason: String(v.reason || '').slice(0, 200) });
  }
  return out;
}

async function vetoLegs(legs, { fetchImpl = fetch, timeoutMs = SELECTION.LLM_VETO_TIMEOUT_MS } = {}) {
  const keepAll = () => legs.map(l => ({ legId: String(l.eventId), verdict: 'keep', reason: 'veto skipped' }));
  if (!CFG.USE_LLM || !CFG.LLM_KEY || legs.length < 2) return keepAll();

  const payload = legs.map(l => ({
    legId: String(l.eventId), match: `${l.home} v ${l.away}`, league: l.league,
    market: l.description, odds: l.odds, prob: l.prob, score: l.score, flags: l.flags,
    state: `${l.scoreH}-${l.scoreA} @${Math.round(l.minute)}'`,
    stats: l.stats || undefined
  }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(CFG.LLM_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.LLM_KEY}` },
      body: JSON.stringify({
        model: CFG.LLM_MODEL, temperature: 0,
        messages: [{
          role: 'user',
          content: 'You review a shortlisted betting slip. You may only DROP a leg for a concrete reason '
            + '(suspicious price, incoherent market, clear data problem). You may not add legs or change numbers. '
            + 'Return JSON only: [{"legId":"...","verdict":"keep"|"drop","reason":"..."}] covering each leg.\n'
            + JSON.stringify(payload)
        }]
      })
    });
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content || '';
    const arr = JSON.parse((txt.match(/\[[\s\S]*\]/) || ['[]'])[0]);
    const clean = sanitize(arr, legs);
    return clean.length ? clean : keepAll();
  } catch (_) {
    return keepAll();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { vetoLegs, sanitize };
