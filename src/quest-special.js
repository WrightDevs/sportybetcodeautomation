'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');
const { recordSlip } = require('./tracker');
const { getQuestUsage, incrementQuestUsage } = require('./db');
const { isAdmin } = require('./subs');
const { MARKET_WINDOW, SELECTION } = require('./selection/config');
const { selectSlip, applyVeto } = require('./selection/safeSelector');
const { vetoLegs } = require('./selection/veto');
const { logSlip } = require('./selection/log');

const WINDOW_SPAN = SELECTION.WINDOW_SPAN;
let lastNoSafe = null; // most recent "no safe slip" explanation (for status/timeouts)

// ── Configuration & Headers ────────────────────────────
const CC = (CFG.REGION || 'ng').toLowerCase();
const SPORT = 'sr:sport:202120001';
const MARKETS = '1,10,14,18,19,20,29,60,63,65,68';

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
// ── Handicap Evaluator (Multi-Line + Double Chance +0.5 Fallback) ──────
function checkHandicapCandidates(ev, min, sc, isHT) {
  // STRICT SEPARATION:
  // In 1st Half (isHT=true): Market 65 (1st Half - Handicap) & Market 63 (1st Half Double Chance). NEVER Full Time markets!
  // In 2nd Half (isHT=false): Market 14 (Full Time - Handicap) & Market 10 (Full Time Double Chance).
  const hcapMId = isHT ? '65' : '14';
  const dcMId = isHT ? '63' : '10';
  const stagePrefix = isHT ? '1st Half' : 'Full Time';
  const candidates = [];

  const goalDiff = sc.h - sc.a;
  const absDiff = Math.abs(goalDiff);

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

    // RULE FOR 3+ GOAL LEAD:
    // If one team already leads by 3+ goals (e.g. 0-3 or 3-0):
    // SKIP leading team handicap completely.
    // Trailing team handicap is ONLY allowed if the line gives a net advantage strictly > margin (e.g. 4:0 when 0-3).
    // An equal line (e.g. 3:0 when 0-3) results in a DRAW (European handicap loss).
    if (absDiff >= 3) {
      if (goalDiff <= -3) {
        // Away leads by 3+ (e.g. 0-3). Only Home with x >= absDiff + 1 (e.g. 4:0 or higher) is safe!
        if (x >= absDiff + 1 && hMargin >= 1) {
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
              reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.homeTeamName} backed by +${x} goals ([${m.specifier}]) maintaining a safe +${hMargin} cushion.`,
              market: m,
              outcome: match.outcome
            });
          }
        }
      } else if (goalDiff >= 3) {
        // Home leads by 3+ (e.g. 3-0). Only Away with y >= absDiff + 1 (e.g. 0:4 or higher) is safe!
        if (y >= absDiff + 1 && aMargin >= 1) {
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
              reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.awayTeamName} backed by +${y} goals ([${m.specifier}]) maintaining a safe +${aMargin} cushion.`,
              market: m,
              outcome: match.outcome
            });
          }
        }
      }
      continue; // Skip any other handicap lines when 3+ lead
    }

    // Standard Cushion Rule (margin < 3):
    // Home Handicap (Outcome 1711) - must have >= 1 cushion AFTER score
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

    // Away Handicap (Outcome 1713) - must have >= 1 cushion AFTER score
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
  if (absDiff < 3) {
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
    }
  }

  // Sort candidates by cushion descending, then lowest safe odds
  candidates.sort((a, b) => b.cushion - a.cushion || a.odds - b.odds);
  return candidates;
}

// ── No GG / Clean Sheet Evaluator (Both Teams to Score - NO) ─────────
function checkNoGGCandidates(ev, min, sc, isHT) {
  const candidates = [];
  const stagePrefix = isHT ? '1st Half' : 'Full Time';

  // Only valid if at least one team currently has 0 goals (clean sheet active)
  if (sc.h !== 0 && sc.a !== 0) return candidates;

  // Market 29 (GG/NG / Both Teams to Score): outcome 74 = Yes, 76 = No (NG).
  // (Verified on live factsCenter output; the old id '30' never matched.)
  const m29 = getMarkets(ev, '29')[0];
  if (m29) {
    const match = getOutcome(m29, '76');
    if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
      const zeroTeam = sc.h === 0 ? ev.homeTeamName : ev.awayTeamName;
      candidates.push({
        category: 'nogg',
        window: isHT ? 'ht_nogg' : 'ft_nogg',
        type: isHT ? 'ht_nogg' : 'ft_nogg',
        marketId: '29',
        specifier: '',
        outcomeId: '76',
        odds: match.odds,
        description: `${stagePrefix} Both Teams To Score - NO (No GG) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${zeroTeam} has not scored — No GG backed by remaining time buffer.`,
        market: m29,
        outcome: match.outcome
      });
    }
  }

  // Market 19 (Home Team O/U) when Home has 0: Home Under 0.5
  if (sc.h === 0) {
    const m19 = getMarkets(ev, '19').find(m => m.specifier === 'total=0.5');
    if (m19) {
      const match = getOutcome(m19, '13'); // Outcome 13 = Under
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        candidates.push({
          category: 'nogg',
          window: isHT ? 'ht_nogg' : 'ft_nogg',
          type: isHT ? 'ht_nogg' : 'ft_nogg',
          marketId: '19',
          specifier: 'total=0.5',
          outcomeId: '13',
          odds: match.odds,
          description: `${stagePrefix} ${ev.homeTeamName} Under 0.5 Goals (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.homeTeamName} scoreless — Under 0.5 goals.`,
          market: m19,
          outcome: match.outcome
        });
      }
    }
  }

  // Market 20 (Away Team O/U) when Away has 0: Away Under 0.5
  if (sc.a === 0) {
    const m20 = getMarkets(ev, '20').find(m => m.specifier === 'total=0.5');
    if (m20) {
      const match = getOutcome(m20, '13'); // Outcome 13 = Under
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        candidates.push({
          category: 'nogg',
          window: isHT ? 'ht_nogg' : 'ft_nogg',
          type: isHT ? 'ht_nogg' : 'ft_nogg',
          marketId: '20',
          specifier: 'total=0.5',
          outcomeId: '13',
          odds: match.odds,
          description: `${stagePrefix} ${ev.awayTeamName} Under 0.5 Goals (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. ${ev.awayTeamName} scoreless — Under 0.5 goals.`,
          market: m20,
          outcome: match.outcome
        });
      }
    }
  }

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
  if (ev.matchStatus !== 'H2' || min < 75.0 || min > 84.0) return null;
  return checkHandicap(ev, min, sc, false);
}

function checkFTUnder(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 75.0 || min > 86.0) return null;
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
// Generates every candidate leg for the stage (no ordering: ranking is done by the safe selector).
function getCandidatesForEvent(ev, min, sc, inH1, inH2, normalizedMode) {
  let candidates = [];
  const absDiff = Math.abs(sc.h - sc.a);
  const isHT = !!inH1;
  if (!inH1 && !inH2) return candidates;

  if (normalizedMode === 'handicap' || normalizedMode === 'hcap') {
    candidates = checkHandicapCandidates(ev, min, sc, isHT);
    // User Decision Rule: when a team leads by 3+ goals and a safe 4:0+ handicap is unavailable,
    // fall back to No GG (Both Teams to Score - NO).
    if (candidates.length === 0 && absDiff >= 3 && !isHT) {
      candidates = checkNoGGCandidates(ev, min, sc, false);
    }
  } else if (normalizedMode === 'ou' || normalizedMode === 'over_under' || normalizedMode === 'under') {
    candidates = checkUnderCandidates(ev, min, sc, isHT);
  } else {
    candidates = [
      ...checkHandicapCandidates(ev, min, sc, isHT),
      ...checkUnderCandidates(ev, min, sc, isHT),
      ...checkNoGGCandidates(ev, min, sc, isHT),
      ...checkResultCandidates(ev, min, sc, isHT)
    ];
  }
  return candidates;
}

// Stage gate derived from the single MARKET_WINDOW config (HT 40 / FT 80 +/- span).
function stageOf(ev, min) {
  const [h0, h1] = WINDOW_SPAN.HT, [f0, f1] = WINDOW_SPAN.FT;
  const inH1 = ev.matchStatus === 'H1' && min >= MARKET_WINDOW.HT + h0 && min <= MARKET_WINDOW.HT + h1;
  const inH2 = ev.matchStatus === 'H2' && min >= MARKET_WINDOW.FT + f0 && min <= MARKET_WINDOW.FT + f1;
  return { inH1, inH2, stage: inH1 ? 'HT' : inH2 ? 'FT' : null };
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

// ── Scan: safe selector over all in-window live events ─────
async function scanQuestSpecial(userId = 'community', mode = 'any', targetLegs = 1) {
  pruneFired();
  const normalizedMode = String(mode || 'any').toLowerCase().trim();
  const legsNeeded = Math.max(1, Math.min(Number(targetLegs) || 1, 10));

  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  // Step A: candidate pool - live, clock+score known, inside the firing window, active markets
  const pool = [];
  for (const rawEv of events) {
    const min = minute(rawEv.playedSeconds);
    const sc = scoreOf(rawEv);
    if (min == null || !sc) continue; // Invariant: No clock or score -> NEVER guess
    const { inH1, inH2, stage } = stageOf(rawEv, min);
    if (!stage) continue;
    const ev = await enrichEventMarkets(rawEv);
    pool.push({ ev, minute: min, score: sc, stage, inH1, inH2 });
  }
  if (!pool.length) return null;

  const deps = {
    getMarkets,
    generateCandidates: (ev, min, sc, stage) => {
      const all = getCandidatesForEvent(ev, min, sc, stage === 'HT', stage === 'FT', normalizedMode);
      return all.filter(c => !fired.has(`${ev.eventId}:${c.marketId}:${c.specifier || 'none'}:${c.outcomeId}`));
    }
  };

  // Steps B-E (deterministic)
  let selection = selectSlip(pool, { legs: legsNeeded, isVirtual: true }, deps);

  // Step F: LLM veto (multi-leg only, time-boxed, fail-open, drop-only)
  if (selection.ok && legsNeeded > 1) {
    const verdicts = await vetoLegs(selection.legs);
    selection = applyVeto(selection, verdicts);
  }

  if (!selection.ok) {
    lastNoSafe = { timestamp: Date.now(), reasons: selection.reasons || [], considered: selection.candidatesConsidered || 0 };
    return null; // "no safe slip" - keep scanning, never lower the bar
  }

  const chosen = selection.legs;
  const booking = await mintLiveBooking(chosen.map(l => ({
    id: l.eventId, marketId: l.marketId, specifier: l.specifier, outcomeId: l.outcomeId
  })));
  if (!booking || !booking.code) return null;

  for (const l of chosen) fired.set(`${l.eventId}:${l.marketId}:${l.specifier || 'none'}:${l.outcomeId}`, Date.now());
  logSlip({ code: booking.code, mode: normalizedMode, legs: chosen, jointProb: selection.jointProb, totalOdds: selection.totalOdds });

  try {
    recordSlip({
      userId: String(userId || 'community'),
      code: booking.code,
      sport: 'quest_special',
      totalOdds: selection.totalOdds,
      legs: chosen.map(l => ({
        id: l.eventId, home: l.home, away: l.away, league: l.league || 'vFootball',
        marketId: l.marketId, outcomeDesc: l.description, outcomeId: l.outcomeId,
        specifier: l.specifier || '', odds: l.odds
      })),
      url: booking.url,
      isQuestSpecial: true
    });
  } catch (_) {}

  const shape = l => ({
    eventId: l.eventId, home: l.home, away: l.away, league: l.league || 'vFootball',
    minute: Math.round(l.minute), homeScore: l.scoreH, awayScore: l.scoreA,
    analysis: { ...l.analysis, prob: l.prob, safetyScore: l.score },
    odds: l.odds, description: l.description, reasoning: l.reasoning,
    prob: l.prob, safetyScore: l.score
  });

  if (legsNeeded === 1) {
    const l = chosen[0];
    return {
      isMultiLeg: false,
      ...shape(l),
      mode: normalizedMode,
      code: booking.code, url: booking.url, mintError: null,
      jointProb: selection.jointProb,
      timestamp: Date.now()
    };
  }
  return {
    isMultiLeg: true,
    legsCount: chosen.length,
    totalOdds: selection.totalOdds,
    jointProb: selection.jointProb,
    code: booking.code, url: booking.url,
    mode: normalizedMode,
    timestamp: Date.now(),
    legs: chosen.map(shape)
  };
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
  checkNoGGCandidates,
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
  getLastNoSafe: () => lastNoSafe,
  stageOf,
  getMarkets,
  getCandidatesForEvent,
  minute,
  scoreOf,
  MAX_DAILY
};
