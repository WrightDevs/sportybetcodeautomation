'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/selection/football');
const M = require('../src/selection/model');
const { FOOTBALL } = require('../src/selection/config');

// ── synthetic match priced from a known Poisson goal model with a ~5% margin ──
const MARGIN = 1.05;
const price = p => Math.max(1.01, Number((1 / (p * MARGIN)).toFixed(2)));
const out = (id, odds) => ({ id: String(id), odds: String(odds), isActive: 1 });

function makeEvent(id, home, away, lamH, lamA, league = 'Premier League') {
  const rates = { lamH, lamA, scoreH: 0, scoreA: 0 };
  const P = pred => M.probWhere(rates, pred);
  const mk = (mid, spec, outs) => ({ id: mid, specifier: spec, status: 0, outcomes: outs });
  const markets = [
    mk('1', '', [out(1, price(P((h, a) => h > a))), out(2, price(P((h, a) => h === a))), out(3, price(P((h, a) => a > h)))]),
    mk('10', '', [out(9, price(P((h, a) => h >= a))), out(10, price(P((h, a) => h !== a))), out(11, price(P((h, a) => a >= h)))]),
    mk('29', '', [out(74, price(P((h, a) => h > 0 && a > 0))), out(76, price(P((h, a) => h === 0 || a === 0)))])
  ];
  for (const L of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    markets.push(mk('18', `total=${L}`, [out(12, price(P((h, a) => h + a > L))), out(13, price(P((h, a) => h + a < L)))]));
  }
  for (const [x, y] of [[1, 0], [2, 0], [0, 1], [0, 2]]) {
    markets.push(mk('14', `hcp=${x}:${y}`, [
      out(1711, price(P((h, a) => h + x > a + y))), out(1712, price(P((h, a) => h + x === a + y))), out(1713, price(P((h, a) => a + y > h + x)))]));
  }
  return { eventId: id, homeTeamName: home, awayTeamName: away, league, ko: Date.now() + 3600e3, markets };
}

test('goal model fit reproduces the pricing model', () => {
  const ev = makeEvent('e1', 'A', 'B', 2.3, 0.6);
  const fit = F.fitEvent(ev);
  assert.ok(fit.rates, fit.reject);
  assert.ok(Math.abs(fit.rates.lamH - 2.3) < 0.25, `lamH ${fit.rates.lamH}`);
  assert.ok(Math.abs(fit.rates.lamA - 0.6) < 0.2, `lamA ${fit.rates.lamA}`);
  assert.ok(fit.rmse < 0.02);
});

test('strong favourite yields a handicap-family leg, never Home-or-Away', () => {
  const ev = makeEvent('e1', 'A', 'B', 1.9, 0.9);
  const { legs } = F.evaluateEvent(ev);
  assert.ok(legs.length > 0);
  assert.ok(legs.every(l => !(l.marketId === '10' && l.outcomeId === '10')), '12 must be excluded');
  assert.ok(legs[0].tier === 1, 'tier 1 first');
  assert.ok(legs[0].prob >= 0.8);
  assert.ok(legs.every(l => l.odds >= FOOTBALL.MIN_ODDS && l.odds <= FOOTBALL.MAX_ODDS));
});

test('only the head-start side of a handicap is a candidate', () => {
  const ev = makeEvent('e1', 'A', 'B', 2.0, 0.8);
  const hc = F.candidatesOf(ev).filter(c => c.type === 'handicap');
  assert.ok(hc.length > 0);
  for (const c of hc) {
    const [x, y] = c.specifier.replace('hcp=', '').split(':').map(Number);
    assert.strictEqual(c.outcomeId, x > y ? '1711' : '1713');
  }
});

test('Under is only offered on high lines', () => {
  const ev = makeEvent('e1', 'A', 'B', 1.2, 0.8);
  const un = F.candidatesOf(ev).filter(c => c.type === 'under');
  assert.ok(un.length > 0 && un.every(c => c.line >= FOOTBALL.MIN_UNDER_LINE));
});

test('junk leagues are excluded', () => {
  const ev = makeEvent('e1', 'A', 'B', 2.6, 0.5, 'Club Friendlies');
  const r = F.evaluateEvent(ev);
  assert.strictEqual(r.legs.length, 0);
  assert.match(r.rejects[0].reason, /junk/);
});

test('leg probability is the lower of model and market; large disagreement is rejected', () => {
  // A DC price much shorter than the 1X2/total imply: de-vig dilutes it, but the model value must win (min).
  const ev = makeEvent('e1', 'A', 'B', 1.9, 0.9);
  const dc = ev.markets.find(m => m.id === '10');
  dc.outcomes.find(o => o.id === '9').odds = '1.06';
  const leg9 = F.evaluateEvent(ev).legs.find(l => l.marketId === '10' && l.outcomeId === '9');
  if (leg9) assert.strictEqual(leg9.prob, Math.min(leg9.probModel, leg9.probMarket));

  // A whole market priced for a different match (all three DC prices swapped to a lopsided game) is incoherent.
  const ev2 = makeEvent('e2', 'A', 'B', 1.9, 0.9);
  const other = makeEvent('x', 'A', 'B', 3.2, 0.3).markets.find(m => m.id === '14' && m.specifier === 'hcp=2:0');
  const h2 = ev2.markets.find(m => m.id === '14' && m.specifier === 'hcp=2:0');
  h2.outcomes = other.outcomes;
  const r = F.evaluateEvent(ev2);
  assert.ok(!r.legs.some(l => l.marketId === '14' && l.specifier === 'hcp=2:0'));
});

test('missing 1X2 or thin ladder rejects the match', () => {
  const ev = makeEvent('e1', 'A', 'B', 2.6, 0.5);
  ev.markets = ev.markets.filter(m => m.id !== '1');
  assert.match(F.evaluateEvent(ev).rejects[0].reason, /1X2/);
  const ev2 = makeEvent('e2', 'A', 'B', 2.6, 0.5);
  ev2.markets = ev2.markets.filter(m => m.id !== '18');
  assert.match(F.evaluateEvent(ev2).rejects[0].reason, /ladder/);
});

const leg = (i, prob, odds, extra = {}) => ({ eventId: `e${i}`, home: `H${i}`, away: `A${i}`, league: `L${i % 9}`,
  marketId: '10', specifier: '', outcomeId: '9', odds, type: 'dc', tier: 1, family: 'handicap', prob, score: prob, ...extra });

test('banker needs enough strong legs and clears joint bar, else no safe slip', () => {
  const few = [0, 1].map(i => [leg(i, 0.93, 1.04)]);
  const r = F.buildTierSlip('rookie', few);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no safe slip');

  const enough = [0, 1, 2, 3].map(i => [leg(i, 0.93, 1.04)]);
  const ok = F.buildTierSlip('rookie', enough);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.legs.length, 4);
  assert.ok(Math.abs(ok.jointProb - 0.93 ** 4) < 1e-3);
});

test('joint bar is never lowered', () => {
  const weak = [0, 1, 2, 3].map(i => [leg(i, 0.90, 1.05)]); // 0.656 passes 0.60
  assert.strictEqual(F.buildTierSlip('rookie', weak).ok, true);
  const cfg = { ...FOOTBALL, TIERS: { ...FOOTBALL.TIERS, rookie: { ...FOOTBALL.TIERS.rookie, minJoint: 0.9 } } };
  assert.strictEqual(F.buildTierSlip('rookie', weak, cfg).ok, false);
});

test('no shared teams and league cap respected', () => {
  const pe = [
    [leg(1, 0.95, 1.04, { home: 'X', away: 'Y' })],
    [leg(2, 0.94, 1.04, { home: 'X', away: 'Z' })], // shares X
    [leg(3, 0.93, 1.04, { league: 'Same' })], [leg(4, 0.92, 1.04, { league: 'Same' })], [leg(5, 0.91, 1.04, { league: 'Same' })],
    [leg(6, 0.90, 1.04)]
  ];
  const r = F.buildTierSlip('rookie', pe);
  assert.strictEqual(r.ok, true);
  const names = r.legs.map(l => l.eventId);
  assert.ok(!(names.includes('e1') && names.includes('e2')));
  assert.ok(r.legs.filter(l => l.league === 'Same').length <= FOOTBALL.LEAGUE_CAP);
});

test('rookie takes handicap family only', () => {
  const pe = [0, 1, 2, 3].map(i => [leg(i, 0.95, 1.04, { family: 'under', tier: 3, type: 'under' })]);
  assert.strictEqual(F.buildTierSlip('rookie', pe).ok, false);
});

test('high_roller tier reaches target odds and is flagged high risk', () => {
  const pe = Array.from({ length: 40 }, (_, i) => [leg(i, 0.86, 1.1, { league: 'L' + i })]);
  const r = F.buildTierSlip('high_roller', pe);
  assert.strictEqual(r.ok, true);
  assert.ok(r.highRisk);
  assert.ok(r.totalOdds >= FOOTBALL.TIERS.high_roller.targetOdds);
  assert.ok(r.jointProb < 0.5);
});

test('tiers are Rookie / Hustler / High Roller / Legend with display names', () => {
  assert.deepStrictEqual(Object.keys(FOOTBALL.TIERS), ['rookie', 'hustler', 'high_roller', 'legend']);
  assert.deepStrictEqual(FOOTBALL.NAMES, { rookie: 'Rookie', hustler: 'Hustler', high_roller: 'High Roller', legend: 'Legend' });
});

test('legend reaches >= 100 odds using at most 50 legs', () => {
  // 60 matches, each with a 1.12 leg at p=0.80 -> 1.12^50 = 289, so the target is hit well inside the cap
  const pe = Array.from({ length: 60 }, (_, i) => [leg(i, 0.80, 1.12, { league: 'L' + i })]);
  const r = F.buildTierSlip('legend', pe);
  assert.strictEqual(r.ok, true);
  assert.ok(r.totalOdds >= 100);
  assert.ok(r.legs.length <= FOOTBALL.MAX_LEGS);
  assert.ok(r.highRisk);
});

test('legend is absent when 50 legs cannot reach the target', () => {
  const pe = Array.from({ length: 80 }, (_, i) => [leg(i, 0.80, 1.05, { league: 'L' + i })]); // 1.05^50 = 11.5
  const r = F.buildTierSlip('legend', pe);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no safe slip');
  assert.ok(r.legs.length <= FOOTBALL.MAX_LEGS);
});

test('no slip ever exceeds MAX_LEGS', () => {
  const cfg = { ...FOOTBALL, MAX_LEGS: 12 };
  const pe = Array.from({ length: 80 }, (_, i) => [leg(i, 0.85, 1.05, { league: 'L' + i })]);
  assert.ok(F.buildTierSlip('legend', pe, cfg).legs.length <= 12);
  assert.ok(F.buildTierSlip('high_roller', pe, cfg).legs.length <= 12);
});

test('target-odds tiers prefer odds-per-risk; legend honours its wider per-leg odds ceiling', () => {
  // A: 1.10 @ p=0.90 (ratio ~0.90) vs B: 1.38 @ p=0.80 (ratio ~1.45): B should be taken first by value
  const a = leg(1, 0.90, 1.10), b = leg(1, 0.80, 1.38);
  const r = F.buildTierSlip('legend', [[a, b]]);
  assert.strictEqual(r.legs[0].odds, 1.38);
  // high_roller ceiling is the global MAX_ODDS (1.30): the 1.38 leg is ineligible there
  const hr = F.buildTierSlip('high_roller', [[b]]);
  assert.strictEqual(hr.legs.length, 0);
});

test('slip text for users carries no probabilities, but the payload keeps jointProb', async () => {
  const sf = require('../src/safe-football');
  const events = Array.from({ length: 70 }, (_, i) => makeEvent(`e${i}`, `Home${i}`, `Away${i}`, 1.9, 0.9, `League ${i}`));
  const r = await sf.generateSafeFootball({}, null, { events, dryRun: true, noRefresh: true });
  assert.ok(r.lines.length > 0);
  assert.ok(r.lines.every(l => !/%|joint|prob/i.test(l)), r.lines.join('\n'));
  for (const c of r.codes) assert.ok(typeof c.jointProb === 'number' && c.tierName);
});

// ── Over legs: only High Roller / Legend, only when stats + AI back them ──
test('Over 0.5 / 1.5 are candidates, other Over lines are not', () => {
  const ev = makeEvent('e1', 'A', 'B', 1.9, 1.3);
  const overs = F.candidatesOf(ev).filter(c => c.type === 'over');
  assert.deepStrictEqual(overs.map(c => c.line).sort(), [0.5, 1.5]);
  assert.ok(overs.every(c => c.marketId === '18' && c.outcomeId === '12'));
});

test('Over legs are priced (not rejected as unmodelled) and use the Over probability bar', () => {
  const ev = makeEvent('e1', 'A', 'B', 2.0, 1.6);
  const { legs } = F.evaluateEvent(ev, { ...FOOTBALL, MAX_ODDS: 1.6 });
  const over = legs.filter(l => l.type === 'over');
  assert.ok(over.length > 0, 'an Over leg should survive');
  assert.ok(over.every(l => l.family === 'over' && l.prob >= FOOTBALL.OVER_MIN_PROB && /^Over /.test(l.desc)));
});

test('Over family is allowed in High Roller and Legend only', () => {
  assert.ok(FOOTBALL.TIERS.high_roller.families.includes('over'));
  assert.ok(FOOTBALL.TIERS.legend.families.includes('over'));
  assert.ok(!FOOTBALL.TIERS.rookie.families.includes('over'));
  assert.ok(!FOOTBALL.TIERS.hustler.families.includes('over'));
  const ov = leg(1, 0.9, 1.1, { type: 'over', family: 'over', line: 1.5 });
  assert.strictEqual(F.buildTierSlip('rookie', [[ov], [ov], [ov], [ov]]).legs.length, 0);
});

test('screenOvers keeps only Overs the stats strongly support; others vanish, other legs stay', async () => {
  const sf = require('../src/safe-football');
  const mkOver = (i, line = 1.5) => leg(i, 0.82, 1.22, { type: 'over', family: 'over', line, desc: `Over ${line}`, marketId: '18', outcomeId: '12', specifier: `total=${line}` });
  const pe = [[mkOver(1), leg(1, 0.9, 1.08)], [mkOver(2)], [mkOver(3)], [leg(4, 0.9, 1.08)]];
  const verdict = { e1: 'STRONG_SUPPORT', e2: 'MODERATE_SUPPORT' }; // e3: no stats at all
  const analyze = async l => verdict[l.eventId] ? { hasStats: true, alignment: verdict[l.eventId], summary: 's' } : { hasStats: false, reason: 'league not covered' };
  const r = await sf.screenOvers(pe, new Map(), { analyze });
  const flat = r.perEvent.flat();
  assert.deepStrictEqual(flat.filter(l => l.type === 'over').map(l => l.eventId), ['e1']);
  assert.ok(flat.some(l => l.eventId === 'e1' && l.type === 'dc'), 'the match keeps its other leg');
  assert.ok(flat.some(l => l.eventId === 'e4'));
  assert.strictEqual(r.perEvent.length, 2); // e2 and e3 had only an Over, so those matches are gone (e1 and e4 remain)
  assert.strictEqual(r.screen.accepted, 1);
});

test('screenOvers: stats disabled or over the check limit means no unverified Over gets through', async () => {
  const sf = require('../src/safe-football');
  const mkOver = i => leg(i, 0.82, 1.22, { type: 'over', family: 'over', line: 1.5, marketId: '18', outcomeId: '12' });
  const pe = Array.from({ length: 12 }, (_, i) => [mkOver(i)]);
  const off = await sf.screenOvers(pe, new Map(), { noStats: true });
  assert.strictEqual(off.perEvent.length, 0);
  let calls = 0;
  const analyze = async () => { calls++; return { hasStats: true, alignment: 'STRONG_SUPPORT', summary: 's' }; };
  const lim = await sf.screenOvers(pe, new Map(), { analyze });
  assert.strictEqual(calls, FOOTBALL.OVER_PRESCREEN);
  assert.strictEqual(lim.perEvent.length, FOOTBALL.OVER_PRESCREEN);
});

test('an Over needs an explicit AI keep: a missing or heuristic verdict drops it, an AI drop drops it', async () => {
  const sf = require('../src/safe-football');
  // Only 1X2 + totals, so the only usable legs are Over legs; distinct leagues so the league cap does not interfere.
  const events = Array.from({ length: 70 }, (_, i) => {
    const e = makeEvent(`e${i}`, `Home${i}`, `Away${i}`, 2.0, 1.6, `League ${i}`);
    return { ...e, markets: e.markets.filter(m => m.id === '1' || m.id === '18') };
  });
  const analyze = async l => ({ hasStats: true, alignment: l.type === 'over' ? 'STRONG_SUPPORT' : 'MODERATE_SUPPORT', summary: 's' });
  const run = verdictFor => sf.generateSafeFootball({}, null, { events, dryRun: true, noRefresh: true, analyze,
    verify: async legs => legs.map(l => ({ legId: String(l.eventId), verdict: verdictFor(l).verdict, source: verdictFor(l).source, reason: 'r' })) });
  const hasOver = r => r.codes.some(c => (c.legs || []).some(l => l.type === 'over'));
  const heuristic = await run(() => ({ verdict: 'keep', source: 'heuristic' }));
  assert.ok(!hasOver(heuristic), 'no Over without an explicit AI keep');
  const dropped = await run(l => ({ verdict: l.type === 'over' ? 'drop' : 'keep', source: 'llm' }));
  assert.ok(!hasOver(dropped), 'AI drop removes Overs');
  const prescreen = FOOTBALL.OVER_PRESCREEN;
  FOOTBALL.OVER_PRESCREEN = 70; // lift the per-run API budget so a slip made only of Overs can reach its target
  let kept;
  try { kept = await run(() => ({ verdict: 'keep', source: 'llm' })); } finally { FOOTBALL.OVER_PRESCREEN = prescreen; }
  assert.ok(hasOver(kept), 'with stats support and an explicit AI keep, Over legs are used');
  assert.ok(kept.codes.every(c => c.tier === 'high_roller' || c.tier === 'legend'), 'Overs appear in no other tier');
});

test('refreshLegs drops moved or closed legs and keeps stable ones', async () => {
  const legs = [leg(1, 0.9, 1.10), leg(2, 0.9, 1.10), leg(3, 0.9, 1.10)];
  const mk = odds => ({ markets: [{ id: 10, specifier: '', status: 0, outcomes: [{ id: '9', odds: String(odds), isActive: 1 }] }] });
  const feed = { e1: mk(1.10), e2: mk(1.20), e3: null };
  const r = await F.refreshLegs(legs, async id => feed[id]);
  assert.deepStrictEqual(r.legs.map(l => l.eventId), ['e1']);
  assert.strictEqual(r.dropped.length, 2);
});

test('tracker no longer settles unknown markets as won', () => {
  const { evaluateLeg } = require('../src/tracker');
  const r = evaluateLeg({ marketId: '999', outcomeId: '1', specifier: '', outcomeDesc: '' }, { status: 2, homeScore: 1, awayScore: 0 });
  assert.strictEqual(r.settled, false);
});
