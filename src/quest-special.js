'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');
const { recordSlip } = require('./tracker');

// ── Configuration & Headers ────────────────────────────
const CC = (CFG.REGION || 'gh').toLowerCase();
const SPORT = 'sr:sport:202120001';
const MARKETS = '1,14,18,60,65,68';

const MIN_ODDS = Number(process.env.QUEST_MIN_ODDS || 1.01);
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
const dailyUsage     = new Map(); // chatId → { date, count }
const lastResults    = new Map(); // chatId → signal result (for web polling)
const fired          = new Map(); // `${eventId}:${stage}` → timestamp

function pruneFired() {
  const cut = Date.now() - FIRED_TTL;
  for (const [k, ts] of fired) {
    if (ts < cut) fired.delete(k);
  }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function getDailyCount(chatId) {
  const u = dailyUsage.get(String(chatId));
  return (u && u.date === todayStr()) ? u.count : 0;
}

function incrementDailyCount(chatId) {
  const id = String(chatId);
  const today = todayStr();
  const u = dailyUsage.get(id);
  if (!u || u.date !== today) dailyUsage.set(id, { date: today, count: 1 });
  else u.count++;
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
  return (ev.markets || []).filter(m => String(m.id) === String(id) && !m.banned);
}

function getOutcome(m, outcomeId) {
  if (!m) return null;
  const o = (m.outcomes || []).find(x => String(x.id) === String(outcomeId) && (x.isActive === 1 || x.isActive === '1'));
  if (!o) return null;
  const odds = Number(o.odds);
  return (!isNaN(odds) && odds >= 1.01) ? { outcome: o, odds } : null;
}

// ── Enrich Event Markets ────────────────────────────────
// If event only has basic markets from the main list, fetch full details for handicap & OU lines
async function enrichEventMarkets(ev) {
  const hasHcap = (ev.markets || []).some(m => m.id === '14' || m.id === '65');
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

// ── Handicap Evaluator (Top Priority) ───────────────────
function checkHandicap(ev, min, sc, isHT) {
  // STRICT SEPARATION:
  // In 1st Half (isHT=true): ONLY Market 65 (1st Half - Handicap). NEVER Market 14 (Full Time)!
  // In 2nd Half (isHT=false): ONLY Market 14 (Full Time - Handicap).
  const mId = isHT ? '65' : '14';
  const mList = getMarkets(ev, mId);
  const validPicks = [];

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
    const stagePrefix = isHT ? '1st Half' : 'Full Time';

    // Home Handicap (Outcome 1711) - qualifies if adjusted Home has >= 1 goal cushion
    if (hMargin >= 1) {
      const match = getOutcome(m, '1711');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        validPicks.push({
          window: isHT ? '41min_ht_hcap' : '85min_ft_hcap',
          type: isHT ? 'ht_handicap' : 'ft_handicap',
          marketId: mId,
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

    // Away Handicap (Outcome 1713) - qualifies if adjusted Away has >= 1 goal cushion
    if (aMargin >= 1) {
      const match = getOutcome(m, '1713');
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        validPicks.push({
          window: isHT ? '41min_ht_hcap' : '85min_ft_hcap',
          type: isHT ? 'ht_handicap' : 'ft_handicap',
          marketId: mId,
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

  if (validPicks.length > 0) {
    // Prioritize greatest cushion (+2/+3 before +1), then lowest safe odds
    validPicks.sort((a, b) => b.cushion - a.cushion || a.odds - b.odds);
    return validPicks[0];
  }

  return null;
}

// ── Timing Rule 1: 41′ HT (Window: 40.0′ – 42.5′, must be H1) ──
// Priority 1: Handicap (Market 65 / Market 14)
// Priority 2: Over/Under Fallback (Market 68 / Market 18)
function checkHT(ev, min, sc) {
  // Guard: must be in active first half starting from 40min with safe staking buffer before half-time whistle
  if (ev.matchStatus !== 'H1' || min < 40.0 || min > 42.5) return null;

  // 1st Priority: Handicap
  const hcap = checkHandicap(ev, min, sc, true);
  if (hcap) return hcap;

  // 2nd Priority (Fallback): Over/Under
  return checkHTUnderFallback(ev, min, sc);
}

function checkHTUnderFallback(ev, min, sc) {
  const total = sc.h + sc.a;
  const targetLine = total + 0.5;

  // 1st priority: Market 68 (1st Half - Over/Under)
  const m68List = getMarkets(ev, '68');
  for (const m of m68List) {
    const v = /^total=([\d.]+)$/.exec(m.specifier || '');
    if (!v) continue;
    const line = Number(v[1]);
    if (line >= targetLine) {
      const match = getOutcome(m, '13'); // Outcome 13 = Under
      if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
        return {
          window: '41min_ht_under',
          type: 'ht_under',
          marketId: '68',
          specifier: m.specifier,
          outcomeId: '13',
          odds: match.odds,
          description: `1st Half Under ${line} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. Handicap unavailable — 1st Half Under ${line} fallback.`,
          market: m,
          outcome: match.outcome
        };
      }
    }
  }

  return null;
}

// ── Timing Rule 2: 41′ H1 Result / Draw (Window: 40.0′ – 43.0′, must be H1) ──
function checkHTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H1' || min < 40.0 || min > 43.0) return null;

  const isTied = sc.h === sc.a;
  const homeLeads = sc.h > sc.a;
  const wantOutcome = isTied ? '2' : homeLeads ? '1' : '3';
  const pickLabel = isTied ? '1st Half Draw (X)' : homeLeads ? '1st Half: Home Win' : '1st Half: Away Win';

  // STRICT: Market 60 ONLY (1st Half - 1X2). NEVER fall back to full-time Market 1 in H1!
  const m60 = getMarkets(ev, '60')[0];
  if (m60) {
    const match = getOutcome(m60, wantOutcome);
    if (match && match.odds <= MAX_RESULT_ODDS) {
      return {
        window: '43min_h1_winner',
        type: isTied ? 'h1_draw' : 'h1_winner',
        marketId: '60',
        specifier: '',
        outcomeId: wantOutcome,
        odds: match.odds,
        description: `${pickLabel} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: isTied
          ? `Match is tied ${sc.h}-${sc.a} at ${Math.round(min)}'. Half-time whistle imminent — Draw (X).`
          : `${homeLeads ? 'Home' : 'Away'} leads ${sc.h}-${sc.a} at ${Math.round(min)}'. 1st Half leader lock.`,
        market: m60,
        outcome: match.outcome
      };
    }
  }

  return null;
}

// ── Timing Rule 3: 85′ FT (Window: 83.0′ – 85.5′, must be H2) ──
// Priority 1: Handicap (Market 14)
// Priority 2: Over/Under Fallback (Market 18)
function checkFT(ev, min, sc) {
  // Guard: must be in active second half starting from 83min with safe staking buffer before full-time whistle
  if (ev.matchStatus !== 'H2' || min < 83.0 || min > 85.5) return null;

  // 1st Priority: Handicap
  const hcap = checkHandicap(ev, min, sc, false);
  if (hcap) return hcap;

  // 2nd Priority (Fallback): Over/Under
  return checkFTUnderFallback(ev, min, sc);
}

function checkFTUnderFallback(ev, min, sc) {
  const total = sc.h + sc.a;
  const targetLine = total + 0.5;

  const m18Lines = getMarkets(ev, '18')
    .map(m => {
      const v = /^total=([\d.]+)$/.exec(m.specifier || '');
      return v ? { line: Number(v[1]), m } : null;
    })
    .filter(x => x && x.line >= targetLine)
    .sort((a, b) => a.line - b.line);

  for (const { line, m } of m18Lines) {
    const match = getOutcome(m, '13'); // Outcome 13 = Under
    if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
      return {
        window: '85min_ft_under',
        type: 'ft_under',
        marketId: '18',
        specifier: m.specifier,
        outcomeId: '13',
        odds: match.odds,
        description: `Full Time Under ${line} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. Handicap unavailable — Under ${line} fallback.`,
        market: m,
        outcome: match.outcome
      };
    }
  }

  return null;
}

// ── Timing Rule 4: 85′ FT Draw / Late Lead / Handicap (Window: 83.0′ – 86.0′, must be H2) ──
function checkFTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 83.0 || min > 86.0) return null;

  const margin = Math.abs(sc.h - sc.a);
  const isTied = sc.h === sc.a;
  const homeLeads = sc.h > sc.a;
  const awayLeads = sc.a > sc.h;
  const leaderTag = homeLeads ? 'Home' : 'Away';
  const wantOutcome = isTied ? '2' : homeLeads ? '1' : '3';

  // Case 1: Tied game at 87'+ → Full Time Draw (X)
  if (isTied) {
    const m1 = getMarkets(ev, '1')[0];
    if (m1) {
      const match = getOutcome(m1, '2');
      if (match && match.odds <= MAX_RESULT_ODDS) {
        return {
          window: '88min_draw',
          type: 'match_draw',
          marketId: '1',
          specifier: '',
          outcomeId: '2',
          odds: match.odds,
          description: `Full Time Draw (X) (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `Match is tied ${sc.h}-${sc.a} at ${Math.round(min)}'. Final whistle approaching — Draw (X).`,
          market: m1,
          outcome: match.outcome
        };
      }
    }
  }

  // Case 2: 2+ goal lead at 87'+ → 1X2 Match Winner
  if (margin >= 2) {
    const m1 = getMarkets(ev, '1')[0];
    if (m1) {
      const match = getOutcome(m1, wantOutcome);
      if (match && match.odds <= MAX_RESULT_ODDS) {
        return {
          window: '88min_lead',
          type: 'match_winner_2lead',
          marketId: '1',
          specifier: '',
          outcomeId: wantOutcome,
          odds: match.odds,
          description: `${leaderTag} to Win (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `${leaderTag} holds a commanding ${sc.h}-${sc.a} lead at ${Math.round(min)}'. Match Winner secured.`,
          market: m1,
          outcome: match.outcome
        };
      }
    }
  }

  // Case 3: 1 goal lead at 87'+ → Handicap cushion or 1X2 Match Winner
  if (margin === 1) {
    // Check Market 14 (Handicap) for cushion
    const m14List = getMarkets(ev, '14');
    for (const m of m14List) {
      const spec = String(m.specifier || '');
      const validCushion = homeLeads
        ? (spec.includes('hcp=1:0') || spec.includes('hcp=2:0'))
        : (spec.includes('hcp=0:1') || spec.includes('hcp=0:2'));

      if (validCushion) {
        const wantHcapOutcome = homeLeads ? '1711' : '1713'; // Home / Away Handicap
        const match = getOutcome(m, wantHcapOutcome) || (m.outcomes || []).find(o => (homeLeads ? o.desc.startsWith('Home') : o.desc.startsWith('Away')) && (o.isActive === 1 || o.isActive === '1'));
        if (match) {
          const odds = Number(match.odds || match.outcome?.odds);
          if (odds <= 1.45) {
            return {
              window: '88min_hcap',
              type: 'handicap_1lead',
              marketId: '14',
              specifier: m.specifier,
              outcomeId: String(match.outcome?.id || match.id || wantHcapOutcome),
              odds,
              description: `${leaderTag} Handicap Cushion (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
              reasoning: `${leaderTag} leads ${sc.h}-${sc.a} at ${Math.round(min)}'. Secured with Handicap cushion.`,
              market: m,
              outcome: match.outcome || match
            };
          }
        }
      }
    }

    // Fallback: 1X2 Match Winner on leader
    const m1 = getMarkets(ev, '1')[0];
    if (m1) {
      const match = getOutcome(m1, wantOutcome);
      if (match && match.odds <= MAX_RESULT_ODDS) {
        return {
          window: '88min_1x2',
          type: 'match_winner_1lead',
          marketId: '1',
          specifier: '',
          outcomeId: wantOutcome,
          odds: match.odds,
          description: `${leaderTag} to Win (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
          reasoning: `${leaderTag} leads ${sc.h}-${sc.a} at ${Math.round(min)}'. Match Winner.`,
          market: m1,
          outcome: match.outcome
        };
      }
    }
  }

  return null;
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

// ── Minting Live Booking Slips ─────────────────────────
async function mintLiveBooking(leg, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://www.sportybet.com/api/${CC}/orders/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          ...BASE_HEADERS
        },
        body: JSON.stringify({
          selections: [{
            eventId: leg.id,
            marketId: String(leg.marketId),
            specifier: leg.specifier || '',
            outcomeId: String(leg.outcomeId)
          }]
        })
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

// ── Single Scan ────────────────────────────────────────
async function scanQuestSpecial(userId = 'community') {
  pruneFired();

  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  for (const rawEv of events) {
    const min = minute(rawEv.playedSeconds);
    const sc = scoreOf(rawEv);
    if (min == null || !sc) continue; // Invariant: No clock or score -> NEVER guess

    // Check if within any buffered sniper window (40.0′-43.0′ HT, 83.0′-86.0′ FT)
    const inHT = rawEv.matchStatus === 'H1' && min >= 40.0 && min <= 43.0;
    const inFT = rawEv.matchStatus === 'H2' && min >= 83.0 && min <= 86.0;
    if (!inHT && !inFT) continue;

    const ev = await enrichEventMarkets(rawEv);

    // Check each stage in priority order:
    // HT: 1. Handicap -> 2. Over/Under fallback -> 3. H1 winner
    // FT: 1. Handicap -> 2. Over/Under fallback -> 3. Late winner/draw
    const signal = checkHT(ev, min, sc)
      || checkHTResult(ev, min, sc)
      || checkFT(ev, min, sc)
      || checkFTResult(ev, min, sc);

    if (signal) {
      const fk = `${ev.eventId}:${signal.type}`;
      if (fired.has(fk)) continue;
      fired.set(fk, Date.now());

      const leg = {
        id: ev.eventId,
        marketId: signal.marketId,
        specifier: signal.specifier,
        outcomeId: signal.outcomeId,
        odds: signal.odds,
        home: ev.homeTeamName,
        away: ev.awayTeamName
      };

      const booking = await mintLiveBooking(leg);

      // Record to stats tracker if booking code was minted
      if (booking && booking.code) {
        try {
          recordSlip({
            userId: String(userId || 'community'),
            code: booking.code,
            sport: 'quest_special',
            totalOdds: signal.odds,
            legs: [{
              id: ev.eventId,
              home: ev.homeTeamName,
              away: ev.awayTeamName,
              league: ev.league || 'vFootball',
              marketId: signal.marketId,
              outcomeDesc: signal.description,
              outcomeId: signal.outcomeId,
              specifier: signal.specifier,
              odds: signal.odds
            }],
            url: booking.url,
            isQuestSpecial: true
          });
        } catch (_) {}
      }

      return {
        eventId: ev.eventId,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        league: ev.league || 'vFootball',
        minute: Math.round(min),
        homeScore: sc.h,
        awayScore: sc.a,
        analysis: signal,
        code: booking.code || null,
        url: booking.url || null,
        mintError: booking.err || null,
        timestamp: Date.now()
      };
    }
  }

  return null;
}

// ── Session Management (Telegram & Web Polling) ────────
function startSession(chatId, onDone) {
  const id = String(chatId);

  if (activeSessions.has(id)) {
    return { ok: false, error: 'Quest Special is already active. Wait for the current scan to complete.' };
  }
  if (getDailyCount(id) >= MAX_DAILY) {
    return { ok: false, error: `Daily limit reached (${MAX_DAILY}/${MAX_DAILY}). Try again tomorrow!` };
  }

  const session = { active: true, startedAt: Date.now(), scans: 0, chatId: id };

  // Poll every 3.5 seconds
  const timer = setInterval(async () => {
    if (!session.active) { clearInterval(timer); activeSessions.delete(id); return; }

    // Auto-timeout after 10 minutes
    if (Date.now() - session.startedAt > 10 * 60 * 1000) {
      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      lastResults.set(id, { timedOut: true, timestamp: Date.now() });
      if (onDone) onDone(null, true);
      return;
    }

    session.scans++;
    try {
      const signal = await scanQuestSpecial(id);
      if (!signal) return; // Keep scanning

      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      incrementDailyCount(id);

      lastResults.set(id, signal);

      // Record to Boom tracker if booking code exists (deduplicated by recordSlip)
      if (signal.code) {
        try {
          recordSlip({
            userId: id,
            code: signal.code,
            sport: 'quest_special',
            totalOdds: signal.analysis.odds,
            legs: [{
              id: signal.eventId,
              home: signal.home,
              away: signal.away,
              league: signal.league || 'vFootball',
              marketId: signal.analysis.marketId,
              outcomeDesc: signal.analysis.description,
              outcomeId: signal.analysis.outcomeId,
              specifier: signal.analysis.specifier,
              odds: signal.analysis.odds
            }],
            url: signal.url,
            isQuestSpecial: true
          });
        } catch (_) {}
      }

      if (onDone) onDone(signal, false);
    } catch (err) {
      console.error('Quest Special loop error:', err.message);
    }
  }, 3500);

  session.timer = timer;
  activeSessions.set(id, session);

  return { ok: true, message: '🔍 Quest Special activated! Scanning live vFootball matches…' };
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
  return {
    active: !!s,
    scans: s ? s.scans : 0,
    runningFor: s ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    dailyUsed: getDailyCount(id),
    maxDaily: MAX_DAILY,
    lastResult: lr
  };
}

function getLastResult(chatId) { return lastResults.get(String(chatId)) || null; }
function clearLastResult(chatId) { lastResults.delete(String(chatId)); }

module.exports = {
  scanQuestSpecial,
  fetchLiveVFootball,
  checkHT,
  checkFT,
  checkHandicap,
  startSession,
  stopSession,
  isActive,
  getStatus,
  getLastResult,
  clearLastResult,
  getDailyCount,
  minute,
  scoreOf,
  MAX_DAILY
};
