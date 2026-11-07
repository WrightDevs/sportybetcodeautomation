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
  const r = F.buildTierSlip('banker', few);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no safe slip');

  const enough = [0, 1, 2, 3].map(i => [leg(i, 0.93, 1.04)]);
  const ok = F.buildTierSlip('banker', enough);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.legs.length, 4);
  assert.ok(Math.abs(ok.jointProb - 0.93 ** 4) < 1e-3);
});

test('joint bar is never lowered', () => {
  const weak = [0, 1, 2, 3].map(i => [leg(i, 0.90, 1.05)]); // 0.656 passes 0.60
  assert.strictEqual(F.buildTierSlip('banker', weak).ok, true);
  const cfg = { ...FOOTBALL, TIERS: { ...FOOTBALL.TIERS, banker: { ...FOOTBALL.TIERS.banker, minJoint: 0.9 } } };
  assert.strictEqual(F.buildTierSlip('banker', weak, cfg).ok, false);
});

test('no shared teams and league cap respected', () => {
  const pe = [
    [leg(1, 0.95, 1.04, { home: 'X', away: 'Y' })],
    [leg(2, 0.94, 1.04, { home: 'X', away: 'Z' })], // shares X
    [leg(3, 0.93, 1.04, { league: 'Same' })], [leg(4, 0.92, 1.04, { league: 'Same' })], [leg(5, 0.91, 1.04, { league: 'Same' })],
    [leg(6, 0.90, 1.04)]
  ];
  const r = F.buildTierSlip('banker', pe);
  assert.strictEqual(r.ok, true);
  const names = r.legs.map(l => l.eventId);
  assert.ok(!(names.includes('e1') && names.includes('e2')));
  assert.ok(r.legs.filter(l => l.league === 'Same').length <= FOOTBALL.LEAGUE_CAP);
});

test('banker takes handicap family only; safe may use fallbacks', () => {
  const pe = [0, 1, 2, 3].map(i => [leg(i, 0.95, 1.04, { family: 'under', tier: 3, type: 'under' })]);
  assert.strictEqual(F.buildTierSlip('banker', pe).ok, false);
});

test('long tier reaches target odds and is flagged high risk', () => {
  const pe = Array.from({ length: 40 }, (_, i) => [leg(i, 0.86, 1.1, { league: 'L' + i })]);
  const r = F.buildTierSlip('long', pe);
  assert.strictEqual(r.ok, true);
  assert.ok(r.highRisk);
  assert.ok(r.totalOdds >= FOOTBALL.TIERS.long.targetOdds);
  assert.ok(r.jointProb < 0.5);
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
