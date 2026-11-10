'use strict';
// Normal (pre-match) football safe selector.
// Deterministic: a goal model is fitted per match to the de-vigged 1X2 + Over/Under ladder, every candidate leg
// gets a probability = min(model, de-vigged market), and slips are built per tier with a joint-probability bar.
// No staking. Booking codes only. Returns "no safe slip" instead of lowering the bar.
const { FOOTBALL } = require('./config');
const M = require('./model');

const HANDICAP_MARKETS = ['14'];
const clamp01 = x => Math.max(0, Math.min(1, x));
const isOn = o => o && (o.isActive === undefined || o.isActive === 1 || o.isActive === '1');
const activeMarkets = (ev, id) => (ev.markets || []).filter(m => String(m.id) === String(id) && m.status === 0);

// ── goal model fitted to the match ─────────────────────────
const GRID_STEP = 0.1, GRID_MAX = 3.6;
const pmfCache = new Map();
const pmf = lam => {
  const k = lam.toFixed(4);
  if (!pmfCache.has(k)) pmfCache.set(k, M.poissonPmf(lam, 12));
  return pmfCache.get(k);
};

function modelProbs(lh, la) {
  const ph = pmf(lh), pa = pmf(la);
  let p1 = 0, px = 0, p2 = 0;
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      const p = ph[i] * pa[j];
      if (i > j) p1 += p; else if (i === j) px += p; else p2 += p;
    }
  }
  return { p1, px, p2 };
}

function fitEvent(ev) {
  const m1 = activeMarkets(ev, '1')[0];
  if (!m1) return { reject: 'no active 1X2' };
  const outs = ['1', '2', '3'].map(id => (m1.outcomes || []).find(o => String(o.id) === id && isOn(o)));
  if (outs.some(o => !o)) return { reject: 'incomplete 1X2' };
  const [t1, tx, t2] = M.devig(outs);
  const ladder = M.ladderOf(activeMarkets(ev, '18')).filter(l => l.pUnder > 0.01 && l.pUnder < 0.99);
  if (ladder.length < 3) return { reject: 'total-goals ladder too thin' };

  const loss = (lh, la) => {
    const { p1, px, p2 } = modelProbs(lh, la);
    let e = (p1 - t1) ** 2 + (px - tx) ** 2 + (p2 - t2) ** 2;
    const lt = lh + la;
    for (const l of ladder) e += (M.poissonCdf(lt, Math.floor(l.line)) - l.pUnder) ** 2;
    return e;
  };
  let best = null;
  for (let lh = 0.2; lh <= GRID_MAX; lh += GRID_STEP) {
    for (let la = 0.2; la <= GRID_MAX; la += GRID_STEP) {
      const e = loss(lh, la);
      if (!best || e < best.e) best = { lh, la, e };
    }
  }
  for (let dh = -0.1; dh <= 0.1001; dh += 0.025) {
    for (let da = -0.1; da <= 0.1001; da += 0.025) {
      const lh = best.lh + dh, la = best.la + da;
      if (lh <= 0.05 || la <= 0.05) continue;
      const e = loss(lh, la);
      if (e < best.e) best = { lh, la, e };
    }
  }
  const n = 3 + ladder.length;
  const rmse = Math.sqrt(best.e / n);
  if (rmse > FOOTBALL.MAX_FIT_RMSE) return { reject: `goal model misfit (rmse ${rmse.toFixed(3)})` };
  return { rates: { lamH: best.lh, lamA: best.la, scoreH: 0, scoreA: 0 }, rmse };
}

// ── candidate legs for one match ───────────────────────────
// Only shapes we can price AND settle (market/outcome ids verified against live factsCenter output).
function candidatesOf(ev) {
  const out = [];
  const push = (m, o, type, extra = {}) => {
    if (!isOn(o)) return;
    const odds = parseFloat(o.odds);
    if (!(odds > 1)) return;
    out.push({ marketId: String(m.id), specifier: m.specifier || '', outcomeId: String(o.id), odds, type, market: m, ...extra });
  };

  for (const m of activeMarkets(ev, '10')) { // Double Chance: 9 = 1X, 10 = 12, 11 = X2
    for (const o of m.outcomes || []) {
      if (String(o.id) === '10' && !FOOTBALL.ALLOW_DC_12) continue;
      push(m, o, 'dc');
    }
  }
  for (const m of activeMarkets(ev, '14')) { // 3-way handicap: only the side that RECEIVES the head start
    const h = /^hcp=(\d+):(\d+)$/.exec(m.specifier || '');
    if (!h) continue;
    const x = Number(h[1]), y = Number(h[2]);
    if (x === y) continue;
    const want = x > y ? '1711' : '1713';
    for (const o of m.outcomes || []) if (String(o.id) === want) push(m, o, 'handicap', { headStart: Math.abs(x - y) });
  }
  for (const m of activeMarkets(ev, '29')) {
    for (const o of m.outcomes || []) if (String(o.id) === '76') push(m, o, 'nogg');
  }
  for (const m of activeMarkets(ev, '18')) {
    const line = Number((/total=([\d.]+)/.exec(m.specifier || '') || [])[1]);
    for (const o of m.outcomes || []) {
      if (line >= FOOTBALL.MIN_UNDER_LINE && String(o.id) === '13') push(m, o, 'under', { line });
      // Over legs are only ever used by tiers that list the 'over' family, and only after the stats/AI audit.
      if (FOOTBALL.OVER_LINES.includes(line) && String(o.id) === '12') push(m, o, 'over', { line });
    }
  }
  for (const m of activeMarkets(ev, '1')) {
    for (const o of m.outcomes || []) if (['1', '3'].includes(String(o.id))) push(m, o, 'win');
  }
  return out;
}

const describe = c => {
  if (c.type === 'dc') return { '9': 'Home or Draw', '10': 'Home or Away', '11': 'Draw or Away' }[c.outcomeId] || 'Double Chance';
  if (c.type === 'handicap') return `Handicap ${c.specifier.replace('hcp=', '')} ${c.outcomeId === '1711' ? 'Home' : 'Away'}`;
  if (c.type === 'nogg') return 'No GG (not both teams score)';
  if (c.type === 'under') return `Under ${c.line}`;
  if (c.type === 'over') return `Over ${c.line}`;
  return c.outcomeId === '1' ? 'Home win' : 'Away win';
};

// Evaluate one match: all candidates -> surviving legs sorted best-first, plus rejection reasons.
function evaluateEvent(ev, cfg = FOOTBALL) {
  const rejects = [];
  const rej = (market, reason) => rejects.push({ eventId: ev.eventId, market, reason });
  if (cfg.JUNK_LEAGUE.test(ev.league || '')) return { legs: [], rejects: [{ eventId: ev.eventId, reason: 'junk league' }] };
  const fit = fitEvent(ev);
  if (fit.reject) return { legs: [], rejects: [{ eventId: ev.eventId, reason: fit.reject }] };

  // Global ceiling = the widest per-tier ceiling; each tier filters again in poolFor.
  const oddsCeiling = Math.max(cfg.MAX_ODDS, ...Object.values(cfg.TIERS).map(t => t.maxLegOdds || 0));
  const legs = [];
  for (const c of candidatesOf(ev)) {
    const tag = `${c.marketId}/${c.outcomeId}${c.specifier ? ' ' + c.specifier : ''}`;
    if (c.odds < cfg.MIN_ODDS) { rej(tag, 'odds<MIN'); continue; }
    if (c.odds > oddsCeiling) { rej(tag, 'odds>MAX'); continue; }
    const pred = M.legPredicate(c);
    if (!pred) { rej(tag, 'unmodelled market'); continue; }
    const pModel = M.probWhere(fit.rates, pred);
    const pMarket = M.marketProb(c);
    if (pMarket == null) { rej(tag, 'no market probability'); continue; }
    const gap = Math.abs(pModel - pMarket);
    if (gap > cfg.COHERENCE_TOL) { rej(tag, `incoherent (model ${pModel.toFixed(2)} vs market ${pMarket.toFixed(2)})`); continue; }
    const p = Math.min(pModel, pMarket);
    const tier = cfg.TIER[c.type];
    if (c.type === 'win' && p < cfg.MIN_WIN_PROB) { rej(tag, 'straight win below MIN_WIN_PROB'); continue; }
    if (c.type === 'over') {
      if (p < cfg.OVER_MIN_PROB) { rej(tag, `over prob ${p.toFixed(2)}<OVER_MIN_PROB`); continue; }
    } else if (tier >= 2 && p < cfg.MIN_FALLBACK_PROB) { rej(tag, `fallback prob ${p.toFixed(2)}<MIN_FALLBACK_PROB`); continue; }
    legs.push({
      id: ev.eventId, eventId: ev.eventId, ko: ev.ko, sport: 'football',
      home: ev.homeTeamName, away: ev.awayTeamName, league: ev.league || '',
      marketId: c.marketId, specifier: c.specifier, outcomeId: c.outcomeId,
      odds: c.odds, type: c.type, line: c.line, tier, family: cfg.FAMILY[c.type],
      desc: describe(c), prob: Number(p.toFixed(4)), probModel: Number(pModel.toFixed(4)), probMarket: Number(pMarket.toFixed(4)),
      coherenceGap: Number(gap.toFixed(4)), fitRmse: Number(fit.rmse.toFixed(4)),
      lamH: Number(fit.rates.lamH.toFixed(2)), lamA: Number(fit.rates.lamA.toFixed(2)),
      score: Number((p - 0.5 * gap).toFixed(4))
    });
  }
  // Handicap-first within the event, then safest.
  legs.sort((a, b) => a.tier - b.tier || b.score - a.score || a.odds - b.odds);
  return { legs, rejects };
}

// ── slip building (pure) ───────────────────────────────────
const teamsOf = l => [String(l.home).toLowerCase(), String(l.away).toLowerCase()];

// events: [{ legs:[...ranked] }] -> one best-eligible leg per match for this tier, tier-first, then score.
// Odds earned per unit of risk: ln(odds) / -ln(prob). Higher = more payout for the same chance of losing.
const valueRatio = l => Math.log(l.odds) / Math.max(1e-9, -Math.log(Math.min(0.9999, l.prob)));

function poolFor(perEvent, tierCfg, cfg) {
  const ceiling = tierCfg.maxLegOdds || cfg.MAX_ODDS;
  const target = !!tierCfg.targetOdds;
  const pool = [];
  for (const legs of perEvent) {
    const ok = legs.filter(x => tierCfg.families.includes(x.family) && x.prob >= tierCfg.minLegProb && x.odds <= ceiling);
    if (!ok.length) continue;
    // Fixed-size tiers take the safest leg of the match; target-odds tiers take the best odds-per-risk leg.
    pool.push(target ? ok.reduce((b, x) => (valueRatio(x) > valueRatio(b) ? x : b)) : ok[0]);
  }
  if (target) pool.sort((a, b) => valueRatio(b) - valueRatio(a) || b.score - a.score);
  else pool.sort((a, b) => a.tier - b.tier || b.score - a.score || a.odds - b.odds);
  return pool;
}

function pick(pool, n, cfg, stopAtOdds, leagueCap) {
  const picked = [], teams = new Set(), perLeague = {};
  const cap = leagueCap || cfg.LEAGUE_CAP;
  const maxLegs = Math.min(n || cfg.MAX_LEGS, cfg.MAX_LEGS);
  let odds = 1;
  for (const l of pool) {
    if (picked.length >= maxLegs) break;
    if (stopAtOdds && odds >= stopAtOdds) break;
    if ((perLeague[l.league] || 0) >= cap) continue;
    const t = teamsOf(l);
    if (t.some(x => teams.has(x))) continue;
    picked.push(l); t.forEach(x => teams.add(x));
    perLeague[l.league] = (perLeague[l.league] || 0) + 1;
    odds *= l.odds;
  }
  return picked;
}

const summarize = picked => ({
  legs: picked,
  totalOdds: Number(picked.reduce((a, l) => a * l.odds, 1).toFixed(2)),
  jointProb: Number(picked.reduce((a, l) => a * l.prob, 1).toFixed(4))
});

function buildTierSlip(name, perEvent, cfg = FOOTBALL) {
  const t = cfg.TIERS[name];
  const pool = poolFor(perEvent, t, cfg);
  if (t.targetOdds) {
    const picked = pick(pool, 0, cfg, t.targetOdds, t.leagueCap);
    const s = summarize(picked);
    if (!picked.length || s.totalOdds < t.targetOdds) {
      return { tier: name, ok: false, reason: 'no safe slip', ...s, reasons: [`only reached @${s.totalOdds} of @${t.targetOdds} with ${picked.length} legs (max ${cfg.MAX_LEGS})`], poolSize: pool.length };
    }
    return { tier: name, ok: true, highRisk: !!t.highRisk, ...s, poolSize: pool.length };
  }
  const picked = pick(pool, t.legs, cfg, 0, t.leagueCap);
  const s = summarize(picked);
  if (picked.length < t.legs) {
    return { tier: name, ok: false, reason: 'no safe slip', ...s, reasons: [`only ${picked.length}/${t.legs} legs passed the filters`], poolSize: pool.length };
  }
  if (s.jointProb < t.minJoint) {
    return { tier: name, ok: false, reason: 'no safe slip', ...s, reasons: [`joint probability ${s.jointProb.toFixed(3)} < ${t.minJoint}`], poolSize: pool.length };
  }
  return { tier: name, ok: true, ...s, poolSize: pool.length };
}

// events: [{ev, league, ko}] with ev.markets. Returns { slips: {rookie,hustler,high_roller,legend}, considered, rejects }.
function selectFootball(events, cfg = FOOTBALL) {
  const perEvent = [], rejects = [];
  for (const e of events) {
    const r = evaluateEvent(e, cfg);
    rejects.push(...r.rejects);
    if (r.legs.length) perEvent.push(r.legs);
  }
  const slips = {};
  for (const name of Object.keys(cfg.TIERS)) slips[name] = buildTierSlip(name, perEvent, cfg);
  return { slips, perEvent, considered: perEvent.length, eventsScanned: events.length, rejects };
}

// ── odds refresh right before minting ──────────────────────
// fetchEvent(eventId) -> event object with markets (or null). Returns { legs, dropped }.
// `cache` (Map eventId -> event|null) can be shared across tiers; unseen events are fetched BATCH at a time.
async function refreshLegs(legs, fetchEvent, cfg = FOOTBALL, cache = new Map(), BATCH = 8) {
  const kept = [], dropped = [];
  const need = [...new Set(legs.map(l => l.eventId))].filter(id => !cache.has(id));
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    const got = await Promise.all(chunk.map(id => Promise.resolve(fetchEvent(id)).catch(() => null)));
    chunk.forEach((id, k) => cache.set(id, got[k] || null));
  }
  for (const l of legs) {
    const ev = cache.get(l.eventId);
    const m = ev && (ev.markets || []).find(x => String(x.id) === l.marketId && (x.specifier || '') === l.specifier && x.status === 0);
    const o = m && (m.outcomes || []).find(x => String(x.id) === l.outcomeId && isOn(x));
    const now = o ? parseFloat(o.odds) : NaN;
    if (!(now > 1)) { dropped.push({ ...l, reason: 'market closed/suspended' }); continue; }
    if (Math.abs(now - l.odds) / l.odds > cfg.MAX_MOVE) { dropped.push({ ...l, reason: `odds moved ${l.odds}->${now}` }); continue; }
    kept.push({ ...l, odds: now });
  }
  return { legs: kept, dropped };
}

module.exports = { selectFootball, evaluateEvent, buildTierSlip, fitEvent, candidatesOf, refreshLegs, modelProbs };
