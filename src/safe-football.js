'use strict';
// IO layer for the normal-football safe selector: fetch upcoming matches, select per tier,
// refresh odds, mint booking codes (no staking), log for calibration, record for the boom rate.
const { CFG } = require('./config');
const { API, get } = require('./api');
const { sleep } = require('./util');
const { mint } = require('./mint');
const { recordSlip } = require('./tracker');
const { FOOTBALL } = require('./selection/config');
const { selectFootball, refreshLegs, buildTierSlip } = require('./selection/football');
const { logSlip } = require('./selection/log');
const { analyzeLegStats } = require('./stats/analyzer');
const { verifyLegsWithAi } = require('./stats/aiVerifier');

const MARKET_IDS = ['1', '10', '14', '18', '29'];

async function fetchUpcoming(cfg = FOOTBALL) {
  const now = Date.now();
  const hi = now + cfg.HORIZON_HOURS * 36e5;
  const lo = now + cfg.MIN_LEAD_MIN * 60000;
  const hours = Math.max(1, Math.ceil(cfg.HORIZON_HOURS));
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

// Select + mint. opts: { userId, dryRun, tiers:[...], events (inject for tests) }
async function generateSafeFootball(preset = {}, userId = null, opts = {}) {
  const events = opts.events || await fetchUpcoming();
  const sel = selectFootball(events);
  const lines = [], codes = [], noSafe = [];
  const names = opts.tiers || Object.keys(sel.slips);
  const eventCache = new Map(); // shared across tiers so each match is fetched once
  const statsCache = new Map(); // shared across tiers so each match stats is fetched/cached once

  for (const name of names) {
    let slip = sel.slips[name];
    if (!slip) continue;

    const banned = new Set();
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
          const tgt = FOOTBALL.TIERS[name].targetOdds;
          if (tgt && slip.totalOdds < tgt) {
            slip = { ...slip, ok: false, reason: 'no safe slip', reasons: [`odds drifted: @${slip.totalOdds} < target @${tgt} after refresh`], refreshDropped: dropNotes };
          }
          break;
        }
        ref.dropped.forEach(d => { banned.add(d.eventId); dropNotes.push(`${d.home} v ${d.away}: ${d.reason}`); });
        slip = { ...buildTierSlip(name, sel.perEvent.filter(p => !banned.has(p[0].eventId))), refreshDropped: dropNotes };
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
          const key = leg.eventId || `${leg.home}-${leg.away}`;
          let stats = statsCache.get(key);
          if (!stats) {
            try {
              stats = await analyzeLegStats(leg);
            } catch (err) {
              stats = { hasStats: false, reason: err.message };
            }
            statsCache.set(key, stats);
          }
          enriched.push({ ...leg, stats });
        }

        const verdicts = await verifyLegsWithAi(enriched, { timeoutMs: opts.aiTimeoutMs });
        const verdictMap = new Map(verdicts.map(v => [String(v.legId), v]));

        const rejected = [];
        const accepted = [];
        for (const leg of enriched) {
          const id = String(leg.eventId || leg.id || leg.legId);
          const v = verdictMap.get(id);
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
          const tgt = FOOTBALL.TIERS[name].targetOdds;
          if (tgt && slip.totalOdds < tgt) {
            slip = { ...slip, ok: false, reason: 'no safe slip', reasons: [`odds below target @${tgt} after stats audit (@${slip.totalOdds})`] };
          }
          break;
        }

        rejected.forEach(d => {
          banned.add(d.leg.eventId);
          dropNotes.push(`${d.leg.home} v ${d.leg.away} (Stats/AI): ${d.reason}`);
        });

        slip = {
          ...buildTierSlip(name, sel.perEvent.filter(p => !banned.has(p[0].eventId))),
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
      tier: name, tierName: label(name), jointProb: slip.jointProb, ...(slip.highRisk ? { highRisk: true } : {}) });
    try {
      recordSlip({ userId, code: r.code, sport: preset.key || 'football', totalOdds: slip.totalOdds, legs: slip.legs, url });
    } catch (e) { console.error('Failed to record slip:', e.message); }
    logSlip({ code: r.code, mode: `football_${name}`, legs: slip.legs.map(l => ({ ...l, stage: 'PRE', minute: 0 })), jointProb: slip.jointProb, totalOdds: slip.totalOdds });
    await sleep(3000); // keep the whole request well under typical proxy timeouts
  }
  return { lines, codes, count: codes.filter(c => c.code).length, noSafe, considered: sel.considered, eventsScanned: sel.eventsScanned };
}

module.exports = { generateSafeFootball, fetchUpcoming };
