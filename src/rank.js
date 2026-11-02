'use strict';
const { CFG } = require('./config');

const PROMPT_HEAD = `Pick the safest legs for a long accumulator.
Double chance on a strong favourite beats draw-no-bet, which beats over 0.5 goals.
Avoid tight 1X2, GG/NG, handicap lines and obscure or simulated competitions.
Return JSON only: {"order":[indices safest first]}. Each index exactly once.
`;

async function llmRank(legs) {
  if (!CFG.USE_LLM || !CFG.LLM_KEY || legs.length < 10) return legs;

  const list = legs.map((l, i) => `${i}|${l.league}|${l.home} v ${l.away}|${l.desc} @${l.odds}`).join('\n');

  try {
    const r = await fetch(CFG.LLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.LLM_KEY}` },
      body: JSON.stringify({
        model: CFG.LLM_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: `${PROMPT_HEAD}\n${list}` }]
      })
    });

    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content || '';
    const order = JSON.parse((txt.match(/\{[\s\S]*\}/)?.[0]) || '{}').order;
    if (!Array.isArray(order)) throw new Error('no order in response');

    const picked = order.map(i => legs[i]).filter(Boolean);
    console.log(`  llm re-ranked ${picked.length}`);
    return picked.concat(legs.filter((_, i) => !order.includes(i)));
  } catch (e) {
    console.log('  llm failed:', e.message, '— heuristic order kept');
    return legs;
  }
}

module.exports = { llmRank };

