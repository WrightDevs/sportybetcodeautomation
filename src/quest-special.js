'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');
const { recordSlip } = require('./tracker');
const { getQuestUsage, incrementQuestUsage } = require('./db');
const { isAdmin } = require('./subs');

// ── Configuration & Headers ────────────────────────────
const CC = (CFG.REGION || 'gh').toLowerCase();
const SPORT = 'sr:sport:202120001';
const MARKETS = '1,10,14,18,60,63,65,68';

const MIN_ODDS = Number(process.env.QUEST_MIN_ODDS || 1.05);
const MAX_ODDS = Number(process.env.QUEST_MAX_ODDS || 1.35);
const MAX_RESULT_ODDS = Number(process.env.QUEST_MAX_RESULT_ODDS || 8.0);
const MAX_DAILY = 20;
const FIRED_TTL = 30 * 60 * 1000;

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  platform: 'wap',
  clientid: 'wap',
  'x-requested-with': 'XMLHttpRequest',
  'Current-Country': CC,
  referer: `https://www.sportybet.com/${CC}/m/sport/football/today/`,
  origin: 'https://www.sportybet.com',
};

// ── In-Memory State ────────────────────────────────────
const activeSessions = new Map(); // chatId → session
const lastResults    = new Map(); // chatId → signal result (for web polling)
const fired          = new Map(); // `${eventId}:${stage}` → timestamp

function pruneFired() {
  const cut = Date.now() - FIRED_TTL;
  for (const [k, ts] of fired) {
    if (ts < cut) fired.delete(k);
  }
}

function isUnlimitedUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;
  if (isAdmin && isAdmin(id)) return true;
  if (id === String(CFG.ADMIN_ID || '6916043986')) return true;
  return false;
}

function getDailyCount(chatId) {
  return getQuestUsage(chatId);
}

function incrementDailyCount(chatId) {
  return incrementQuestUsage(chatId);
}

// ── Clock & Score Invariants ───────────────────────────
// Invariant 1: playedSeconds is the ONLY clock. Format is "MM:SS".
// Invariant 2: Never calculate elapsed time from estimateStartTime.
function minute(raw) {
  const m = /^(\d{1,3}):(\d{2})$/.exec(String(raw || '').trim());
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

// Invariant 3: Score from setScore or availableScore. If missing, skip.
function scoreOf(ev) {
  const raw = String(ev.setScore || ev.availableScore || '').trim();
  const m = /^(\d+):(\d+)$/.exec(raw);
  return m ? { h: Number(m[1]), a: Number(m[2]) } : null;
}

// ── Market Helpers ─────────────────────────────────────
function getMarkets(ev, id) {
  return (ev.markets || []).filter(m =>
    String(m.id) === String(id) &&
    !m.banned &&
    (m.status === 0 || m.status === '0' || m.status === undefined)
  );
}

function getOutcome(m, outcomeId) {
  if (!m) return null;
  const o = (m.outcomes || []).find(x => String(x.id) === String(outcomeId) && (x.isActive === 1 || x.isActive === '1'));
  if (!o) return null;
  const odds = Number(o.odds);
  return (!isNaN(odds) && odds >= MIN_ODDS) ? { outcome: o, odds } : null;
}

// ── Enrich Event Markets ────────────────────────────────
// If event only has basic markets from the main list, fetch full details for handicap & OU lines
async function enrichEventMarkets(ev) {
  const hasHcap = (ev.markets || []).some(m => m.id === '14' || m.id === '65' || m.id === '10');
  if (hasHcap) return ev;
  try {
    const url = `https://www.sportybet.com/api/${CC}/factsCenter/event?eventId=${encodeURIComponent(ev.eventId)}`;
    const res = await fetch(url, { headers: BASE_HEADERS });
    const j = await res.json();
    if (j.bizCode === 10000 && j.data && Array.isArray(j.data.markets)) {
      return { ...ev, markets: j.data.markets };
    }
  } catch (_) {}
  return ev;
}

// ── Handicap Evaluator (Multi-Line + Double Chance +0.5 Fallback) ──────
function checkHandicapCandidates(ev, min, sc, isHT) {
  // STRICT SEPARATION:
  // In 1st Half (isHT=true): Market 65 (1st Half - Handicap) & Market 63 (1st Half Double Chance). NEVER Full Time markets!
  // In 2nd Half (isHT=false): Market 14 (Full Time - Handicap) & Market 10 (Full Time Double Chance).
  const hcapMId = isHT ? '65' : '14';
  const dcMId = isHT ? '63' : '10';
  const stagePrefix = isHT ? '1st Half' : 'Full Time';
  const candidates = [];

  // 1. European Handicap Lines (Outcome 1711 Home, Outcome 1713 Away)
  const mList = getMarkets(ev, hcapMId);
  for (const m of mList) {
    const spec = String(m.specifier || '');
    const matchSpec = /^hcp=(\d+):(\d+)$/.exec(spec);
    if (!matchSpec) continue;
    const x = Number(matchSpec[1]);
    const y = Number(matchSpec[2]);

    const hAfter = sc.h + x;
    const aAfter = sc.a + y;
    const hMargin = hAfter - aAfter;
    const aMargin = aAfter - hAfter;

    // Home Handicap (Left option / Outcome 1711) - qualifies if adjusted Home has >= 1 goal cushion
    if (hMargin >= 1) {
      const match = getOutcome(m, '1711');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        candidates.push({
          category: 'handicap',
          window: isHT ? 'ht_handicap' : 'ft_handicap',
          type: isHT ? 'ht_handicap' : 'ft_handicap',
          marketId: hcapMId,
          specifier: m.specifier,
          outcomeId: '1711',
          odds: match.odds,
          cushion: hMargin,
          description: `${stagePrefix} ${ev.homeTeamName} Handicap [${m.specifier}] (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.homeTeamName} holds a +${hMargin} cushion on ${stagePrefix.toLowerCase()} handicap [${m.specifier}].`,
          market: m,
          outcome: match.outcome
        });
      }
    }

    // Away Handicap (Right option / Outcome 1713) - qualifies if adjusted Away has >= 1 goal cushion
    if (aMargin >= 1) {
      const match = getOutcome(m, '1713');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        candidates.push({
          category: 'handicap',
          window: isHT ? 'ht_handicap' : 'ft_handicap',
          type: isHT ? 'ht_handicap' : 'ft_handicap',
          marketId: hcapMId,
          specifier: m.specifier,
          outcomeId: '1713',
          odds: match.odds,
          cushion: aMargin,
          description: `${stagePrefix} ${ev.awayTeamName} Handicap [${m.specifier}] (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.awayTeamName} holds a +${aMargin} cushion on ${stagePrefix.toLowerCase()} handicap [${m.specifier}].`,
          market: m,
          outcome: match.outcome
        });
      }
    }
  }

  // 2. Double Chance (+0.5 Asian Handicap Equivalent - stays open longer when M14 locks)
  const dcMarkets = getMarkets(ev, dcMId);
  for (const m of dcMarkets) {
    // 1X (Home or Draw / Home +0.5 Handicap): Outcome 9
    if (sc.h >= sc.a) {
      const match = getOutcome(m, '9');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        const cushion = sc.h > sc.a ? 2 : 1;
        candidates.push({
          category: 'handicap',
          window: isHT ? 'ht_double_chance' : 'ft_double_chance',
          type: isHT ? 'ht_double_chance' : 'ft_double_chance',
          marketId: dcMId,
          specifier: '',
          outcomeId: '9',
          odds: match.odds,
          cushion,
          description: `${stagePrefix} ${ev.homeTeamName} or Draw (1X / +0.5 Hcap) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.homeTeamName} secured with 1X (+0.5 handicap cushion).`,
          market: m,
          outcome: match.outcome
        });
      }
    }

    // X2 (Draw or Away / Away +0.5 Handicap): Outcome 11
    if (sc.a >= sc.h) {
      const match = getOutcome(m, '11');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        const cushion = sc.a > sc.h ? 2 : 1;
        candidates.push({
          category: 'handicap',
          window: isHT ? 'ht_double_chance' : 'ft_double_chance',
          type: isHT ? 'ht_double_chance' : 'ft_double_chance',
          marketId: dcMId,
          specifier: '',
          outcomeId: '11',
          odds: match.odds,
          cushion,
          description: `${stagePrefix} Draw or ${ev.awayTeamName} (X2 / +0.5 Hcap) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.awayTeamName} secured with X2 (+0.5 handicap cushion).`,
          market: m,
          outcome: match.outcome
        });
      }
    }

    // 12 (Home or Away / Either Team Wins): Outcome 10 when 2+ lead
    if (Math.abs(sc.h - sc.a) >= 2) {
      const match = getOutcome(m, '10');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        candidates.push({
          category: 'handicap',
          window: isHT ? 'ht_double_chance' : 'ft_double_chance',
          type: isHT ? 'ht_double_chance' : 'ft_double_chance',
          marketId: dcMId,
          specifier: '',
          outcomeId: '10',
          odds: match.odds,
          cushion: 2,
          description: `${stagePrefix} Home or Away (12 Double Chance) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. 2-goal lead provides decisive cushion.`,
          market: m,
          outcome: match.outcome
        });
      }
    }
  }

  // Sort candidates by cushion descending, then lowest safe odds
  candidates.sort((a, b) => b.cushion - a.cushion || a.odds - b.odds);
  return candidates;
}

// ── Over/Under Evaluator (Multi-Line Under Cushion) ─────────────────
function checkUnderCandidates(ev, min, sc, isHT) {
  const mId = isHT ? '68' : '18';
  const stagePrefix = isHT ? '1st Half' : 'Full Time';
  const total = sc.h + sc.a;
  const targetLine = total + 0.5;
  const candidates = [];

  const mList = getMarkets(ev, mId)
    .map(m => {
      const v = /^total=([\d.]+)$/.exec(m.specifier || '');
      return v ? { line: Number(v[1]), m } : null;
    })
    .filter(x => x && x.line >= targetLine)
    .sort((a, b) => a.line - b.line);

  for (const { line, m } of mList) {
    const match = getOutcome(m, '13'); // Outcome 13 = Under
    if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
      const buffer = (line - total).toFixed(1);
      candidates.push({
        category: 'ou',
        window: isHT ? 'ht_under' : 'ft_under',
        type: isHT ? 'ht_under' : 'ft_under',
        marketId: mId,
        specifier: m.specifier,
        outcomeId: '13',
        odds: match.odds,
        line,
        buffer,
        description: `${stagePrefix} Under ${line} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}' (total ${total} goals). Under ${line} backed by +${buffer} goal breathing room.`,
        market: m,
        outcome: match.outcome
      });
    }
  }

  // Sort Under candidates: lowest safe line first (tightest safe odds), then odds
  candidates.sort((a, b) => a.line - b.line || a.odds - b.odds);
  return candidates;
}

// ── 1X2 / Draw / Winner Evaluator ───────────────────────────────────
function checkResultCandidates(ev, min, sc, isHT) {
  const mId = isHT ? '60' : '1';
  const stagePrefix = isHT ? '1st Half' : 'Full Time';
  const isTied = sc.h === sc.a;
  const homeLeads = sc.h > sc.a;
  const awayLeads = sc.a > sc.h;
  const margin = Math.abs(sc.h - sc.a);
  const candidates = [];

  const m1 = getMarkets(ev, mId)[0];
  if (!m1) return candidates;

  // Case 1: Draw (X)
  if (isTied) {
    const match = getOutcome(m1, '2');
    if (match && match.odds <= MAX_RESULT_ODDS && match.odds >= MIN_ODDS) {
      candidates.push({
        category: 'result',
        window: isHT ? 'h1_draw' : 'ft_draw',
        type: isHT ? 'h1_draw' : 'match_draw',
        marketId: mId,
        specifier: '',
        outcomeId: '2',
        odds: match.odds,
        description: `${stagePrefix} Draw (X) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Match is tied ${sc.h}-${sc.a} at ${Math.round(min)}'. ${stagePrefix} whistle imminent — Draw (X).`,
        market: m1,
        outcome: match.outcome
      });
    }
  }

  // Case 2: 2+ goal lead
  if (margin >= 2) {
    const wantOutcome = homeLeads ? '1' : '3';
    const leaderTag = homeLeads ? ev.homeTeamName : ev.awayTeamName;
    const match = getOutcome(m1, wantOutcome);
    if (match && match.odds <= MAX_RESULT_ODDS && match.odds >= MIN_ODDS) {
      candidates.push({
        category: 'result',
        window: isHT ? 'h1_leader' : 'ft_leader',
        type: isHT ? 'h1_winner' : 'match_winner_2lead',
        marketId: mId,
        specifier: '',
        outcomeId: wantOutcome,
        odds: match.odds,
        description: `${stagePrefix} ${leaderTag} to Win (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `${leaderTag} holds a commanding ${sc.h}-${sc.a} lead at ${Math.round(min)}'. Match Winner secured.`,
        market: m1,
        outcome: match.outcome
      });
    }
  }

  return candidates;
}

// ── Backward-Compatibility Wrappers ─────────────────────────────────
function checkHandicap(ev, min, sc, isHT) {
  const cands = checkHandicapCandidates(ev, min, sc, isHT);
  return cands.length > 0 ? cands[0] : null;
}

function checkHT(ev, min, sc) {
  if (ev.matchStatus !== 'H1' || min < 38.0 || min > 43.0) return null;
  const hcap = checkHandicap(ev, min, sc, true);
  if (hcap) return hcap;
  const under = checkUnderCandidates(ev, min, sc, true);
  return under.length > 0 ? under[0] : null;
}

function checkHTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H1' || min < 38.0 || min > 43.0) return null;
  const res = checkResultCandidates(ev, min, sc, true);
  return res.length > 0 ? res[0] : null;
}

function checkFTHandicap(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 60.0 || min > 83.0) return null;
  return checkHandicap(ev, min, sc, false);
}

function checkFTUnder(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 68.0 || min > 86.0) return null;
  const cands = checkUnderCandidates(ev, min, sc, false);
  return cands.length > 0 ? cands[0] : null;
}

function checkFTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 83.0 || min > 86.0) return null;
  const cands = checkResultCandidates(ev, min, sc, false);
  return cands.length > 0 ? cands[0] : null;
}

// ── Fetch Live Matches ─────────────────────────────────
async function fetchLiveVFootball(tries = 3) {
  const url = `https://www.sportybet.com/api/${CC}/factsCenter/liveOrPrematchEvents`
    + `?sportId=${encodeURIComponent(SPORT)}&marketId=${MARKETS}&pageSize=100&pageNum=1`;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: BASE_HEADERS });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.bizCode !== 10000) continue;

      const tours = Array.isArray(j.data) ? j.data : (j.data && j.data.tournaments) || [];
      const out = [];
      for (const t of tours) {
        for (const ev of t.events || []) {
          // Invariant: status === 1 means live match currently in progress
          if (ev.status === 1 && !ev.banned) {
            out.push({ ...ev, league: t.name || t.categoryName || 'vFootball' });
          }
        }
      }
      return out;
    } catch (e) {
      if (i === tries - 1) return [];
      await sleep(500 * (i + 1));
    }
  }
  return [];
}

// ── Event Candidate Selector ───────────────────────────────
function getCandidatesForEvent(ev, min, sc, inH1, inH2, normalizedMode) {
  let candidates = [];
  if (normalizedMode === 'handicap' || normalizedMode === 'hcap') {
    if (inH1) {
      candidates = checkHandicapCandidates(ev, min, sc, true);
    } else if (inH2 && min <= 84.0) {
      candidates = checkHandicapCandidates(ev, min, sc, false);
    }
  } else if (normalizedMode === 'ou' || normalizedMode === 'over_under' || normalizedMode === 'under') {
    if (inH1) {
      candidates = checkUnderCandidates(ev, min, sc, true);
    } else if (inH2 && min >= 65.0) {
      candidates = checkUnderCandidates(ev, min, sc, false);
    }
  } else {
    // Mode === 'any' (Best available qualifying market)
    if (inH1) {
      candidates = [
        ...checkHandicapCandidates(ev, min, sc, true),
        ...checkUnderCandidates(ev, min, sc, true),
        ...checkResultCandidates(ev, min, sc, true)
      ];
    } else if (inH2) {
      if (min <= 78.0) {
        candidates = [
          ...checkHandicapCandidates(ev, min, sc, false),
          ...checkUnderCandidates(ev, min, sc, false)
        ];
      } else {
        candidates = [
          ...checkUnderCandidates(ev, min, sc, false),
          ...checkHandicapCandidates(ev, min, sc, false),
          ...checkResultCandidates(ev, min, sc, false)
        ];
      }
    }
  }
  return candidates;
}

// ── Minting Live Booking Slips (Single & Multi-Leg) ─────────
async function mintLiveBooking(legOrLegs, tries = 2) {
  const legs = Array.isArray(legOrLegs) ? legOrLegs : [legOrLegs];
  if (!legs.length) return { err: 'No selections provided' };

  const selections = legs.map(l => ({
    eventId: l.id || l.eventId,
    marketId: String(l.marketId),
    specifier: l.specifier || '',
    outcomeId: String(l.outcomeId)
  }));

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://www.sportybet.com/api/${CC}/orders/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          ...BASE_HEADERS
        },
        body: JSON.stringify({ selections })
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch (_) { continue; }
      if (j.bizCode === 10000 && j.data && (j.data.shareCode || j.data.bookingCode)) {
        const code = j.data.shareCode || j.data.bookingCode;
        const url = j.data.shareURL || `https://www.sportybet.com/${CC}/?shareCode=${code}`;
        return { code, url };
      }
      if (i === tries - 1) {
        return { err: j.message || 'Share code unavailable' };
      }
    } catch (e) {
      if (i === tries - 1) return { err: e.message };
      await sleep(500);
    }
  }
  return { err: 'Minting failed' };
}

// ── Scan with Strategy Mode, Multi-Legs & Live Mint Verification ─
async function scanQuestSpecial(userId = 'community', mode = 'any', targetLegs = 1) {
  pruneFired();
  const normalizedMode = String(mode || 'any').toLowerCase().trim();
  const legsNeeded = Math.max(1, Math.min(Number(targetLegs) || 1, 10));

  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  // Single-Leg Sniper Mode
  if (legsNeeded === 1) {
    for (const rawEv of events) {
      const min = minute(rawEv.playedSeconds);
      const sc = scoreOf(rawEv);
      if (min == null || !sc) continue; // Invariant: No clock or score -> NEVER guess

      const inH1 = rawEv.matchStatus === 'H1' && min >= 38.0 && min <= 43.0;
      const inH2 = rawEv.matchStatus === 'H2' && min >= 60.0 && min <= 86.0;
      if (!inH1 && !inH2) continue;

      const ev = await enrichEventMarkets(rawEv);
      const candidates = getCandidatesForEvent(ev, min, sc, inH1, inH2, normalizedMode);
      if (!candidates || !candidates.length) continue;

      for (const cand of candidates) {
        const fk = `${ev.eventId}:${cand.marketId}:${cand.specifier || 'none'}:${cand.outcomeId}`;
        if (fired.has(fk)) continue;

        const leg = {
          id: ev.eventId,
          marketId: cand.marketId,
          specifier: cand.specifier || '',
          outcomeId: cand.outcomeId,
          odds: cand.odds,
          home: ev.homeTeamName,
          away: ev.awayTeamName
        };

        const booking = await mintLiveBooking(leg);
        if (booking && booking.code) {
          fired.set(fk, Date.now());

          // Record to stats tracker with isQuestSpecial: true
          try {
            recordSlip({
              userId: String(userId || 'community'),
              code: booking.code,
              sport: 'quest_special',
              totalOdds: cand.odds,
              legs: [{
                id: ev.eventId,
                home: ev.homeTeamName,
                away: ev.awayTeamName,
                league: ev.league || 'vFootball',
                marketId: cand.marketId,
                outcomeDesc: cand.description,
                outcomeId: cand.outcomeId,
                specifier: cand.specifier || '',
                odds: cand.odds
              }],
              url: booking.url,
              isQuestSpecial: true
            });
          } catch (_) {}

          return {
            isMultiLeg: false,
            eventId: ev.eventId,
            home: ev.homeTeamName,
            away: ev.awayTeamName,
            league: ev.league || 'vFootball',
            minute: Math.round(min),
            homeScore: sc.h,
            awayScore: sc.a,
            mode: normalizedMode,
            analysis: cand,
            code: booking.code,
            url: booking.url,
            mintError: null,
            timestamp: Date.now()
          };
        }
      }
    }
    return null;
  }

  // Multi-Leg Accumulator Mode (targetLegs > 1, e.g. 5 legs)
  const gathered = [];
  const seenEventIds = new Set();

  for (const rawEv of events) {
    if (seenEventIds.has(rawEv.eventId)) continue;

    const min = minute(rawEv.playedSeconds);
    const sc = scoreOf(rawEv);
    if (min == null || !sc) continue;

    const inH1 = rawEv.matchStatus === 'H1' && min >= 38.0 && min <= 43.0;
    const inH2 = rawEv.matchStatus === 'H2' && min >= 60.0 && min <= 86.0;
    if (!inH1 && !inH2) continue;

    const ev = await enrichEventMarkets(rawEv);
    const candidates = getCandidatesForEvent(ev, min, sc, inH1, inH2, normalizedMode);
    if (!candidates || !candidates.length) continue;

    // Pick best non-fired candidate for this event
    for (const cand of candidates) {
      const fk = `${ev.eventId}:${cand.marketId}:${cand.specifier || 'none'}:${cand.outcomeId}`;
      if (fired.has(fk)) continue;

      const leg = {
        id: ev.eventId,
        marketId: cand.marketId,
        specifier: cand.specifier || '',
        outcomeId: cand.outcomeId,
        odds: cand.odds,
        home: ev.homeTeamName,
        away: ev.awayTeamName
      };

      gathered.push({ ev, min, sc, cand, fk, leg });
      seenEventIds.add(ev.eventId);
      break; // Only 1 leg per match in accumulator
    }

    if (gathered.length >= legsNeeded) break;
  }

  if (gathered.length < legsNeeded) {
    return null;
  }

  const selectedLegs = gathered.slice(0, legsNeeded);
  const booking = await mintLiveBooking(selectedLegs.map(g => g.leg));

  if (booking && booking.code) {
    for (const item of selectedLegs) {
      fired.set(item.fk, Date.now());
    }

    const totalOdds = Number(selectedLegs.reduce((acc, item) => acc * item.cand.odds, 1).toFixed(2));

    try {
      recordSlip({
        userId: String(userId || 'community'),
        code: booking.code,
        sport: 'quest_special',
        totalOdds,
        legs: selectedLegs.map(item => ({
          id: item.ev.eventId,
          home: item.ev.homeTeamName,
          away: item.ev.awayTeamName,
          league: item.ev.league || 'vFootball',
          marketId: item.cand.marketId,
          outcomeDesc: item.cand.description,
          outcomeId: item.cand.outcomeId,
          specifier: item.cand.specifier || '',
          odds: item.cand.odds
        })),
        url: booking.url,
        isQuestSpecial: true
      });
    } catch (_) {}

    return {
      isMultiLeg: true,
      legsCount: selectedLegs.length,
      totalOdds,
      code: booking.code,
      url: booking.url,
      mode: normalizedMode,
      timestamp: Date.now(),
      legs: selectedLegs.map(item => ({
        eventId: item.ev.eventId,
        home: item.ev.homeTeamName,
        away: item.ev.awayTeamName,
        league: item.ev.league || 'vFootball',
        minute: Math.round(item.min),
        homeScore: item.sc.h,
        awayScore: item.sc.a,
        analysis: item.cand,
        odds: item.cand.odds,
        description: item.cand.description,
        reasoning: item.cand.reasoning
      }))
    };
  }

  return null;
}

// ── Session Management (Telegram & Web Polling) ────────
function startSession(chatId, optionsOrMode, onDone) {
  const id = String(chatId);
  let mode = 'any';
  let legs = 1;
  let callback = onDone;

  if (typeof optionsOrMode === 'function') {
    callback = optionsOrMode;
  } else if (typeof optionsOrMode === 'string') {
    mode = optionsOrMode;
  } else if (typeof optionsOrMode === 'object' && optionsOrMode !== null) {
    if (optionsOrMode.mode) mode = optionsOrMode.mode;
    if (optionsOrMode.legs) legs = Number(optionsOrMode.legs) || 1;
    if (optionsOrMode.onDone) callback = optionsOrMode.onDone;
  }

  if (activeSessions.has(id)) {
    return { ok: false, error: 'Quest Special is already active. Wait for the current scan to complete.' };
  }
  if (!isUnlimitedUser(id) && getDailyCount(id) >= MAX_DAILY) {
    return { ok: false, error: `Daily limit reached (${MAX_DAILY}/${MAX_DAILY}). Try again tomorrow!` };
  }

  const session = { active: true, startedAt: Date.now(), scans: 0, chatId: id, mode, legs };

  // Poll every 3.5 seconds
  const timer = setInterval(async () => {
    if (!session.active) { clearInterval(timer); activeSessions.delete(id); return; }

    // Auto-timeout after 10 minutes
    if (Date.now() - session.startedAt > 10 * 60 * 1000) {
      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      lastResults.set(id, { timedOut: true, timestamp: Date.now(), mode, legs });
      if (callback) callback(null, true);
      return;
    }

    session.scans++;
    try {
      const signal = await scanQuestSpecial(id, session.mode, session.legs);
      if (!signal) return; // Keep scanning

      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      incrementDailyCount(id);

      lastResults.set(id, signal);

      if (callback) callback(signal, false);
    } catch (err) {
      console.error('Quest Special loop error:', err.message);
    }
  }, 3500);

  session.timer = timer;
  activeSessions.set(id, session);

  const legsLabel = legs > 1 ? `${legs}-Leg ` : '';
  return {
    ok: true,
    message: `🔍 Quest Special (${legsLabel}${mode.toUpperCase()}) activated! Scanning live vFootball matches…`,
    mode,
    legs
  };
}

function stopSession(chatId) {
  const id = String(chatId);
  const s = activeSessions.get(id);
  if (!s) return false;
  s.active = false;
  if (s.timer) clearInterval(s.timer);
  activeSessions.delete(id);
  return true;
}

function isActive(chatId) { return activeSessions.has(String(chatId)); }

function getStatus(chatId) {
  const id = String(chatId);
  const s  = activeSessions.get(id);
  const lr = lastResults.get(id) || null;
  const isUnlimited = isUnlimitedUser(id);
  return {
    active: !!s,
    mode: s ? s.mode : (lr && lr.mode ? lr.mode : 'any'),
    legs: s ? s.legs : (lr && lr.legsCount ? lr.legsCount : 1),
    scans: s ? s.scans : 0,
    runningFor: s ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    dailyUsed: getDailyCount(id),
    maxDaily: isUnlimited ? 'Unlimited' : MAX_DAILY,
    isUnlimited,
    lastResult: lr
  };
}

function getLastResult(chatId) { return lastResults.get(String(chatId)) || null; }
function clearLastResult(chatId) { lastResults.delete(String(chatId)); }

module.exports = {
  scanQuestSpecial,
  mintLiveBooking,
  fetchLiveVFootball,
  checkHandicapCandidates,
  checkUnderCandidates,
  checkResultCandidates,
  checkHT,
  checkFTHandicap,
  checkFTUnder,
  checkHandicap,
  startSession,
  stopSession,
  isActive,
  getStatus,
  getLastResult,
  clearLastResult,
  getDailyCount,
  incrementDailyCount,
  isUnlimitedUser,
  minute,
  scoreOf,
  MAX_DAILY
};
