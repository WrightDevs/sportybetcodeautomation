'use strict';
/**
 * AI Verification Layer
 * Sends candidate legs enriched with verified 5DollarFootballAPI statistics
 * to LLM (Gemini 2.0 Flash / DeepSeek) for risk auditing.
 */

const { CFG } = require('../config');

function sanitizeVerdicts(raw, legs) {
  const ids = new Set(legs.map(l => String(l.eventId || l.id || l.legId)));
  const out = [];

  for (const v of Array.isArray(raw) ? raw : []) {
    if (!v || !ids.has(String(v.legId))) continue;
    out.push({
      legId: String(v.legId),
      verdict: v.verdict === 'drop' ? 'drop' : 'keep',
      source: 'llm', // an explicit answer from the model (the fallback path marks 'heuristic')
      confidence: typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : 0.85,
      reason: String(v.reason || '').slice(0, 250)
    });
  }
  return out;
}

/**
 * Verify candidate legs with statistical evidence using LLM
 * @param {Array<Object>} legs - Array of candidate legs with stats
 * @param {Object} options
 * @returns {Promise<Array<Object>>} Verdicts
 */
async function verifyLegsWithAi(legs, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const keepAll = () => legs.map(l => {
    // If local analyzer flagged a hard contradiction, drop it even if LLM is skipped
    const isContradicted = l.stats?.alignment === 'STAT_CONTRADICTION';
    return {
      legId: String(l.eventId || l.id || l.legId),
      verdict: isContradicted ? 'drop' : 'keep',
      source: 'heuristic',
      confidence: isContradicted ? 0.3 : 0.85,
      reason: isContradicted ? `Heuristic statistical contradiction: ${l.stats.summary}` : 'Stats verified'
    };
  });

  if (!CFG.USE_LLM || !CFG.LLM_KEY || !Array.isArray(legs) || legs.length === 0) {
    return keepAll();
  }

  const payload = legs.map(l => ({
    legId: String(l.eventId || l.id || l.legId),
    match: `${l.home} vs ${l.away}`,
    league: l.league,
    market: l.desc || l.description,
    odds: l.odds,
    prob: l.prob || l.deviggedProb,
    stats: l.stats || { hasStats: false }
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CFG.LLM_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CFG.LLM_KEY}`
      },
      body: JSON.stringify({
        model: CFG.LLM_MODEL,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are an elite sports statistics risk auditor for an automated betting system. '
              + 'Your job is to review proposed picks against real-world team statistics (form, PPG, goal averages, table rank). '
              + 'Prioritize safety and probability over odds value. '
              + 'Return ONLY a JSON array: [{"legId":"...","verdict":"keep"|"drop","confidence":0.0-1.0,"reason":"..."}].'
          },
          {
            role: 'user',
            content: `Audit the following shortlisted legs against their verified team statistics. `
              + `Drop any pick that is statistically contradicted (e.g. poor form on favorite, high goal expectation on Under pick, weak defense, `
              + `an Over pick where either team often fails to score or the combined goal expectation is low). `
              + `Keep picks that are strongly corroborated by the statistics:\n${JSON.stringify(payload, null, 2)}`
          }
        ]
      })
    });

    clearTimeout(timer);

    if (!res.ok) {
      return keepAll();
    }

    const j = await res.json();
    const txt = j.choices?.[0]?.message?.content || '';
    const jsonMatch = txt.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return keepAll();

    const parsed = JSON.parse(jsonMatch[0]);
    const clean = sanitizeVerdicts(parsed, legs);
    return clean.length ? clean : keepAll();
  } catch (_) {
    clearTimeout(timer);
    return keepAll();
  }
}

module.exports = {
  verifyLegsWithAi,
  sanitizeVerdicts
};

