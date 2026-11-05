'use strict';
// Shared, pure slip selector. Deterministic code decides; the LLM may only veto (see veto.js).
// Usage: selectSlip(events, { legs }, deps)
//   events: [{ ev, minute, score:{h,a}, stage:'HT'|'FT' }]  (live, already time-window gated by the caller)
//   deps.generateCandidates(ev, minute, score, stage) -> candidate legs (market evaluators)
//   deps.getMarkets(ev, id) -> ACTIVE markets of that id
const { SELECTION } = require('./config');
const M = require('./model');

const clamp01 = x => Math.max(0, Math.min(1, x));

function typeKey(c) {
  const t = c.type || c.window || '';
  if (/_under$/.test(t)) {
    const hi = /^ht/.test(t) ? c.line >= 2.5 : c.line >= 4.5;
    if (hi) return t + '_high';
  }
  return t;
}

function safetyScore(p, gap, c, cfg, leagueOk) {
  const w = cfg.SCORE_WEIGHTS;
  const pNorm = clamp01((p - 0.5) / 0.5);
  const coh = clamp01(1 - gap / cfg.COHERENCE_TOL);
  const type = cfg.TYPE_SAFETY[typeKey(c)] ?? 0.3;
  return Math.round(100 * (w.prob * pNorm + w.coherence * coh + w.type * type + w.league * (leagueOk ? 1 : 0)));
}

// Evaluate one candidate. Returns { leg } if it survives, or { rejected: reason }.
function evaluateCandidate(c, ctx, cfg) {
  const { ev, rates, isVirtual } = ctx;
  if (c.odds < cfg.MIN_LEG_ODDS) return { rejected: 'odds<MIN_LEG_ODDS' };
  if (c.odds > cfg.MAX_LEG_ODDS) return { rejected: 'odds>MAX_LEG_ODDS' };
  if (!isVirtual && cfg.JUNK_LEAGUE.test(ev.league || '')) return { rejected: 'junk league' };

  const mp = M.legProbability(c, rates);
  if (!mp.ok) return { rejected: mp.reason };
  const pMarket = M.marketProb(c);
  if (pMarket == null) return { rejected: 'no market probability' };

  const gap = Math.abs(mp.p - pMarket);
  if (gap > cfg.COHERENCE_TOL) return { rejected: `incoherent (model ${mp.p.toFixed(2)} vs market ${pMarket.toFixed(2)})`, gap };

  const p = Math.min(mp.p, pMarket); // conservative: the lower of model and de-vigged market
  if (p < cfg.MIN_LEG_PROB) return { rejected: `prob ${p.toFixed(2)}<MIN_LEG_PROB` };

  const leg = {
    id: ev.eventId, eventId: ev.eventId,
    home: ev.homeTeamName, away: ev.awayTeamName, league: ev.league || '',
    marketId: c.marketId, specifier: c.specifier || '', outcomeId: c.outcomeId,
    odds: c.odds, type: c.type, line: c.line, description: c.description, reasoning: c.reasoning,
    prob: Number(p.toFixed(4)), probModel: Number(mp.p.toFixed(4)), probMarket: Number(pMarket.toFixed(4)),
    coherenceGap: Number(gap.toFixed(4)),
    stage: ctx.stage, minute: ctx.minute, scoreH: ctx.score.h, scoreA: ctx.score.a,
    lamTotal: Number(rates.lamTotal.toFixed(3)),
    flags: []
  };
  leg.score = safetyScore(p, gap, c, cfg, true);
  leg.analysis = c;
  return { leg };
}

function isStraightWin(c) {
  return (c.type === 'h1_winner' || c.type === 'match_winner_2lead');
}

// Step A-D for one event: returns ranked surviving legs (best first) + rejection reasons.
function rankEventLegs(item, cfg, deps, isVirtual) {
  const { ev, minute, score, stage } = item;
  const getMarkets = id => deps.getMarkets(ev, id);
  const rates = M.eventRates({ stage, minute, score, getMarkets, cfg });
  if (!rates) return { legs: [], rejects: [{ eventId: ev.eventId, reason: 'no live total ladder to derive scoring rate' }] };

  const cands = deps.generateCandidates(ev, minute, score, stage) || [];
  const legs = [], rejects = [];
  for (const c of cands) {
    const r = evaluateCandidate(c, { ev, rates, stage, minute, score, isVirtual }, cfg);
    if (r.leg) legs.push(r.leg);
    else rejects.push({ eventId: ev.eventId, market: `${c.marketId}/${c.outcomeId}${c.specifier ? ' ' + c.specifier : ''}`, reason: r.rejected });
  }

  // Straight win only if no Double Chance leg survived on this match (DC is the safer shape).
  const hasDC = legs.some(l => /double_chance/.test(l.type || ''));
  const kept = legs.filter(l => {
    if (!isStraightWin(l)) return true;
    if (l.prob < cfg.MIN_WIN_PROB) { rejects.push({ eventId: ev.eventId, market: `${l.marketId}/${l.outcomeId}`, reason: 'straight win below MIN_WIN_PROB' }); return false; }
    if (hasDC) { rejects.push({ eventId: ev.eventId, market: `${l.marketId}/${l.outcomeId}`, reason: 'safer Double Chance available' }); return false; }
    return true;
  });
  kept.sort((a, b) => b.score - a.score || b.prob - a.prob || a.odds - b.odds);
  return { legs: kept, rejects };
}

const teamsOf = l => [String(l.home || '').toLowerCase(), String(l.away || '').toLowerCase()].filter(Boolean);

// Step E: build a slip of `legsNeeded` legs from the ranked pool (one per event), no shared teams.
function buildSlip(pool, legsNeeded, cfg) {
  const picked = [], used = new Set(), reserves = [];
  const teams = new Set();
  for (const l of pool) {
    const t = teamsOf(l);
    if (picked.length < legsNeeded && !t.some(x => teams.has(x))) {
      picked.push(l); t.forEach(x => teams.add(x)); used.add(l.eventId);
    } else if (!used.has(l.eventId)) {
      reserves.push(l);
    }
  }
  const jointProb = picked.reduce((a, l) => a * l.prob, 1);
  const out = { legs: picked, reserves: reserves.slice(0, cfg.MAX_RESERVES), jointProb: Number(jointProb.toFixed(4)) };
  if (picked.length < legsNeeded) {
    return { ok: false, ...out, reason: 'no safe slip', reasons: [`only ${picked.length}/${legsNeeded} legs passed the safety filters`] };
  }
  if (jointProb < cfg.MIN_SLIP_PROB) {
    return { ok: false, ...out, reason: 'no safe slip', reasons: [`joint probability ${jointProb.toFixed(3)} < MIN_SLIP_PROB ${cfg.MIN_SLIP_PROB}`] };
  }
  out.totalOdds = Number(picked.reduce((a, l) => a * l.odds, 1).toFixed(2));
  return { ok: true, ...out };
}

function selectSlip(events, opts = {}, deps = {}, cfg = SELECTION) {
  const legsNeeded = Math.max(1, Number(opts.legs) || 1);
  const isVirtual = opts.isVirtual !== false;
  const best = []; const rejects = [];
  const seen = new Set();
  for (const item of events) {
    if (!item.ev || seen.has(item.ev.eventId)) continue; // one leg per match
    seen.add(item.ev.eventId);
    const r = rankEventLegs(item, cfg, deps, isVirtual);
    rejects.push(...r.rejects);
    if (r.legs.length) {
      // best leg per match goes to the pool; its runners-up are kept as same-match alternates
      r.legs[0].alternates = r.legs.slice(1, 3).map(l => ({ marketId: l.marketId, outcomeId: l.outcomeId, specifier: l.specifier, prob: l.prob, score: l.score }));
      best.push(r.legs[0]);
    }
  }
  best.sort((a, b) => b.score - a.score || b.prob - a.prob);
  const slip = buildSlip(best, legsNeeded, cfg);
  return { ...slip, legsNeeded, candidatesConsidered: best.length, rejects };
}

// Step F helper: apply veto verdicts. Dropped legs are replaced from reserves (never added otherwise),
// then the joint-probability bar is re-checked.
function applyVeto(selection, verdicts, cfg = SELECTION) {
  const drop = new Set((verdicts || []).filter(v => v && v.verdict === 'drop').map(v => String(v.legId)));
  if (!drop.size) return { ...selection, dropped: [] };
  const dropped = selection.legs.filter(l => drop.has(String(l.eventId)));
  const pool = [...selection.legs.filter(l => !drop.has(String(l.eventId))),
    ...selection.reserves.filter(l => !drop.has(String(l.eventId)))];
  pool.sort((a, b) => b.score - a.score || b.prob - a.prob);
  const rebuilt = buildSlip(pool, selection.legsNeeded, cfg);
  return { ...rebuilt, legsNeeded: selection.legsNeeded, rejects: selection.rejects || [], dropped };
}

module.exports = { selectSlip, applyVeto, buildSlip, evaluateCandidate, rankEventLegs, safetyScore };
