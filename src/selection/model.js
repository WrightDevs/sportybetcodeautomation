'use strict';
// Pure probability model. No network, no clock, no globals except config defaults.
// Numbers come from code; the LLM never sets probabilities.
const { SELECTION } = require('./config');

const MAX_GOALS = 14;

// ── de-vig ────────────────────────────────────────────────
// outcomes: [{ odds }] of ONE market/specifier. Returns probs summing to 1 (same order).
// `target` = what the probabilities must sum to: 1 for exclusive markets, 2 for Double Chance
// (its three outcomes overlap: each result is covered by exactly two outcomes).
function devig(outcomes, target = 1) {
  const inv = outcomes.map(o => {
    const x = Number(o.odds);
    return x > 1 ? 1 / x : 0;
  });
  const sum = inv.reduce((a, b) => a + b, 0);
  return sum > 0 ? inv.map(v => (v / sum) * target) : inv.map(() => 0);
}

// ── time ──────────────────────────────────────────────────
// Stage 'HT' | 'FT'. Remaining raw minutes, and the exposure after window scaling.
function remainingMinutes(stage, minute, cfg = SELECTION) {
  const end = cfg.MATCH_END[stage];
  return Math.max(0, end - minute);
}
// Multiplier applied to the market-implied remaining goal rate (>= 1 = more cautious).
function timeScale(stage, cfg = SELECTION) {
  if (!cfg.TIME_SCALING) return 1;
  return cfg.MATCH_END[stage] / cfg.MARKET_WINDOW[stage];
}

// ── poisson ───────────────────────────────────────────────
function poissonPmf(lambda, kmax = MAX_GOALS) {
  const out = new Array(kmax + 1);
  let p = Math.exp(-lambda);
  out[0] = p;
  for (let k = 1; k <= kmax; k++) {
    p = (p * lambda) / k;
    out[k] = p;
  }
  return out;
}
function poissonCdf(lambda, k) {
  if (k < 0) return 0;
  const pmf = poissonPmf(lambda, Math.min(Math.floor(k), 60));
  return Math.min(1, pmf.reduce((a, b) => a + b, 0));
}

// ── rate fitting from live ladders ───────────────────────
// lines: [{ line, pUnder }] with pUnder de-vigged. total = goals already scored in scope.
// Fits remaining-goal rate lambda by least squares on P(R <= floor(line-total)) = pUnder.
function fitRate(lines, total) {
  const usable = lines.filter(l => l.line > total && l.pUnder > 0 && l.pUnder < 1);
  if (!usable.length) return null;
  let best = null;
  for (let i = 0; i <= 400; i++) {
    const lambda = 0.005 + i * 0.0125; // 0.005 .. 5
    let err = 0;
    for (const l of usable) {
      const d = poissonCdf(lambda, Math.floor(l.line - total)) - l.pUnder;
      err += d * d;
    }
    if (!best || err < best.err) best = { lambda, err };
  }
  return { lambda: best.lambda, rmse: Math.sqrt(best.err / usable.length), n: usable.length };
}

function ladderOf(markets, outcomeUnderId = '13', outcomeOverId = '12') {
  const out = [];
  for (const m of markets) {
    const v = /^total=([\d.]+)$/.exec(m.specifier || '');
    if (!v) continue;
    const under = (m.outcomes || []).find(o => String(o.id) === outcomeUnderId && isActive(o));
    const over = (m.outcomes || []).find(o => String(o.id) === outcomeOverId && isActive(o));
    if (!under || !over) continue;
    const [pOver, pUnder] = devig([over, under]);
    out.push({ line: Number(v[1]), pUnder, pOver });
  }
  return out.sort((a, b) => a.line - b.line);
}
const isActive = o => o && (o.isActive === 1 || o.isActive === '1' || o.isActive === undefined);

// ── per-event rate state ─────────────────────────────────
// Returns { stage, lamH, lamA, lamTotal, split, rmse, scoreH, scoreA } or null if the market gives no rate.
// getMarkets(id) must return ACTIVE markets (status 0, not banned) of that id.
function eventRates({ stage, minute, score, getMarkets, cfg = SELECTION }) {
  const isHT = stage === 'HT';
  const total = score.h + score.a;
  const totalLadder = ladderOf(getMarkets(isHT ? '68' : '18'));
  const fit = fitRate(totalLadder, total);
  if (!fit) return null;
  const scale = timeScale(stage, cfg);
  const lamTotal = fit.lambda * scale;

  // Team split from FT team-total ladders (markets 19/20). HT has no team ladder: reuse the FT share.
  const hFit = fitRate(ladderOf(getMarkets('19')), isHT ? score.h : score.h);
  const aFit = fitRate(ladderOf(getMarkets('20')), isHT ? score.a : score.a);
  let share = 0.5, split = false;
  if (hFit && aFit && hFit.lambda + aFit.lambda > 0) {
    share = hFit.lambda / (hFit.lambda + aFit.lambda);
    split = true;
  }
  return {
    stage, minute, scoreH: score.h, scoreA: score.a,
    lamTotal, lamH: lamTotal * share, lamA: lamTotal * (1 - share),
    split, rmse: fit.rmse, rateLines: fit.n
  };
}

// ── leg probability ──────────────────────────────────────
// P(final-state predicate) for remaining goals Rh ~ Poi(lamH), Ra ~ Poi(lamA), independent.
function jointDist(lamH, lamA) {
  return { ph: poissonPmf(lamH), pa: poissonPmf(lamA) };
}
function probWhere(rates, pred) {
  const { ph, pa } = jointDist(rates.lamH, rates.lamA);
  let p = 0;
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      if (pred(rates.scoreH + i, rates.scoreA + j, i, j)) p += ph[i] * pa[j];
    }
  }
  return Math.min(1, p);
}

// Predicate for a candidate leg: (finalH, finalA) => bool, or null if the market is not modelled.
// Market/outcome ids verified against live factsCenter output (see test/fixtures).
function legPredicate(c) {
  const mid = String(c.marketId), oid = String(c.outcomeId), spec = String(c.specifier || '');
  const line = (/total=([\d.]+)/.exec(spec) || [])[1];
  const hcp = /^hcp=(\d+):(\d+)$/.exec(spec);
  if ((mid === '18' || mid === '68') && line !== undefined) {
    const L = Number(line);
    return oid === '13' ? (h, a) => h + a < L : oid === '12' ? (h, a) => h + a > L : null;
  }
  if (mid === '19' && line !== undefined) {
    const L = Number(line);
    return oid === '13' ? (h) => h < L : oid === '12' ? (h) => h > L : null;
  }
  if (mid === '20' && line !== undefined) {
    const L = Number(line);
    return oid === '13' ? (h, a) => a < L : oid === '12' ? (h, a) => a > L : null;
  }
  if (mid === '29') { // GG/NG: 74 = Yes, 76 = No
    return oid === '76' ? (h, a) => h === 0 || a === 0 : oid === '74' ? (h, a) => h > 0 && a > 0 : null;
  }
  if (mid === '1' || mid === '60') {
    return oid === '1' ? (h, a) => h > a : oid === '2' ? (h, a) => h === a : oid === '3' ? (h, a) => a > h : null;
  }
  if (mid === '10' || mid === '63') { // 9 = 1X, 10 = 12, 11 = X2
    return oid === '9' ? (h, a) => h >= a : oid === '10' ? (h, a) => h !== a : oid === '11' ? (h, a) => a >= h : null;
  }
  if ((mid === '14' || mid === '65') && hcp) {
    const x = Number(hcp[1]), y = Number(hcp[2]);
    return oid === '1711' ? (h, a) => h + x > a + y
      : oid === '1712' ? (h, a) => h + x === a + y
      : oid === '1713' ? (h, a) => a + y > h + x : null;
  }
  return null;
}

// Team-split-dependent markets cannot be priced without a real team split.
function needsSplit(c) {
  const mid = String(c.marketId);
  return ['1', '60', '10', '63', '14', '65', '29', '19', '20'].includes(mid);
}

function legProbability(c, rates) {
  const pred = legPredicate(c);
  if (!pred) return { ok: false, reason: `unmodelled market ${c.marketId}/${c.outcomeId}` };
  if (needsSplit(c) && !rates.split) return { ok: false, reason: 'no team-total ladder for team split' };
  return { ok: true, p: probWhere(rates, pred) };
}

// De-vigged probability of the leg's own outcome inside its market (same specifier).
function marketProb(c) {
  const outs = (c.market && c.market.outcomes || []).filter(isActive);
  if (!outs.length) return null;
  const probs = devig(outs, ['10', '63'].includes(String(c.marketId)) ? 2 : 1);
  const i = outs.findIndex(o => String(o.id) === String(c.outcomeId));
  return i >= 0 ? probs[i] : null;
}

module.exports = {
  devig, remainingMinutes, timeScale, poissonPmf, poissonCdf, fitRate, ladderOf,
  eventRates, probWhere, legPredicate, legProbability, marketProb, needsSplit, isActive
};
