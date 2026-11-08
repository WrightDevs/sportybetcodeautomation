'use strict';
/**
 * Statistical Match Analyzer
 * Extracts performance indicators from 5DollarFootballAPI and assesses
 * market alignment against verified real-world team data.
 */

const { getStandings, getTeamFixtures } = require('./footballApi');
const { matchLeague, matchTeamInStandings } = require('./teamMatcher');

/**
 * Extract form points from recent finished fixtures (last N games)
 * @param {Array<Object>} fixtures 
 * @param {number|string} teamId 
 * @param {number} count 
 */
function extractForm(fixtures, teamId, count = 5) {
  if (!Array.isArray(fixtures)) return { formStr: 'N/A', points: 0, sampleSize: 0, cleanSheets: 0, failedToScore: 0, avgGoals: 0, avgConceded: 0, under35Rate: 0 };

  const finished = fixtures
    .filter(f => f.status === 'finished' && f.goals)
    .slice(0, count);

  if (finished.length === 0) {
    return { formStr: 'N/A', points: 0, sampleSize: 0, cleanSheets: 0, failedToScore: 0, avgGoals: 0, avgConceded: 0, under35Rate: 0 };
  }

  let points = 0;
  let cleanSheets = 0;
  let failedToScore = 0;
  let totalGoals = 0;
  let totalConceded = 0;
  let under35Count = 0;
  const formChars = [];

  for (const f of finished) {
    const isHome = String(f.teams?.home?.id) === String(teamId);
    const scored = isHome ? (f.goals.home || 0) : (f.goals.away || 0);
    const conceded = isHome ? (f.goals.away || 0) : (f.goals.home || 0);
    const matchGoals = scored + conceded;

    totalGoals += scored;
    totalConceded += conceded;
    if (matchGoals < 3.5) under35Count++;
    if (conceded === 0) cleanSheets++;
    if (scored === 0) failedToScore++;

    if (scored > conceded) {
      points += 3;
      formChars.push('W');
    } else if (scored === conceded) {
      points += 1;
      formChars.push('D');
    } else {
      formChars.push('L');
    }
  }

  const n = finished.length;
  return {
    formStr: formChars.join('-'),
    points,
    sampleSize: n,
    cleanSheets: parseFloat((cleanSheets / n).toFixed(2)),
    failedToScore: parseFloat((failedToScore / n).toFixed(2)),
    avgGoals: parseFloat((totalGoals / n).toFixed(2)),
    avgConceded: parseFloat((totalConceded / n).toFixed(2)),
    under35Rate: parseFloat((under35Count / n).toFixed(2))
  };
}

/**
 * Analyze statistical backing for a candidate betting pick
 * @param {Object} leg - Candidate leg with home, away, league, marketId, outcomeId, specifier, type
 * @returns {Promise<Object>} Analysis profile
 */
async function analyzeLegStats(leg) {
  const leagueId = matchLeague(leg.league);
  if (!leagueId) {
    return { hasStats: false, reason: `League "${leg.league}" not in stats database (Top-5 Europe)` };
  }

  const standingsRes = await getStandings(leagueId);
  if (!standingsRes.ok || !standingsRes.data?.table) {
    return { hasStats: false, reason: standingsRes.error || 'Standings unavailable' };
  }

  const table = standingsRes.data.table;
  const homeEntry = matchTeamInStandings(leg.home, table);
  const awayEntry = matchTeamInStandings(leg.away, table);

  if (!homeEntry || !awayEntry) {
    return {
      hasStats: false,
      reason: `Teams not matched in table: Home=${homeEntry ? 'Found' : 'Not found'}, Away=${awayEntry ? 'Found' : 'Not found'}`
    };
  }

  const homeRank = homeEntry.position;
  const awayRank = awayEntry.position;
  const homePpg = homeEntry.played > 0 ? parseFloat((homeEntry.points / homeEntry.played).toFixed(2)) : 0;
  const awayPpg = awayEntry.played > 0 ? parseFloat((awayEntry.points / awayEntry.played).toFixed(2)) : 0;

  // Retrieve recent team fixtures for in-depth form (cached)
  let homeForm = { formStr: 'N/A' };
  let awayForm = { formStr: 'N/A' };

  if (homeEntry.team?.id) {
    const hfRes = await getTeamFixtures(homeEntry.team.id);
    if (hfRes.ok && Array.isArray(hfRes.data)) {
      homeForm = extractForm(hfRes.data, homeEntry.team.id, 5);
    }
  }

  if (awayEntry.team?.id) {
    const afRes = await getTeamFixtures(awayEntry.team.id);
    if (afRes.ok && Array.isArray(afRes.data)) {
      awayForm = extractForm(afRes.data, awayEntry.team.id, 5);
    }
  }

  // Evaluate market alignment
  let alignment = 'NEUTRAL';
  let confidenceScore = 75;
  const notes = [];

  const ppgDiff = homePpg - awayPpg;
  const rankDiff = awayRank - homeRank; // Positive = Home is higher in table

  // Pick type evaluation
  const type = leg.type || '';
  const outId = String(leg.outcomeId);
  const spec = String(leg.specifier || '');

  // 1. Double Chance / Straight Win on Home (1X or Home Win)
  if (type === 'dc' && (outId === '9' || outId === '1X') || (leg.marketId === '1' && outId === '1')) {
    if (ppgDiff >= 0.5 && rankDiff >= 4) {
      alignment = 'STRONG_SUPPORT';
      confidenceScore = 92;
      notes.push(`Home holds strong rank advantage (#${homeRank} vs #${awayRank}, +${ppgDiff.toFixed(2)} PPG)`);
    } else if (ppgDiff <= -0.7 && rankDiff <= -6) {
      alignment = 'STAT_CONTRADICTION';
      confidenceScore = 40;
      notes.push(`Underdog picked: Home is #${homeRank} vs Away #${awayRank} (-${Math.abs(ppgDiff).toFixed(2)} PPG)`);
    } else {
      alignment = 'MODERATE_SUPPORT';
      confidenceScore = 80;
    }
  }

  // 2. Double Chance / Straight Win on Away (X2 or Away Win)
  if (type === 'dc' && (outId === '11' || outId === 'X2') || (leg.marketId === '1' && outId === '3')) {
    if (ppgDiff <= -0.5 && rankDiff <= -4) {
      alignment = 'STRONG_SUPPORT';
      confidenceScore = 90;
      notes.push(`Away holds strong rank advantage (#${awayRank} vs #${homeRank}, +${Math.abs(ppgDiff).toFixed(2)} PPG)`);
    } else if (ppgDiff >= 0.7 && rankDiff >= 6) {
      alignment = 'STAT_CONTRADICTION';
      confidenceScore = 40;
      notes.push(`Away underdog picked against dominant home side (#${homeRank} vs #${awayRank})`);
    }
  }

  // 3. Under Markets (e.g. Under 3.5, Under 4.5)
  if (type === 'under' || leg.marketId === '18' && outId === '13') {
    const lineMatch = /total=([0-9.]+)/.exec(spec);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 3.5;
    const combinedExpectedGoals = (homeForm.avgGoals || 1.3) + (awayForm.avgGoals || 1.1);

    if (line >= 3.5 && combinedExpectedGoals <= 2.8) {
      alignment = 'STRONG_SUPPORT';
      confidenceScore = 91;
      notes.push(`Under ${line} backed by low combined expected scoring (${combinedExpectedGoals.toFixed(1)} goals/match)`);
    } else if (line <= 2.5 && combinedExpectedGoals >= 3.4) {
      alignment = 'STAT_CONTRADICTION';
      confidenceScore = 45;
      notes.push(`Under ${line} contradicts high combined goal expectation (${combinedExpectedGoals.toFixed(1)} goals/match)`);
    }
  }

  // 4. No-GG (Both Teams to Score - NO)
  if (type === 'nogg' || leg.marketId === '29' && outId === '76') {
    const homeCleanRate = homeForm.cleanSheets || 0;
    const awayFailRate = awayForm.failedToScore || 0;

    if (homeCleanRate >= 0.4 || awayFailRate >= 0.4) {
      alignment = 'STRONG_SUPPORT';
      confidenceScore = 88;
      notes.push(`No-GG supported: Clean sheet/fail-to-score rate is high (Home CS ${Math.round(homeCleanRate*100)}%, Away FTS ${Math.round(awayFailRate*100)}%)`);
    }
  }

  return {
    hasStats: true,
    alignment,
    confidenceScore,
    home: {
      name: homeEntry.team.name,
      rank: homeRank,
      played: homeEntry.played,
      points: homeEntry.points,
      ppg: homePpg,
      goalDiff: homeEntry.goal_difference,
      form: homeForm.formStr,
      avgScored: homeForm.avgGoals,
      avgConceded: homeForm.avgConceded
    },
    away: {
      name: awayEntry.team.name,
      rank: awayRank,
      played: awayEntry.played,
      points: awayEntry.points,
      ppg: awayPpg,
      goalDiff: awayEntry.goal_difference,
      form: awayForm.formStr,
      avgScored: awayForm.avgGoals,
      avgConceded: awayForm.avgConceded
    },
    summary: notes.length ? notes.join('; ') : `${homeEntry.team.name} (#${homeRank}, ${homePpg} PPG) vs ${awayEntry.team.name} (#${awayRank}, ${awayPpg} PPG)`
  };
}

module.exports = {
  extractForm,
  analyzeLegStats
};

