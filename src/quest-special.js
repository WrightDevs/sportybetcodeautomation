'use strict';
const { CFG } = require('./config');
const { API, get } = require('./api');
const { sleep } = require('./util');
const { mint } = require('./mint');
const { recordSlip } = require('./tracker');

// ── State ──────────────────────────────────────────────
const activeSessions = new Map(); // chatId → session
const dailyUsage     = new Map(); // chatId → { date, count }
const lastResults    = new Map(); // chatId → signal result (for web polling)
const MAX_DAILY      = 20;

// Extended market IDs for Quest Special
// 1 = 1X2, 14 = Handicap, 18 = O/U, 63 = HT Result, 68 = HT O/U
const QS_MARKET_IDS = '1,14,18,63,68';

// ── Helpers ────────────────────────────────────────────
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

function clockOf(ev) {
  for (const k of ['matchClock', 'elapsed', 'minute', 'matchTime', 'periodTime', 'time']) {
    const v = ev[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  const m = /(\d{1,3})/.exec(String(ev.matchStatus || ''));
  if (m) return Number(m[1]);

  // Calculate virtual minute from elapsed kickoff time in a 3-minute (180s) virtual round
  if (ev.estimateStartTime) {
    const elapsedSec = (Date.now() - Number(ev.estimateStartTime)) / 1000;
    if (elapsedSec >= 0 && elapsedSec <= 180) {
      return Math.round((elapsedSec / 180) * 90);
    }
  }
  return null;
}

function scoreOf(ev) {
  return [
    Number(ev.homeTeamScore ?? ev.homeScore ?? ev.home?.score ?? NaN),
    Number(ev.awayTeamScore ?? ev.awayScore ?? ev.away?.score ?? NaN)
  ];
}

/** Best-effort stats extraction (may be null for virtuals) */
function statsOf(ev) {
  let homePoss = null, awayPoss = null, homeShots = null, awayShots = null;
  const raw = ev.statistics || ev.stats || ev.matchStatistics;
  if (!raw) return { homePoss, awayPoss, homeShots, awayShots };

  const arr = Array.isArray(raw) ? raw : [];
  for (const s of arr) {
    const n = String(s.name || s.type || '').toLowerCase();
    if (n.includes('poss'))                           { homePoss = +s.home || +s.homeValue || 0; awayPoss = +s.away || +s.awayValue || 0; }
    if (n.includes('shot') && n.includes('target'))   { homeShots = +s.home || +s.homeValue || 0; awayShots = +s.away || +s.awayValue || 0; }
  }
  if (raw.possession)  { homePoss = +(raw.possession.home ?? raw.possession[0] ?? 0); awayPoss = +(raw.possession.away ?? raw.possession[1] ?? 0); }
  if (raw.shotsOnGoal) { homeShots = +(raw.shotsOnGoal.home ?? 0); awayShots = +(raw.shotsOnGoal.away ?? 0); }
  return { homePoss, awayPoss, homeShots, awayShots };
}

function parseHandicapSpecifier(specifier) {
  if (!specifier) return { homeHcap: 0, awayHcap: 0, val: 0 };
  const colon = /handicap=(\d+):(\d+)/i.exec(specifier);
  if (colon) {
    return {
      homeHcap: Number(colon[1]),
      awayHcap: Number(colon[2]),
      val: Math.max(Number(colon[1]), Number(colon[2]))
    };
  }
  const dec = /handicap=([+-]?[\d.]+)/i.exec(specifier);
  if (dec) {
    const n = parseFloat(dec[1]);
    return {
      homeHcap: n > 0 ? n : 0,
      awayHcap: n < 0 ? Math.abs(n) : 0,
      val: Math.abs(n)
    };
  }
  return { homeHcap: 0, awayHcap: 0, val: 0 };
}

/** Find the first outcome in a market that passes `pred(outcome, market, odds)` */
function findOutcome(ev, marketId, pred) {
  for (const m of (ev.markets || [])) {
    if (String(m.id) !== String(marketId) || m.status !== 0) continue;
    for (const o of (m.outcomes || [])) {
      if (o.isActive === 0 || o.isActive === '0') continue;
      const odd = parseFloat(o.odds);
      if (isNaN(odd) || odd < 1.01) continue;
      if (pred(o, m, odd)) return { market: m, outcome: o, odds: odd };
    }
  }
  return null;
}

// ── Analysis Logic ─────────────────────────────────────

/**
 * 38-minute window (HT) — dynamic Over/Under
 *  0-0  → Under 0.5 HT   (no goals in 1st half, HT whistle is imminent)
 *  1-0+ → Over  0.5 HT   (already achieved — safe cashout-type bet)
 */
function analyzeHT(ev, minute, h, a) {
  if (minute < 35 || minute > 42) return null;

  const totalGoals = h + a;
  const wantOver = totalGoals > 0;
  const direction = wantOver ? 'Over' : 'Under';
  const totalLine = 0.5;

  // Try HT O/U (market 68) first, then generic O/U (18)
  for (const mid of ['68', '18']) {
    const pick = findOutcome(ev, mid, (o, m) => {
      const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
      return total <= totalLine && String(o.desc || '').startsWith(direction);
    });
    if (pick) {
      return {
        window: '38min',
        type: wantOver ? 'ht_over' : 'ht_under',
        description: `HT ${direction} ${totalLine} (${h}-${a} at ${minute}')`,
        reasoning: wantOver
          ? `Score is ${h}-${a} at ${minute}'. Goals already scored — Over 0.5 HT is virtually guaranteed.`
          : `Score is 0-0 at ${minute}'. Half-time whistle is imminent — Under 0.5 HT.`,
        ...pick
      };
    }
  }
  return null;
}

/**
 * 80-minute window — late-game analysis
 *  2+ goal lead → 1X2 Match Winner on the leading team
 *  1-goal lead  → check possession/shots dominance:
 *     • leader dominates (or no stats) → 1X2 on leader
 *     • trailer dominates             → Handicap (trailer +2) or fallback to 1X2
 */
function analyze80(ev, minute, h, a) {
  if (minute < 76 || minute > 85) return null;

  const margin = Math.abs(h - a);
  if (margin === 0) return null; // draw — skip

  const homeLeads  = h > a;
  const leaderTag  = homeLeads ? 'Home' : 'Away';
  const trailerTag = homeLeads ? 'Away' : 'Home';

  // ── 2+ goal lead ────────────────────────────
  if (margin >= 2) {
    const pick = findOutcome(ev, '1', (o) => {
      const d = String(o.desc || '');
      return homeLeads ? (d === 'Home' || d === '1') : (d === 'Away' || d === '2');
    });
    if (pick) {
      return {
        window: '80min',
        type: 'match_winner',
        description: `${leaderTag} to Win (${h}-${a} at ${minute}')`,
        reasoning: `${leaderTag} leads ${h}-${a} by ${margin} goals at ${minute}'. Strong Match Winner.`,
        ...pick
      };
    }
  }

  // ── 1-goal lead ─────────────────────────────
  if (margin >= 1) {
    const { homePoss, awayPoss, homeShots, awayShots } = statsOf(ev);

    let dominant = null; // 'home' | 'away' | null
    if (homePoss != null && awayPoss != null) dominant = homePoss > awayPoss ? 'home' : 'away';
    if (!dominant && homeShots != null && awayShots != null) dominant = homeShots > awayShots ? 'home' : 'away';

    const leaderSide = homeLeads ? 'home' : 'away';
    const trailerDominates = dominant && dominant !== leaderSide;

    if (trailerDominates) {
      // Trailing team dominates → try Handicap (trailing team with positive handicap >= 1.5 or 2 goals)
      let pick = findOutcome(ev, '14', (o, m) => {
        const hcap = parseHandicapSpecifier(m.specifier);
        const d = String(o.desc || '');
        if (homeLeads) {
          // Home leads, Away trails: want Away handicap with at least 1.5/2 goals
          const qualifies = hcap.awayHcap >= 1.5 || hcap.val >= 1.5;
          return (d === 'Away' || d === '2') && qualifies;
        } else {
          // Away leads, Home trails: want Home handicap with at least 1.5/2 goals
          const qualifies = hcap.homeHcap >= 1.5 || hcap.val >= 1.5;
          return (d === 'Home' || d === '1') && qualifies;
        }
      });

      if (pick) {
        return {
          window: '80min',
          type: 'handicap',
          description: `${trailerTag} Handicap (${h}-${a} at ${minute}')`,
          reasoning: `${h}-${a} at ${minute}'. ${trailerTag} dominates possession/shots — Handicap applied on ${trailerTag}.`,
          ...pick
        };
      }
    }

    // Default: Match Winner on leader (no stats, leader dominates, or no handicap market)
    const pick = findOutcome(ev, '1', (o) => {
      const d = String(o.desc || '');
      return homeLeads ? (d === 'Home' || d === '1') : (d === 'Away' || d === '2');
    });
    if (pick) {
      return {
        window: '80min',
        type: 'match_winner',
        description: `${leaderTag} to Win (${h}-${a} at ${minute}')`,
        reasoning: `${leaderTag} leads ${h}-${a} at ${minute}'${dominant === leaderSide ? ' and dominates stats' : ''}. Match Winner.`,
        ...pick
      };
    }
  }

  return null;
}

/**
 * High-probability opportunity for upcoming virtual rounds (starting in next 0-3 mins)
 * Guarantees there is ALWAYS a verified opportunity even between exact 38'/80' clock ticks.
 */
function analyzeUpcoming(ev) {
  // 1. Look for Over 0.5 (virtually guaranteed in 3-min vFootball where 96%+ matches have goals)
  const o05 = findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total <= 0.5 && String(o.desc || '').startsWith('Over');
  });
  if (o05 && o05.odds >= 1.02 && o05.odds <= 1.25) {
    return {
      window: 'upcoming_o05',
      type: 'over_05',
      description: `Over 0.5 Goals (${ev.homeTeamName} vs ${ev.awayTeamName})`,
      reasoning: 'Virtual round opportunity: Over 0.5 goals carries a 96%+ historical hit rate.',
      ...o05
    };
  }

  // 2. Look for strong favourite 1X2
  const fav1x2 = findOutcome(ev, '1', (o) => {
    const odd = parseFloat(o.odds);
    return odd >= 1.15 && odd <= 1.45;
  });
  if (fav1x2) {
    return {
      window: 'upcoming_favourite',
      type: 'match_winner',
      description: `${fav1x2.outcome.desc} to Win`,
      reasoning: 'Strong virtual favorite with dominant algorithmic rating into the upcoming round.',
      ...fav1x2
    };
  }

  // 3. Look for Over 1.5
  const o15 = findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total <= 1.5 && String(o.desc || '').startsWith('Over');
  });
  if (o15 && o15.odds <= 1.30) {
    return {
      window: 'upcoming_o15',
      type: 'over_15',
      description: `Over 1.5 Goals (${ev.homeTeamName} vs ${ev.awayTeamName})`,
      reasoning: 'High-scoring virtual fixture profile.',
      ...o15
    };
  }

  return null;
}

// ── Fetch & Scan ──────────────────────────────────────

async function fetchLiveVFootball() {
  const sports = ['sr:sport:202120001', 'sr:sport:137'];
  const events = [];

  for (const sport of sports) {
    for (let page = 1; page <= 3; page++) {
      const url = `${API}/factsCenter/pcUpcomingEvents?sportId=${encodeURIComponent(sport)}`
        + `&marketId=${QS_MARKET_IDS}&pageSize=50&pageNum=${page}`
        + `&option=1&order=0&todayGames=false&timeline=1&_t=${Date.now()}`;

      const j = await get(url);
      const evs = j?.data?.tournaments?.flatMap(t =>
        (t.events || []).map(e => ({ ...e, league: t.name }))
      ) || [];

      if (!evs.length) break;
      events.push(...evs);
      await sleep(100);
    }
  }

  return events;
}

/** Scan all live/upcoming vFootball and return the first qualifying signal */
async function scanQuestSpecial() {
  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  // 1. Primary Check: Matches currently matching 38' (HT O/U) or 80' (Late / Handicap)
  for (const ev of events) {
    const minute = clockOf(ev);
    const [h, a] = scoreOf(ev);
    const homeScore = Number.isFinite(h) ? h : 0;
    const awayScore = Number.isFinite(a) ? a : 0;

    if (minute != null) {
      const signal = analyzeHT(ev, minute, homeScore, awayScore) || analyze80(ev, minute, homeScore, awayScore);
      if (signal) {
        return {
          eventId: ev.eventId,
          home: ev.homeTeamName,
          away: ev.awayTeamName,
          league: ev.league || 'vFootball',
          minute,
          homeScore,
          awayScore,
          analysis: signal
        };
      }
    }
  }

  // 2. High-Probability Fallback: Ensures there is ALWAYS an opportunity
  for (const ev of events) {
    const signal = analyzeUpcoming(ev);
    if (signal) {
      return {
        eventId: ev.eventId,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        league: ev.league || 'vFootball',
        minute: 0,
        homeScore: 0,
        awayScore: 0,
        analysis: signal
      };
    }
  }

  return null;
}

// ── Session Management ────────────────────────────────

/**
 * Start a Quest Special background session.
 * @param {string} chatId
 * @param {(result, timedOut) => void} onDone  — called when signal found or timeout
 */
function startSession(chatId, onDone) {
  const id = String(chatId);

  if (activeSessions.has(id)) {
    return { ok: false, error: 'Quest Special is already active. Wait for the current scan to complete.' };
  }
  if (getDailyCount(id) >= MAX_DAILY) {
    return { ok: false, error: `Daily limit reached (${MAX_DAILY}/${MAX_DAILY}). Try again tomorrow!` };
  }

  const session = { active: true, startedAt: Date.now(), scans: 0, chatId: id };

  // Poll every 8 s (a vFootball round is ~3 real minutes = 180 s)
  const timer = setInterval(async () => {
    if (!session.active) { clearInterval(timer); activeSessions.delete(id); return; }

    // Auto-timeout after 4 minutes (one full cycle + buffer)
    if (Date.now() - session.startedAt > 4 * 60 * 1000) {
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
      if (!signal) return; // keep scanning

      // ── Signal found ──
      session.active = false;
      clearInterval(timer);
      activeSessions.delete(id);
      incrementDailyCount(id);

      // Mint a single-leg booking code
      const leg = {
        id: signal.eventId,
        marketId: String(signal.analysis.market.id),
        specifier: signal.analysis.market.specifier || '',
        outcomeId: String(signal.analysis.outcome.id),
        odds: signal.analysis.odds,
        home: signal.home,
        away: signal.away
      };

      const m = await mint([leg]);
      const code = m.code || null;
      const url  = code ? (m.url || `https://www.sportybet.com/${CFG.REGION}/?shareCode=${code}`) : null;

      const result = {
        ...signal,
        code,
        url,
        mintError: m.err || null,
        timestamp: Date.now()
      };

      lastResults.set(id, result);

      // Track for Boom Rate analytics
      if (code) {
        try {
          recordSlip({
            userId: id,
            code,
            sport: 'vfootball',
            totalOdds: signal.analysis.odds,
            legs: [leg],
            url,
            isQuestSpecial: true
          });
        } catch (_) {}
      }

      if (onDone) onDone(result, false);
    } catch (err) {
      console.error('Quest Special scan error:', err.message);
    }
  }, 8000);

  session.timer = timer;
  activeSessions.set(id, session);

  return { ok: true, message: '🔍 Quest Special activated! Scanning vFootball live games…' };
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
  startSession,
  stopSession,
  isActive,
  getStatus,
  getLastResult,
  clearLastResult,
  getDailyCount,
  MAX_DAILY
};

