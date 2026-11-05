'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');
const { recordSlip } = require('./tracker');

// ── Configuration & Headers ────────────────────────────
const CC = (CFG.REGION || 'gh').toLowerCase();
const SPORT = 'sr:sport:202120001';
const MARKETS = '1,14,18,60,68';

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

// ── Timing Rule 1: 41′ HT Under (Window: 38′ – 42.5′, must be H1) ──
function checkHTUnder(ev, min, sc) {
  // Guard: must be in active first half with safe buffer before half-time whistle
  if (ev.matchStatus !== 'H1' || min < 38.0 || min > 42.5) return null;

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
          reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. Half-time whistle is imminent — 1st Half Under ${line}.`,
          market: m,
          outcome: match.outcome
        };
      }
    }
  }

  // 2nd priority: Market 18 (Full Time O/U) starting from targetLine (total + 0.5)
  const m18Lines = getMarkets(ev, '18')
    .map(m => {
      const v = /^total=([\d.]+)$/.exec(m.specifier || '');
      return v ? { line: Number(v[1]), m } : null;
    })
    .filter(x => x && x.line >= targetLine)
    .sort((a, b) => a.line - b.line); // start at total + 0.5, step up if odds out of band

  for (const { line, m } of m18Lines) {
    const match = getOutcome(m, '13');
    if (match && match.odds >= MIN_ODDS && match.odds <= MAX_ODDS) {
      return {
        window: '41min_ht_under',
        type: 'ht_under',
        marketId: '18',
        specifier: m.specifier,
        outcomeId: '13',
        odds: match.odds,
        description: `FT Under ${line} Cushion (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. High-cushion Under ${line} locked.`,
        market: m,
        outcome: match.outcome
      };
    }
  }

  return null;
}

// ── Timing Rule 2: 43′ H1 Result / Draw (Window: 40′ – 43.5′, must be H1) ──
function checkHTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H1' || min < 40.0 || min > 43.5) return null;

  const isTied = sc.h === sc.a;
  const homeLeads = sc.h > sc.a;
  const awayLeads = sc.a > sc.h;
  const wantOutcome = isTied ? '2' : homeLeads ? '1' : '3';
  const pickLabel = isTied ? '1st Half Draw (X)' : homeLeads ? '1st Half: Home Win' : '1st Half: Away Win';

  // 1st priority: Market 60 (1st Half - 1X2)
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

  // 2nd priority: Market 1 (1X2) if Market 60 is closed
  const m1 = getMarkets(ev, '1')[0];
  if (m1) {
    const match = getOutcome(m1, wantOutcome);
    if (match && match.odds <= MAX_RESULT_ODDS) {
      return {
        window: '43min_h1_winner',
        type: isTied ? 'h1_draw' : 'h1_winner',
        marketId: '1',
        specifier: '',
        outcomeId: wantOutcome,
        odds: match.odds,
        description: `${pickLabel} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(min)}')`,
        reasoning: `Match state is ${sc.h}-${sc.a} at ${Math.round(min)}'. Locking ${pickLabel}.`,
        market: m1,
        outcome: match.outcome
      };
    }
  }

  return null;
}

// ── Timing Rule 3: 85′ FT Under (Window: 81′ – 85.5′, must be H2) ──
function checkFTUnder(ev, min, sc) {
  // Guard: must be in active second half with safe buffer before full-time whistle
  if (ev.matchStatus !== 'H2' || min < 81.0 || min > 85.5) return null;

  const total = sc.h + sc.a;
  const targetLine = total + 0.5;

  const m18Lines = getMarkets(ev, '18')
    .map(m => {
      const v = /^total=([\d.]+)$/.exec(m.specifier || '');
      return v ? { line: Number(v[1]), m } : null;
    })
    .filter(x => x && x.line >= targetLine)
    .sort((a, b) => a.line - b.line); // start at total + 0.5 (e.g. 0-0 -> 0.5, 1-0 -> 1.5, 1-1 -> 2.5)

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
        reasoning: `Score is ${sc.h}-${sc.a} at ${Math.round(min)}'. Full time whistle is imminent — Under ${line}.`,
        market: m,
        outcome: match.outcome
      };
    }
  }

  return null;
}

// ── Timing Rule 4: 88′ FT Draw / Late Lead / Handicap (Window: 83′ – 86.5′, must be H2) ──
function checkFTResult(ev, min, sc) {
  if (ev.matchStatus !== 'H2' || min < 83.0 || min > 86.5) return null;

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
async function mintLiveBooking(leg) {
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
    const j = await res.json();
    if (j.bizCode === 10000 && j.data && (j.data.shareCode || j.data.bookingCode)) {
      const code = j.data.shareCode || j.data.bookingCode;
      const url = j.data.shareURL || `https://www.sportybet.com/${CC}/?shareCode=${code}`;
      return { code, url };
    }
    return { err: j.message || 'Share code unavailable' };
  } catch (e) {
    return { err: e.message };
  }
}

// ── Single Scan ────────────────────────────────────────
async function scanQuestSpecial() {
  pruneFired();

  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  for (const ev of events) {
    const min = minute(ev.playedSeconds);
    const sc = scoreOf(ev);
    if (min == null || !sc) continue; // Invariant: No clock or score -> NEVER guess

    // Check each stage in priority order
    const signal = checkHTUnder(ev, min, sc)
      || checkHTResult(ev, min, sc)
      || checkFTUnder(ev, min, sc)
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
      const signal = await scanQuestSpecial();
      if (!signal) return; // Keep scanning

      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      incrementDailyCount(id);

      lastResults.set(id, signal);

      // Record to Boom tracker if booking code exists
      if (signal.code) {
        try {
          recordSlip({
            userId: id,
            code: signal.code,
            sport: 'vfootball',
            totalOdds: signal.analysis.odds,
            legs: [{
              id: signal.eventId,
              marketId: signal.analysis.marketId,
              specifier: signal.analysis.specifier,
              outcomeId: signal.analysis.outcomeId,
              odds: signal.analysis.odds,
              home: signal.home,
              away: signal.away
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
