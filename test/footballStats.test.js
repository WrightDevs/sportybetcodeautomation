'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matchLeague, normalizeTeamName, matchTeamInStandings } = require('../src/stats/teamMatcher');
const { extractForm, analyzeLegStats } = require('../src/stats/analyzer');
const { sanitizeVerdicts, verifyLegsWithAi } = require('../src/stats/aiVerifier');

test('matchLeague resolves top 5 European leagues from SportyBet names and aliases', () => {
  assert.strictEqual(matchLeague('Premier League'), 4160026622);
  assert.strictEqual(matchLeague('England - Premier League'), 4160026622);
  assert.strictEqual(matchLeague('LaLiga'), 4212821298);
  assert.strictEqual(matchLeague('Spain - Primera Division'), 4212821298);
  assert.strictEqual(matchLeague('Serie A'), 3405541143);
  assert.strictEqual(matchLeague('Bundesliga'), 686337048);
  assert.strictEqual(matchLeague('Ligue 1'), 3614399544);
  assert.strictEqual(matchLeague('Brazil - Serie A'), null); // outside top-5
  assert.strictEqual(matchLeague('UEFA Champions League'), null);
});

test('normalizeTeamName strips prefixes, suffixes, and punctuation', () => {
  assert.strictEqual(normalizeTeamName('Manchester City FC'), 'manchester city');
  assert.strictEqual(normalizeTeamName('AFC Bournemouth'), 'bournemouth');
  assert.strictEqual(normalizeTeamName('Real Madrid CF'), 'real madrid');
  assert.strictEqual(normalizeTeamName('Paris Saint-Germain'), 'paris saint germain');
});

test('matchTeamInStandings matches teams by name, short_name, or aliases', () => {
  const table = [
    { position: 1, team: { id: 101, name: 'Manchester City', short_name: 'MCI' } },
    { position: 2, team: { id: 102, name: 'Arsenal', short_name: 'ARS' } },
    { position: 3, team: { id: 103, name: 'Paris Saint-Germain', short_name: 'PSG' } },
    { position: 15, team: { id: 104, name: 'Nottingham Forest', short_name: 'NFO' } }
  ];

  const city = matchTeamInStandings('Man City', table);
  assert.ok(city);
  assert.strictEqual(city.position, 1);
  assert.strictEqual(city.team.id, 101);

  const psg = matchTeamInStandings('PSG', table);
  assert.ok(psg);
  assert.strictEqual(psg.position, 3);

  const forest = matchTeamInStandings('Nottm Forest', table);
  assert.ok(forest);
  assert.strictEqual(forest.position, 15);

  const unknown = matchTeamInStandings('FC Barcelona', table);
  assert.strictEqual(unknown, null);
});

test('extractForm computes correct points, clean sheets, and goal averages', () => {
  const fixtures = [
    { status: 'finished', teams: { home: { id: 10 }, away: { id: 20 } }, goals: { home: 2, away: 0 } }, // W, CS
    { status: 'finished', teams: { home: { id: 30 }, away: { id: 10 } }, goals: { home: 1, away: 1 } }, // D
    { status: 'finished', teams: { home: { id: 10 }, away: { id: 40 } }, goals: { home: 0, away: 1 } }, // L, FTS
    { status: 'finished', teams: { home: { id: 50 }, away: { id: 10 } }, goals: { home: 0, away: 3 } }, // W, CS
    { status: 'finished', teams: { home: { id: 10 }, away: { id: 60 } }, goals: { home: 1, away: 0 } }  // W, CS
  ];

  const form = extractForm(fixtures, 10, 5);
  assert.strictEqual(form.sampleSize, 5);
  assert.strictEqual(form.formStr, 'W-D-L-W-W');
  assert.strictEqual(form.points, 10); // 3+1+0+3+3 = 10
  assert.strictEqual(form.cleanSheets, 0.6); // 3 out of 5
  assert.strictEqual(form.failedToScore, 0.2); // 1 out of 5
  assert.strictEqual(form.avgGoals, 1.4); // (2+1+0+3+1)/5 = 7/5 = 1.4
  assert.strictEqual(form.avgConceded, 0.4); // (0+1+1+0+0)/5 = 2/5 = 0.4
});

test('sanitizeVerdicts filters unknown legs and validates actions', () => {
  const legs = [{ eventId: 'e1' }, { eventId: 'e2' }];
  const raw = [
    { legId: 'e1', verdict: 'drop', reason: 'poor away form', confidence: 0.9 },
    { legId: 'e2', verdict: 'keep', reason: 'solid defense', confidence: 0.95 },
    { legId: 'e999', verdict: 'drop', reason: 'unknown match' }
  ];

  const sanitized = sanitizeVerdicts(raw, legs);
  assert.strictEqual(sanitized.length, 2);
  assert.strictEqual(sanitized[0].legId, 'e1');
  assert.strictEqual(sanitized[0].verdict, 'drop');
  assert.strictEqual(sanitized[1].legId, 'e2');
  assert.strictEqual(sanitized[1].verdict, 'keep');
});

test('verifyLegsWithAi automatically drops STAT_CONTRADICTION legs even without LLM key', async () => {
  const legs = [
    {
      eventId: 'leg1',
      home: 'Arsenal',
      away: 'Southampton',
      odds: 1.15,
      stats: { hasStats: true, alignment: 'STRONG_SUPPORT', summary: 'Top vs bottom' }
    },
    {
      eventId: 'leg2',
      home: 'Southampton',
      away: 'Arsenal',
      odds: 1.20,
      stats: { hasStats: true, alignment: 'STAT_CONTRADICTION', summary: 'Underdog selected' }
    }
  ];

  const verdicts = await verifyLegsWithAi(legs);
  assert.strictEqual(verdicts.length, 2);
  assert.strictEqual(verdicts[0].verdict, 'keep');
  assert.strictEqual(verdicts[1].verdict, 'drop');
  assert.match(verdicts[1].reason, /statistical contradiction/i);
});

test('footballApi caching preserves entries within TTL and clears on request', () => {
  const { setCache, getCached, clearCache } = require('../src/stats/footballApi');
  clearCache();

  setCache('test_key', { data: 'test_value' });
  const hit = getCached('test_key');
  assert.ok(hit);
  assert.strictEqual(hit.data, 'test_value');

  const miss = getCached('non_existent_key');
  assert.strictEqual(miss, null);

  clearCache();
  const cleared = getCached('test_key');
  assert.strictEqual(cleared, null);
});

test('analyzeLegStats accurately evaluates table rankings and form alignment', async () => {
  const { setCache } = require('../src/stats/footballApi');
  const mockTable = [
    {
      position: 1,
      played: 20,
      points: 50,
      goal_difference: 30,
      team: { id: 101, name: 'Manchester City' }
    },
    {
      position: 18,
      played: 20,
      points: 12,
      goal_difference: -25,
      team: { id: 102, name: 'Southampton' }
    }
  ];

  const standingsUrl = 'req:https://api.5dollarfootballapi.com/v1/standings?league=4160026622';
  setCache(standingsUrl, { table: mockTable });

  // 1. Man City (1st) vs Southampton (18th) - Home Win / 1X
  const strongLeg = {
    eventId: 'm1',
    home: 'Man City',
    away: 'Southampton',
    league: 'Premier League',
    marketId: '10',
    outcomeId: '9',
    type: 'dc',
    desc: '1X',
    odds: 1.08
  };

  const res1 = await analyzeLegStats(strongLeg);
  assert.strictEqual(res1.hasStats, true);
  assert.strictEqual(res1.alignment, 'STRONG_SUPPORT');
  assert.strictEqual(res1.home.rank, 1);
  assert.strictEqual(res1.away.rank, 18);
  assert.ok(res1.confidenceScore >= 90);

  // 2. Southampton (18th) vs Man City (1st) - Home Win / 1X (Statistical Contradiction)
  const contradictedLeg = {
    eventId: 'm2',
    home: 'Southampton',
    away: 'Man City',
    league: 'Premier League',
    marketId: '1',
    outcomeId: '1',
    type: '1x2',
    desc: '1',
    odds: 9.5
  };

  const res2 = await analyzeLegStats(contradictedLeg);
  assert.strictEqual(res2.hasStats, true);
  assert.strictEqual(res2.alignment, 'STAT_CONTRADICTION');
  assert.ok(res2.confidenceScore <= 50);

  // 3. Unmatched league returns hasStats: false
  const unkLeagueLeg = {
    eventId: 'm3',
    home: 'Tokyo FC',
    away: 'Yokohama',
    league: 'Japan J-League',
    marketId: '10',
    outcomeId: '9',
    type: 'dc',
    desc: '1X',
    odds: 1.15
  };

  const res3 = await analyzeLegStats(unkLeagueLeg);
  assert.strictEqual(res3.hasStats, false);
  assert.match(res3.reason, /not in stats database/i);
});
