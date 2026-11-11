'use strict';
// IO layer for the normal-football safe selector: fetch upcoming matches, select per tier,
// refresh odds, mint booking codes (no staking), log for calibration, record for the boom rate.
const { CFG } = require('./config');
const { API, get } = require('./api');
const { sleep } = require('./util');
const { mint } = require('./mint');
const { recordSlip } = require('./tracker');
const { FOOTBALL } = require('./selection/config');
const { selectFootball, refreshLegs, buildTierSlip, oddsBand } = require('./selection/football');
const { logSlip } = require('./selection/log');
const { analyzeLegStats } = require('./stats/analyzer');
const { verifyLegsWithAi } = require('./stats/aiVerifier');

const MARKET_IDS = ['1', '10', '14', '18', '29'];

// horizonHours (optional) widens the window for tiers that need many matches (Tycoon / Moonshot).
async function fetchUpcoming(cfg = FOOTBALL, horizonHours = cfg.HORIZON_HOURS) {
  const now = Date.now();
  const hi = now + horizonHours * 36e5;
  const lo = now + cfg.MIN_LEAD_MIN * 60000;
  const hours = Math.max(1, Math.ceil(horizonHours));
  const seen = new Map();
  for (let page = 1; page <= 30; page++) {
    const j = await get(`${API}/factsCenter/pcUpcomingEvents?sportId=sr:sport:1&marketId=${MARKET_IDS.join(',')}`
      + `&pageSize=100&pageNum=${page}&option=1&order=0&todayGames=false&timeline=${hours}&_t=${Date.now()}`);
    const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name }))) || [];
    if (!evs.length) break;
    for (const { e, league } of evs) {
      const ko = Number(e.estimateStartTime);
      if (seen.has(e.eventId) || !(ko >= lo && ko <= hi)) continue;
      seen.set(e.eventId, { ...e, league, ko });
    }
    await sleep(250);
  }
  return [...seen.values()];
}

const fetchEvent = async id => {
  const j = await get(`${API}/factsCenter/event?eventId=${encodeURIComponent(id)}`);
  return j?.data || null;
};

// User-facing text carries NO raw probabilities; includes verified stats status if available.
const legLine = l => {
  const statsTag = l.stats?.hasStats ? ` [Stats: #${l.stats.home?.rank || '?'} vs #${l.stats.away?.rank || '?'}]` : '';
  return `${l.home} v ${l.away} | ${l.desc} @${l.odds}${statsTag}`;
};
const label = name => FOOTBALL.NAMES[name] || name;

const legKey = l => `${l.eventId}|${l.marketId}|${l.outcomeId}|${l.specifier || ''}`;
// Stats depend on the pick type (an Over is judged differently from a handicap), so the cache key includes it.
const statsKey = l => `${l.eventId || `${l.home}-${l.away}`}|${l.type}|${l.line ?? ''}`;
const oddsPerRisk = l => Math.log(l.odds) / Math.max(1e-9, -Math.log(Math.min(0.9999, l.prob)));

async function statsFor(leg, statsCache, analyze = analyzeLegStats) {
  const key = statsKey(leg);
  let stats = statsCache.get(key);
  if (!stats) {
    try { stats = await analyze(leg); } catch (err) { stats = { hasStats: false, reason: err.message }; }
    statsCache.set(key, stats);
  }
  return stats;
}

/**
 * Over legs are fail-closed: one is only allowed into a slip if the stats API shows STRONG_SUPPORT for it.
 * Only the best Over per match, and at most OVER_PRESCREEN matches, are checked (free plan: 60 requests/hour);
 * every other Over is removed so the tier builders only ever see verified ones.
 * Returns { perEvent, screen } where screen reports what happened (for logs / dry runs).
 */
async function screenOvers(perEvent, statsCache, opts = {}, cfg = FOOTBALL) {
  const best = [];
  for (const legs of perEvent) {
    const overs = legs.filter(l => l.type === 'over');
    if (overs.length) best.push(overs.reduce((b, x) => (oddsPerRisk(x) > oddsPerRisk(b) ? x : b)));
  }
  const screen = { candidates: best.length, checked: 0, accepted: 0, notes: [] };
  if (!best.length) return { perEvent, screen };

  const allowed = new Set();
  if (opts.noStats) {
    screen.notes.push('stats check disabled: no Over legs used');
  } else {
    best.sort((a, b) => oddsPerRisk(b) - oddsPerRisk(a));
    for (const leg of best.slice(0, cfg.OVER_PRESCREEN)) {
      const stats = await statsFor(leg, statsCache, opts.analyze);
      screen.checked++;
      if (stats.hasStats && stats.alignment === 'STRONG_SUPPORT') { allowed.add(legKey(leg)); screen.accepted++; }
      else screen.notes.push(`${leg.home} v ${leg.away} ${leg.desc}: ${stats.hasStats ? `${stats.alignment} - ${stats.summary}` : `no stats (${stats.reason})`}`);
    }
    if (best.length > cfg.OVER_PRESCREEN) screen.notes.push(`${best.length - cfg.OVER_PRESCREEN} further Over candidates not checked (limit ${cfg.OVER_PRESCREEN})`);
  }
  const filtered = perEvent
    .map(legs => legs.filter(l => l.type !== 'over' || allowed.has(legKey(l))))
    .filter(legs => legs.length);
  return { perEvent: filtered, screen };
}

// A slip is only valid inside its tier's total-odds band: [targetOdds, maxTotalOdds].
const bandReason = (name, totalOdds, stage) => {
  const { min, max } = oddsBand(name);
  if (totalOdds < min) return `${stage}: @${totalOdds} below target @${min}`;
  if (totalOdds > max) return `${stage}: @${totalOdds} above ceiling @${max}`;
  return null;
};

// Select + mint. opts: { userId, dryRun, tiers:[...], events (inject for tests) }
// opts.tiers limits the run to the tiers the user asked for (default: every tier).
async function generateSafeFootball(preset = {}, userId = null, opts = {}) {
  const names = (opts.tiers && opts.tiers.length ? opts.tiers : Object.keys(FOOTBALL.TIERS)).filter(n => FOOTBALL.TIERS[n]);
  const horizon = Math.max(FOOTBALL.HORIZON_HOURS, ...names.map(n => FOOTBALL.TIERS[n].horizonHours || 0));
  const events = opts.events || await fetchUpcoming(FOOTBALL, horizon);
  const sel = selectFootball(events, FOOTBALL, names);
  const lines = [], codes = [], noSafe = [];
  const eventCache = new Map(); // shared across tiers so each match is fetched once
  const statsCache = new Map(); // shared across tiers so each match stats is fetched/cached once

  // Verify Over legs with the stats API first; slips are then (re)built from the verified pool only.
  // Skipped when no requested tier can use an Over, so the stats budget goes to the tier the user chose.
  const usesOver = names.some(n => FOOTBALL.TIERS[n].families.includes('over'));
  const screened = usesOver ? await screenOvers(sel.perEvent, statsCache, opts) : { perEvent: sel.perEvent, screen: { candidates: 0 } };
  const perEvent = screened.perEvent;
  if (screened.screen.candidates) {
    for (const name of Object.keys(sel.slips)) sel.slips[name] = buildTierSlip(name, perEvent);
    console.log(`[football] Over screen: ${screened.screen.accepted}/${screened.screen.candidates} accepted${screened.screen.notes.length ? '\n  ' + screened.screen.notes.join('\n  ') : ''}`);
  }

  for (const name of names) {
    let slip = sel.slips[name];
    if (!slip) continue;

    const banned = new Set();       // whole matches that failed a check
    const bannedLegs = new Set();   // single legs (an Over that failed) - the match's other legs stay usable
    const view = () => perEvent
      .map(legs => legs.filter(l => !bannedLegs.has(legKey(l))))
      .filter(legs => legs.length && !banned.has(legs[0].eventId));
    const dropNotes = [];

    // 1. Live odds refresh (if not opted out)
    if (slip.ok && !opts.noRefresh) {
      let clean = false;
      for (let pass = 0; pass < 4 && slip.ok; pass++) {
        const ref = await refreshLegs(slip.legs, fetchEvent, FOOTBALL, eventCache);
        if (!ref.dropped.length) {
          clean = true;
          slip = { ...slip, legs: ref.legs, totalOdds: Number(ref.legs.reduce((a, l) => a * l.odds, 1).toFixed(2)),
            jointProb: Number(ref.legs.reduce((a, l) => a * l.prob, 1).toFixed(4)) };
          const outOfBand = bandReason(name, slip.totalOdds, 'odds drifted after refresh');
          if (outOfBand) {
            slip = { ...slip, ok: false, reason: 'no safe slip', reasons: [outOfBand], refreshDropped: dropNotes };
          }
          break;
        }
        ref.dropped.forEach(d => { banned.add(d.eventId); dropNotes.push(`${d.home} v ${d.away}: ${d.reason}`); });
        slip = { ...buildTierSlip(name, view()), refreshDropped: dropNotes };
      }
      if (slip.ok && !clean) slip = { ...slip, ok: false, reason: 'no safe slip', reasons: ['odds kept moving during refresh'], refreshDropped: dropNotes };
      else if (slip.ok && dropNotes.length) slip.refreshDropped = dropNotes;
    }

    // 2. Statistical verification + AI risk audit (5DollarFootballAPI + Gemini/DeepSeek)
    if (slip.ok && !opts.noStats) {
      let statsClean = false;
      for (let pass = 0; pass < 3 && slip.ok; pass++) {
        const enriched = [];
        for (const leg of slip.legs) {
          enriched.push({ ...leg, stats: await statsFor(leg, statsCache, opts.analyze) });
        }

        const verifier = opts.verify || verifyLegsWithAi;
        const verdicts = await verifier(enriched, { timeoutMs: opts.aiTimeoutMs });
        const verdictMap = new Map(verdicts.map(v => [String(v.legId), v]));

        const rejected = [];
        const accepted = [];
        for (const leg of enriched) {
          const id = String(leg.eventId || leg.id || leg.legId);
          const v = verdictMap.get(id);
          if (leg.type === 'over') {
            // Fail-closed: needs strong stats support AND an explicit AI keep (unless AI is switched off for Overs).
            const strong = leg.stats?.hasStats && leg.stats.alignment === 'STRONG_SUPPORT';
            const aiKeep = !FOOTBALL.OVER_REQUIRE_AI || (v && v.verdict === 'keep' && v.source === 'llm');
            if (!strong || !aiKeep) {
              const why = !strong ? 'stats do not strongly support the Over' : (v && v.verdict === 'drop' ? (v.reason || 'AI dropped the Over') : 'no AI confirmation for the Over');
              rejected.push({ leg, reason: why, legOnly: true });
              continue;
            }
            accepted.push(leg);
            continue;
          }
          if (v && v.verdict === 'drop') {
            rejected.push({ leg, reason: v.reason || 'AI/Stats rejection' });
          } else {
            accepted.push(leg);
          }
        }

        if (!rejected.length) {
          statsClean = true;
          slip = {
            ...slip,
            legs: accepted,
            totalOdds: Number(accepted.reduce((a, l) => a * l.odds, 1).toFixed(2)),
            jointProb: Number(accepted.reduce((a, l) => a * l.prob, 1).toFixed(4))
          };
          const outOfBand = bandReason(name, slip.totalOdds, 'after stats audit');
          if (outOfBand) {
            slip = { ...slip, ok: false, reason: 'no safe slip', reasons: [outOfBand] };
          }
          break;
        }

        rejected.forEach(d => {
          if (d.legOnly) bannedLegs.add(legKey(d.leg)); else banned.add(d.leg.eventId);
          dropNotes.push(`${d.leg.home} v ${d.leg.away} (Stats/AI): ${d.reason}`);
        });

        slip = {
          ...buildTierSlip(name, view()),
          statsDropped: dropNotes
        };
      }

      if (slip.ok && !statsClean) {
        slip = {
          ...slip,
          ok: false,
          reason: 'no safe slip',
          reasons: ['legs repeatedly rejected by stats/AI verification'],
          statsDropped: dropNotes
        };
      } else if (slip.ok && dropNotes.length) {
        slip.statsDropped = dropNotes;
      }
    }

    if (!slip.ok) {
      // API keeps the detailed (numeric) reasons; the human-readable line is neutral.
      noSafe.push({ tier: name, tierName: label(name), reasons: slip.reasons || [], refreshDropped: slip.refreshDropped || [], statsDropped: slip.statsDropped || [] });
      lines.push(`${label(name)}: not available right now`);
      continue;
    }
    if (opts.dryRun) {
      lines.push(`${label(name)} @${slip.totalOdds} (${slip.legs.length} legs)\n` + slip.legs.map(legLine).join('\n'));
      codes.push({ tier: name, tierName: label(name), dry: true, ...slip });
      continue;
    }
    const r = await mint(slip.legs);
    if (!r.code) { lines.push(`${label(name)}: could not create a booking code (${r.err})`); continue; }
    const url = r.url || `https://www.sportybet.com/${CFG.REGION}/?shareCode=${r.code}`;
    lines.push(`${label(name)}  ${r.code}  ${slip.legs.length} legs  @${slip.totalOdds}\n${url}`);
    codes.push({ code: r.code, url, odds: slip.totalOdds, legsCount: slip.legs.length, sport: 'football',
      tier: name, tierName: label(name), jointProb: slip.jointProb, statsVerified: slip.legs.some(l => l.stats?.hasStats),
      ...(slip.highRisk ? { highRisk: true } : {}) });
    try {
      recordSlip({ userId, code: r.code, sport: preset.key || 'football', totalOdds: slip.totalOdds, legs: slip.legs, url });
    } catch (e) { console.error('Failed to record slip:', e.message); }
    logSlip({ code: r.code, mode: `football_${name}`, legs: slip.legs.map(l => ({ ...l, stage: 'PRE', minute: 0 })), jointProb: slip.jointProb, totalOdds: slip.totalOdds });
    await sleep(3000); // keep the whole request well under typical proxy timeouts
  }
  return { lines, codes, count: codes.filter(c => c.code).length, noSafe, considered: sel.considered, eventsScanned: sel.eventsScanned };
}

module.exports = { generateSafeFootball, fetchUpcoming, screenOvers };
