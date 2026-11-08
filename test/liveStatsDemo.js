'use strict';
/**
 * Live Stats and AI Verdict Verification Script
 * Fetches actual live data from 5DollarFootballAPI, evaluates candidate legs,
 * runs the AI verification audit, and logs the complete reasoning.
 */

const { getStandings, getTeamFixtures, clearCache } = require('../src/stats/footballApi');
const { matchTeamInStandings } = require('../src/stats/teamMatcher');
const { analyzeLegStats } = require('../src/stats/analyzer');
const { verifyLegsWithAi } = require('../src/stats/aiVerifier');

async function runLiveVerification() {
  // Clear any leftover test cache so we hit 5DollarFootballAPI live
  clearCache();

  console.log('='.repeat(70));
  console.log(' 5DollarFootballAPI & AI Risk Audit — Live Verification Test');
  console.log('='.repeat(70));

  // 1. Fetch real Premier League standings from 5DollarFootballAPI
  console.log('\n[1/4] Querying live Premier League standings from 5DollarFootballAPI...');
  const eplLeagueId = 4160026622;
  const standingsRes = await getStandings(eplLeagueId);

  if (!standingsRes.ok || !standingsRes.data?.table) {
    console.error('Failed to fetch live standings:', standingsRes.error);
    return;
  }

  const table = standingsRes.data.table;
  console.log(`  Live Standings Received: ${table.length} teams found.`);
  console.log('  Top 5 Teams:');
  table.slice(0, 5).forEach(e => {
    console.log(`    #${e.position} ${e.team.name} (Pts: ${e.points}, Played: ${e.played}, GD: ${e.goal_difference})`);
  });

  // 2. Fetch real team fixtures for a specific team (e.g. Manchester City or Arsenal)
  const topTeam = table[0];
  console.log(`\n[2/4] Querying live past fixtures for #${topTeam.position} ${topTeam.team.name} (ID: ${topTeam.team.id})...`);
  const fixRes = await getTeamFixtures(topTeam.team.id);

  if (fixRes.ok && Array.isArray(fixRes.data)) {
    const finished = fixRes.data.filter(f => f.status === 'finished').slice(0, 5);
    console.log(`  Fetched ${finished.length} recent finished fixtures:`);
    finished.forEach(f => {
      console.log(`    ${f.teams.home.name} ${f.goals.home} - ${f.goals.away} ${f.teams.away.name} (${f.date || 'FT'})`);
    });
  }

  // 3. Define candidate games to test various statistical scenarios
  console.log('\n[3/4] Evaluating candidate legs with live statistical engine...');
  const candidateLegs = [
    {
      eventId: 'leg_01',
      home: 'Arsenal',
      away: 'Sunderland',
      league: 'Premier League',
      desc: '1X (Arsenal or Draw)',
      type: 'dc',
      marketId: '10',
      outcomeId: '9',
      odds: 1.06,
      prob: 0.94
    },
    {
      eventId: 'leg_02',
      home: 'Manchester City',
      away: 'Nottingham Forest',
      league: 'Premier League',
      desc: 'Under 4.5 Goals',
      type: 'under',
      marketId: '18',
      outcomeId: '13',
      specifier: 'total=4.5',
      odds: 1.18,
      prob: 0.85
    },
    {
      eventId: 'leg_03',
      home: 'Sunderland',
      away: 'Arsenal',
      league: 'Premier League',
      desc: 'Home Win (Sunderland)',
      type: '1x2',
      marketId: '1',
      outcomeId: '1',
      odds: 9.50,
      prob: 0.10
    }
  ];

  const enrichedLegs = [];
  for (const leg of candidateLegs) {
    const stats = await analyzeLegStats(leg);
    enrichedLegs.push({ ...leg, stats });
  }

  // Display statistical breakdown
  enrichedLegs.forEach((l, idx) => {
    console.log(`\n  Candidate Leg #${idx + 1}: ${l.home} vs ${l.away} | ${l.desc} @${l.odds}`);
    if (l.stats.hasStats) {
      console.log(`    Home: ${l.stats.home.name} (#${l.stats.home.rank}, ${l.stats.home.ppg} PPG, Form: ${l.stats.home.form})`);
      console.log(`    Away: ${l.stats.away.name} (#${l.stats.away.rank}, ${l.stats.away.ppg} PPG, Form: ${l.stats.away.form})`);
      console.log(`    Alignment: ${l.stats.alignment} (Confidence: ${l.stats.confidenceScore}/100)`);
      console.log(`    Engine Reasoning: ${l.stats.summary}`);
    } else {
      console.log(`    Stats not available: ${l.stats.reason}`);
    }
  });

  // 4. Pass through AI risk audit layer
  console.log('\n[4/4] Passing enriched matches through AI Risk Auditor...');
  const verdicts = await verifyLegsWithAi(enrichedLegs);

  console.log('\n' + '='.repeat(70));
  console.log(' FINAL AUDIT VERDICTS & SELECTION DECISION');
  console.log('='.repeat(70));

  verdicts.forEach((v, idx) => {
    const leg = enrichedLegs.find(l => String(l.eventId) === String(v.legId));
    const statusIcon = v.verdict === 'keep' ? 'APPROVED' : 'REJECTED';
    console.log(`\nLeg [${v.legId}]: ${leg ? `${leg.home} vs ${leg.away} (${leg.desc} @${leg.odds})` : v.legId}`);
    console.log(`  Decision: [${statusIcon}] (Confidence: ${Math.round(v.confidence * 100)}%)`);
    console.log(`  Audit Reasoning: ${v.reason}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log(' Test Complete.');
  console.log('='.repeat(70));
}

runLiveVerification().catch(console.error);
