'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:1/test';
const M = require('../src/selection/model');
const { SELECTION } = require('../src/selection/config');
const S = require('../src/selection/safeSelector');
const { vetoLegs, sanitize } = require('../src/selection/veto');
const R = require('../src/selection/report');
const { evaluateLeg } = require('../src/tracker');
const Q = require('../src/quest-special');

// ── helpers: synthetic markets priced from a Poisson rate with a 5% margin ──
const price = p => Number((1 / Math.min(0.995, p * 1.05)).toFixed(2));
function ladder(id, lam, total, lines) {
  return lines.map(L => {
    const pU = M.poissonCdf(lam, Math.floor(L - total));
    return { id, status: 0, specifier: `total=${L}`, outcomes: [
      { id: '12', odds: price(1 - pU), isActive: 1 }, { id: '13', odds: price(pU), isActive: 1 }] };
  });
}
function mkEv(id, home, away, { h = 0, a = 0, lam = 0.16, lamH = 0.1, lamA = 0.06, ht = false } = {}) {
  const total = h + a;
  const markets = [
    ...ladder(ht ? '68' : '18', lam, total, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5].filter(x => x > total)),
    ...ladder('19', lamH, h, [0.5, 1.5, 2.5, 3.5]),
    ...ladder('20', lamA, a, [0.5, 1.5, 2.5, 3.5])
  ];
  return { eventId: id, homeTeamName: home, awayTeamName: away, league: 'Virtual', markets };
}
const item = (ev, minute, score, stage = 'FT') => ({ ev, minute, score, stage });
const underOnly = (ev, min, sc, stage) => Q.checkUnderCandidates(ev, min, sc, stage === 'HT');
const deps = { getMarkets: Q.getMarkets, generateCandidates: underOnly };
const U = { ...SELECTION, MIN_FALLBACK_PROB: 0.78 }; // mechanics tests use Under legs

// ── de-vig ──
test('devig normalises to 1 and removes margin', () => {
  const p = M.devig([{ odds: 1.5 }, { odds: 2.8 }]);
  assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-9);
  assert.ok(p[0] < 1 / 1.5);
  assert.deepEqual(M.devig([{ odds: 0 }]), [0]);
  // Double Chance outcomes overlap: de-vig to 2, not 1 (real sample 9.50 / 1.02 / 1.01)
  const dc = M.devig([{ odds: 9.5 }, { odds: 1.02 }, { odds: 1.01 }], 2);
  assert.ok(Math.abs(dc.reduce((a, b) => a + b, 0) - 2) < 1e-9);
  assert.ok(dc[1] > 0.9 && dc[2] > 0.9);
});

// ── time-window scaling ──
test('time window: MARKET_WINDOW HT 40 / FT 80, scale = END/W', () => {
  assert.equal(SELECTION.MARKET_WINDOW.HT, 40);
  assert.equal(SELECTION.MARKET_WINDOW.FT, 80);
  assert.ok(Math.abs(M.timeScale('HT') - 45 / 40) < 1e-9);
  assert.ok(Math.abs(M.timeScale('FT') - 90 / 80) < 1e-9);
  assert.equal(M.timeScale('FT', { ...SELECTION, TIME_SCALING: false }), 1);
  assert.equal(M.remainingMinutes('FT', 80), 10);
  assert.equal(M.remainingMinutes('HT', 50), 0);
});
test('firing windows open at MARKET_WINDOW (HT 40-43, FT 80-86)', () => {
  assert.equal(Q.stageOf({ matchStatus: 'H1' }, 40).stage, 'HT');
  assert.equal(Q.stageOf({ matchStatus: 'H1' }, 39.9).stage, null);
  assert.equal(Q.stageOf({ matchStatus: 'H1' }, 43.5).stage, null);
  assert.equal(Q.stageOf({ matchStatus: 'H2' }, 79.9).stage, null);
  assert.equal(Q.stageOf({ matchStatus: 'H2' }, 80).stage, 'FT');
  assert.equal(Q.stageOf({ matchStatus: 'H2' }, 86.5).stage, null);
  assert.equal(Q.stageOf({ matchStatus: 'H2' }, 60).stage, null);
});

// ── rate fitting recovers the generating rate (before time scaling) ──
test('fitRate recovers lambda from a de-vigged ladder', () => {
  const ev = mkEv('e', 'A', 'B', { lam: 0.35 });
  const lines = M.ladderOf(Q.getMarkets(ev, '18'));
  const fit = M.fitRate(lines, 0);
  assert.ok(Math.abs(fit.lambda - 0.35) < 0.06, `fit ${fit.lambda}`);
});

// ── leg predicates use the REAL ids (NG = 76, DC 9/10/11, hcp 1711/1713) ──
test('leg predicates / ids', () => {
  assert.equal(M.legPredicate({ marketId: '29', outcomeId: '76' })(2, 0), true);
  assert.equal(M.legPredicate({ marketId: '29', outcomeId: '76' })(1, 1), false);
  assert.equal(M.legPredicate({ marketId: '29', outcomeId: '30' }), null);
  assert.equal(M.legPredicate({ marketId: '10', outcomeId: '9' })(1, 1), true);
  assert.equal(M.legPredicate({ marketId: '14', outcomeId: '1713', specifier: 'hcp=0:2' })(0, 1), true);
  assert.equal(M.legPredicate({ marketId: '14', outcomeId: '1713', specifier: 'hcp=0:2' })(3, 0), false);
  assert.equal(M.legPredicate({ marketId: '18', outcomeId: '13', specifier: 'total=2.5' })(1, 1), true);
});

// ── hard filters ──
test('filter: accepts a safe Under with coherent model/market', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0 });
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, deps, U);
  assert.equal(sel.ok, true, JSON.stringify(sel.rejects));
  assert.ok(sel.legs[0].prob >= SELECTION.MIN_LEG_PROB);
  assert.ok(sel.legs[0].odds >= SELECTION.MIN_LEG_ODDS);
});
test('filter: MIN_LEG_ODDS rejects sub-1.10 legs', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0 });
  const mk = Q.getMarkets(ev, '18')[0];
  const rates = M.eventRates({ stage: 'FT', minute: 80, score: { h: 1, a: 0 }, getMarkets: id => Q.getMarkets(ev, id) });
  const r = S.evaluateCandidate({ marketId: '18', specifier: 'total=1.5', outcomeId: '13', odds: 1.05, market: mk }, { ev, rates, stage: 'FT', minute: 80, score: { h: 1, a: 0 }, isVirtual: true }, SELECTION);
  assert.match(r.rejected, /MIN_LEG_ODDS/);
});
test('filter: MIN_LEG_PROB rejects risky legs', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0, lam: 0.9 });
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, deps, { ...SELECTION, MAX_LEG_ODDS: 99 });
  assert.equal(sel.ok, false);
  assert.ok(sel.rejects.some(r => /MIN_LEG_PROB|prob/.test(r.reason)));
});
test('filter: MAX_LEG_ODDS rejects long prices', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0, lam: 0.16 });
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, deps, { ...SELECTION, MAX_LEG_ODDS: 1.0 });
  assert.ok(sel.rejects.some(r => /MAX_LEG_ODDS/.test(r.reason)));
});
test('filter: coherence flag rejects model/market disagreement', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0, lam: 0.16 });
  // Make the Under 2.5 price disagree strongly with the rest of the ladder
  const m = Q.getMarkets(ev, '18').find(x => x.specifier === 'total=2.5');
  m.outcomes.find(o => o.id === '13').odds = 1.12; m.outcomes.find(o => o.id === '12').odds = 12;
  const gen = (e, mn, sc, st) => Q.checkUnderCandidates(e, mn, sc, st === 'HT').filter(c => c.specifier === 'total=2.5');
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, { getMarkets: Q.getMarkets, generateCandidates: gen }, { ...SELECTION, COHERENCE_TOL: 0.01 });
  assert.equal(sel.ok, false);
  assert.ok(sel.rejects.some(r => /incoherent/.test(r.reason)));
});
test('filter: junk league rejected for non-virtual sports', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0, lam: 0.16 }); ev.league = 'Club Friendlies';
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1, isVirtual: false }, deps);
  assert.ok(sel.rejects.some(r => /junk league/.test(r.reason)));
});
test('filter: event without a live total ladder is rejected (never guess a rate)', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0 }); ev.markets = [];
  const sel = S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, deps);
  assert.equal(sel.ok, false);
  assert.ok(sel.rejects.some(r => /no live total ladder/.test(r.reason)));
});
test('filter: suspended markets are ignored', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 1, a: 0, lam: 0.16 });
  ev.markets.forEach(m => { m.status = 2; });
  assert.equal(S.selectSlip([item(ev, 80, { h: 1, a: 0 })], { legs: 1 }, deps).ok, false);
});
test('filter: straight win rejected when Double Chance survives', () => {
  const ev = mkEv('e1', 'A', 'B', { h: 2, a: 0, lam: 0.12, lamH: 0.08, lamA: 0.04 });
  const rates = M.eventRates({ stage: 'FT', minute: 80, score: { h: 2, a: 0 }, getMarkets: id => Q.getMarkets(ev, id) });
  const pW = M.probWhere(rates, (h, a) => h > a), pD = M.probWhere(rates, (h, a) => h === a), pL = M.probWhere(rates, (h, a) => a > h);
  const pDC = M.probWhere(rates, (h, a) => h >= a);
  ev.markets.push({ id: '1', status: 0, specifier: '', outcomes: [{ id: '1', odds: price(pW), isActive: 1 }, { id: '2', odds: price(pD), isActive: 1 }, { id: '3', odds: price(pL), isActive: 1 }] });
  ev.markets.push({ id: '10', status: 0, specifier: '', outcomes: [{ id: '9', odds: price(pDC), isActive: 1 }, { id: '10', odds: price(pW + pL), isActive: 1 }, { id: '11', odds: price(pD + pL), isActive: 1 }] });
  const gen = e => [
    { marketId: '1', specifier: '', outcomeId: '1', odds: price(pW), type: 'match_winner_2lead', market: Q.getMarkets(e, '1')[0] },
    { marketId: '10', specifier: '', outcomeId: '9', odds: price(pDC), type: 'ft_double_chance', market: Q.getMarkets(e, '10')[0] }
  ];
  const cfg = { ...SELECTION, MIN_LEG_ODDS: 1.0, MAX_LEG_ODDS: 99, MIN_WIN_PROB: 0.5 };
  const r = S.rankEventLegs(item(ev, 80, { h: 2, a: 0 }), cfg, { getMarkets: Q.getMarkets, generateCandidates: gen }, true);
  assert.ok(r.legs.some(l => l.type === 'ft_double_chance'), JSON.stringify(r.rejects));
  assert.ok(!r.legs.some(l => l.type === 'match_winner_2lead'));
  assert.ok(r.rejects.some(x => /Double Chance available/.test(x.reason)), JSON.stringify(r.rejects));
  // and below MIN_WIN_PROB a lone straight win is rejected too
  const lone = S.rankEventLegs(item(ev, 80, { h: 2, a: 0 }), { ...cfg, MIN_WIN_PROB: 0.99999 }, { getMarkets: Q.getMarkets, generateCandidates: e => gen(e).slice(0, 1) }, true);
  assert.ok(lone.rejects.some(x => /MIN_WIN_PROB/.test(x.reason)), JSON.stringify(lone));
});

// ── slip construction, no-safe-slip, reserves ──
function safeEvents(n, prefix = 'T') {
  return Array.from({ length: n }, (_, i) =>
    item(mkEv(`ev${i}`, `${prefix}H${i}`, `${prefix}A${i}`, { h: 1, a: 0, lam: 0.14 + i * 0.004, lamH: 0.09, lamA: 0.05 }), 80, { h: 1, a: 0 }));
}
test('slip: builds the requested number of legs, ranked by score, product probability', () => {
  const sel = S.selectSlip(safeEvents(4), { legs: 3 }, deps, { ...U, MIN_SLIP_PROB: 0.3 });
  assert.equal(sel.ok, true, JSON.stringify(sel.reasons));
  assert.equal(sel.legs.length, 3);
  const prod = sel.legs.reduce((a, l) => a * l.prob, 1);
  assert.ok(Math.abs(prod - sel.jointProb) < 1e-3);
  for (let i = 1; i < sel.legs.length; i++) assert.ok(sel.legs[i - 1].score >= sel.legs[i].score);
  assert.ok(sel.reserves.length >= 1);
});
test('slip: one leg per match', () => {
  const evs = safeEvents(2); evs.push(evs[0]);
  const sel = S.selectSlip(evs, { legs: 2 }, deps, { ...SELECTION, MIN_SLIP_PROB: 0.1 });
  assert.equal(new Set(sel.legs.map(l => l.eventId)).size, sel.legs.length);
});
test('slip: correlated legs (shared team) are avoided', () => {
  const a = item(mkEv('a', 'SAME', 'X1', { h: 1, a: 0 }), 80, { h: 1, a: 0 });
  const b = item(mkEv('b', 'SAME', 'X2', { h: 1, a: 0 }), 80, { h: 1, a: 0 });
  const sel = S.selectSlip([a, b], { legs: 2 }, deps, { ...U, MIN_SLIP_PROB: 0.1 });
  assert.equal(sel.ok, false);
  assert.equal(sel.legs.length, 1);
});
test('slip: "no safe slip" when joint probability is below MIN_SLIP_PROB (bar is not lowered)', () => {
  const sel = S.selectSlip(safeEvents(5), { legs: 5 }, deps, { ...U, MIN_SLIP_PROB: 0.999 });
  assert.equal(sel.ok, false);
  assert.equal(sel.reason, 'no safe slip');
  assert.match(sel.reasons[0], /joint probability/);
  assert.equal(sel.totalOdds, undefined);
});
test('slip: "no safe slip" when too few legs pass', () => {
  const sel = S.selectSlip(safeEvents(2), { legs: 5 }, deps);
  assert.equal(sel.ok, false);
  assert.match(sel.reasons[0], /only 2\/5/);
});
test('reserve replacement: dropped leg is replaced from reserves and bar re-checked', () => {
  const cfg = { ...U, MIN_SLIP_PROB: 0.3 };
  const sel = S.selectSlip(safeEvents(4), { legs: 2 }, deps, cfg);
  assert.equal(sel.ok, true);
  const dropId = sel.legs[0].eventId;
  const after = S.applyVeto(sel, [{ legId: dropId, verdict: 'drop', reason: 'test' }], cfg);
  assert.equal(after.ok, true);
  assert.equal(after.legs.length, 2);
  assert.ok(!after.legs.some(l => l.eventId === dropId));
  assert.equal(after.dropped.length, 1);
  // dropping everything leaves no safe slip
  const none = S.applyVeto(sel, [...sel.legs, ...sel.reserves].map(l => ({ legId: l.eventId, verdict: 'drop', reason: 'x' })), cfg);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no safe slip');
});

// ── LLM veto: drop-only, fail-open ──
test('veto: sanitize cannot add unknown legs', () => {
  const out = sanitize([{ legId: 'ghost', verdict: 'keep' }, { legId: 'ev0', verdict: 'drop', reason: 'r' }], [{ eventId: 'ev0' }]);
  assert.deepEqual(out.map(v => v.legId), ['ev0']);
});
test('veto: no LLM key => keep all (skipped)', async () => {
  const legs = [{ eventId: 'a' }, { eventId: 'b' }];
  const v = await vetoLegs(legs);
  assert.ok(v.every(x => x.verdict === 'keep'));
});
test('veto: timeout / failure => keep all', async () => {
  const { CFG } = require('../src/config');
  const prev = [CFG.USE_LLM, CFG.LLM_KEY]; CFG.USE_LLM = true; CFG.LLM_KEY = 'k';
  try {
    const slow = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('abort'))));
    const v = await vetoLegs([{ eventId: 'a' }, { eventId: 'b' }], { fetchImpl: slow, timeoutMs: 30 });
    assert.ok(v.every(x => x.verdict === 'keep'));
  } finally { [CFG.USE_LLM, CFG.LLM_KEY] = prev; }
});

// ── settlement + calibration ──
test('settle: half-time markets settle on gameScore[0], not the final score', () => {
  const leg = { marketId: '68', outcomeId: '13', specifier: 'total=1.5' };
  const r = evaluateLeg(leg, { status: 2, setScore: '4:2', gameScore: ['1:0', '3:2'] });
  assert.equal(r.won, true);
  const r2 = R.settleRow(leg, { status: 2, setScore: '4:2', gameScore: ['1:1', '3:1'] });
  assert.equal(r2.won, false);
  assert.equal(R.settleRow(leg, { status: 1, setScore: '0:0' }), null);
});
test('settle: NG outcome 76 and verbose descriptions settle correctly', () => {
  const ng = evaluateLeg({ marketId: '29', outcomeId: '76', outcomeDesc: 'Full Time Both Teams To Score - NO' }, { status: 2, setScore: '2:0' });
  assert.equal(ng.won, true);
  const un = evaluateLeg({ marketId: '18', outcomeId: '13', specifier: 'total=3.5', outcomeDesc: 'Full Time Under 3.5 (A vs B at 80\')' }, { status: 2, setScore: '2:2' });
  assert.equal(un.won, false);
});
test('calibration report: hit rate per market type, per bucket, Brier', () => {
  const rows = [
    { type: 'ft_under', prob: 0.8, result: { won: true } },
    { type: 'ft_under', prob: 0.8, result: { won: false } },
    { type: 'ft_double_chance', prob: 0.9, result: { won: true } },
    { type: 'ft_double_chance', prob: 0.9, result: null }
  ];
  const rep = R.calibrationReport(rows);
  assert.equal(rep.settled, 3);
  assert.equal(rep.pending, 1);
  assert.ok(Math.abs(rep.brier - ((0.04 + 0.64 + 0.01) / 3)) < 1e-9);
  assert.equal(rep.byMarketType.find(g => g.key === 'ft_under').hitRate, 0.5);
  assert.ok(R.formatReport(rep).includes('Brier'));
});

// ── captured live fixture (real factsCenter output) ──
test('fixture: real live capture yields coherent selections only', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-raw.json'), 'utf8'));
  const evs = raw.data.flatMap(t => t.events.map(e => ({ ...e, league: t.name })));
  const pool = evs.map(ev => {
    const min = Q.minute(ev.playedSeconds), sc = Q.scoreOf(ev);
    return sc && min != null && ev.matchStatus === 'H1' ? { ev, minute: min, score: sc, stage: 'HT' } : null;
  }).filter(Boolean);
  const sel = S.selectSlip(pool, { legs: 1 }, {
    getMarkets: Q.getMarkets,
    generateCandidates: (ev, m, sc, st) => Q.getCandidatesForEvent(ev, m, sc, st === 'HT', st === 'FT', 'any')
  });
  for (const l of sel.legs) {
    assert.ok(l.prob >= SELECTION.MIN_LEG_PROB && l.coherenceGap <= SELECTION.COHERENCE_TOL);
  }
});

// ── no-stake guarantee ──
test('no-stake: only /orders/share booking is used; no stake/wager fields anywhere in selection code', () => {
  const files = ['quest-special.js', 'selection/safeSelector.js', 'selection/model.js', 'selection/veto.js', 'selection/log.js', 'selection/report.js']
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
  const src = files.join('\n');
  assert.ok(!/(placeBet|place_bet|\bstake\b|wager|betslip\/submit|orders\/place|payment)/i.test(src.replace(/no stake[^\n]*/gi, '')));
  const posts = src.match(/method:\s*'POST'/g) || [];
  assert.ok(posts.length <= 2); // booking POST + LLM chat POST
  assert.ok(/orders\/share/.test(files[0]));
});

// ── handicap-first tiers ──
function hcapCand(ev, p = 0.8) {
  // 3-way handicap market priced so the home outcome de-vigs to exactly p
  const rest = (1 - p) / 2;
  const market = { id: '14', status: 0, specifier: 'hcp=1:0', outcomes: [
    { id: '1711', odds: 1 / p, isActive: 1 }, { id: '1712', odds: 1 / rest, isActive: 1 }, { id: '1713', odds: 1 / rest, isActive: 1 }] };
  return { marketId: '14', specifier: 'hcp=1:0', outcomeId: '1711', odds: Number((1 / p).toFixed(3)), type: 'ft_handicap', market };
}
const tierCfg = { ...SELECTION, COHERENCE_TOL: 1, MIN_LEG_ODDS: 1.0, MAX_LEG_ODDS: 99, MIN_FALLBACK_PROB: 0.78, MIN_SLIP_PROB: 0.1 };
const both = (ev, mn, sc, st) => [...Q.checkUnderCandidates(ev, mn, sc, st === 'HT'), hcapCand(ev)];
const mk = (id, h, a) => item(mkEv(id, `${id}H`, `${id}A`, { h: 1, a: 0 }), 80, { h: 1, a: 0 });

test('tiers: handicap is preferred over a higher-scoring Under; PREFER_HANDICAP=off restores score order', () => {
  const gen = { getMarkets: Q.getMarkets, generateCandidates: both };
  const r = S.rankEventLegs(mk('t1'), tierCfg, gen, true);
  const under = r.legs.find(l => l.family === 'under'), hc = r.legs.find(l => l.family === 'handicap');
  assert.ok(under && hc, JSON.stringify(r.rejects));
  assert.ok(under.score > hc.score, 'precondition: Under outscores the handicap leg');
  assert.equal(r.legs[0].family, 'handicap');
  const off = S.rankEventLegs(mk('t1'), { ...tierCfg, PREFER_HANDICAP: false }, gen, true);
  assert.equal(off.legs[0].family, 'under');
  const sel = S.selectSlip([mk('t1')], { legs: 1 }, gen, tierCfg);
  assert.equal(sel.legs[0].family, 'handicap');
  assert.equal(sel.legs[0].tier, 1);
});
test('tiers: Under is used only when no handicap leg survives', () => {
  const gen = { getMarkets: Q.getMarkets, generateCandidates: underOnly };
  const sel = S.selectSlip([mk('t2')], { legs: 1 }, gen, tierCfg);
  assert.equal(sel.ok, true);
  assert.equal(sel.legs[0].family, 'under');
});
test('tiers: fallback needs MIN_FALLBACK_PROB (0.85) while handicap needs only MIN_LEG_PROB (0.78)', () => {
  const strict = { ...tierCfg, MIN_FALLBACK_PROB: 0.85 };
  const u = S.rankEventLegs(mk('t3'), strict, { getMarkets: Q.getMarkets, generateCandidates: underOnly }, true);
  assert.equal(u.legs.length, 0);
  assert.ok(u.rejects.some(x => /MIN_FALLBACK_PROB/.test(x.reason)));
  const h = S.rankEventLegs(mk('t3'), strict, { getMarkets: Q.getMarkets, generateCandidates: (e) => [hcapCand(e, 0.8)] }, true);
  assert.equal(h.legs.length, 1);
  assert.equal(h.legs[0].family, 'handicap');
});
test('tiers: 5-leg slip fills with handicap first, then fallback; joint bar still applies', () => {
  const evs = ['a', 'b', 'c', 'd', 'e'].map(id => mk('m' + id));
  // first three matches offer a handicap leg too; the last two only Under
  const gen = { getMarkets: Q.getMarkets,
    generateCandidates: (ev, mn, sc, st) => /^m[abc]$/.test(ev.eventId) ? both(ev, mn, sc, st) : underOnly(ev, mn, sc, st) };
  const sel = S.selectSlip(evs, { legs: 5 }, gen, tierCfg);
  assert.equal(sel.ok, true, JSON.stringify(sel.reasons));
  assert.deepEqual(sel.legs.map(l => l.family), ['handicap', 'handicap', 'handicap', 'under', 'under']);
  const tight = S.selectSlip(evs, { legs: 5 }, gen, { ...tierCfg, MIN_SLIP_PROB: 0.99 });
  assert.equal(tight.ok, false);
  assert.equal(tight.reason, 'no safe slip');
});
test('tiers: tier is logged and exposed on legs', () => {
  const sel = S.selectSlip([mk('t5')], { legs: 1 }, { getMarkets: Q.getMarkets, generateCandidates: both }, tierCfg);
  assert.equal(typeof sel.legs[0].tier, 'number');
  assert.equal(sel.legs[0].family, 'handicap');
});
