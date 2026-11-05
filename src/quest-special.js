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

// Target market IDs for Quest Special:
// 1 = 1X2 Match Winner
// 14 = Handicap
// 18 = Full Time Over/Under
// 60 = 1st Half 1X2
// 68 = 1st Half Over/Under
const QS_MARKET_IDS = '1,14,18,60,68';

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
  if (typeof ev.playedSeconds === 'string' && ev.playedSeconds.includes(':')) {
    const [pMin, pSec] = ev.playedSeconds.split(':').map(Number);
    if (!isNaN(pMin) && !isNaN(pSec)) {
      const totalSec = pMin * 60 + pSec;
      return (totalSec / 180) * 90;
    }
  }
  const m = /(\d{1,3})/.exec(String(ev.matchStatus || ''));
  if (m) return Number(m[1]);

  // Calculate virtual minute from elapsed kickoff time in a 3-minute (180s) virtual round
  if (ev.estimateStartTime) {
    const elapsedSec = (Date.now() - Number(ev.estimateStartTime)) / 1000;
    // 180 seconds real time = 90 virtual minutes (1 virtual minute = 2 real seconds)
    if (elapsedSec >= 0 && elapsedSec <= 185) {
      return (elapsedSec / 180) * 90;
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
  const colon = /handicap=(\d+):(\d+)/i.exec(specifier) || /hcp=(\d+):(\d+)/i.exec(specifier);
  if (colon) {
    return {
      homeHcap: Number(colon[1]),
      awayHcap: Number(colon[2]),
      val: Math.max(Number(colon[1]), Number(colon[2]))
    };
  }
  const dec = /handicap=([+-]?[\d.]+)/i.exec(specifier) || /hcp=([+-]?[\d.]+)/i.exec(specifier);
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

// ── Exact Quest Special Timing Rules ───────────────────

/**
 * Rule 1: 41-minute window to Half Time → Dynamic Under line
 * Trigger: ~41' (Window: 38.0' – 42.5', ~76s - 85s into 3-min round)
 * Target: Under (currentGoals + 0.5)
 *  • 0-0  → Under 0.5 HT
 *  • 1-0  → Under 1.5 HT
 *  • 1-1+ → Under 2.5 HT
 */
function analyze41_HTUnder(ev, minute, h, a) {
  if (minute < 38.0 || minute > 42.5) return null;

  const currentGoals = (h || 0) + (a || 0);
  const targetLine = currentGoals + 0.5;

  // Market 68: 1st Half - Over/Under with total = targetLine, Outcome Under
  const pick = findOutcome(ev, '68', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return Math.abs(total - targetLine) < 0.1 && String(o.desc || '').startsWith('Under');
  }) || findOutcome(ev, '68', (o, m) => {
    // Closest line >= targetLine
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total >= targetLine && total <= targetLine + 1.0 && String(o.desc || '').startsWith('Under');
  }) || findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total <= targetLine && String(o.desc || '').startsWith('Under');
  });

  if (pick) {
    const line = (/total=([\d.]+)/.exec(pick.market.specifier || '') || [])[1] || String(targetLine);
    return {
      window: '41min_ht_under',
      type: 'ht_under',
      description: `1st Half Under ${line} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(minute)}')`,
      reasoning: `Score is ${h}-${a} at ${Math.round(minute)}'. Half-time whistle is imminent — 1st Half Under ${line}.`,
      ...pick
    };
  }
  return null;
}

/**
 * Rule 2: 43-minute window → Winner of H1 or 1st Half Draw
 * Trigger: ~43' (Window: 42.0' – 45.5', ~84s - 91s into 3-min round)
 *  • If tied (0-0, 1-1) → 1st Half Draw (X)
 *  • If team leads      → 1st Half Winner on leading team
 */
function analyze43_H1Winner(ev, minute, h, a) {
  if (minute < 42.0 || minute > 45.5) return null;

  const margin = (h || 0) - (a || 0);
  const isTied = margin === 0;
  const homeLeads = margin > 0;
  const awayLeads = margin < 0;

  // Market 60: 1st Half - 1X2
  const pick = findOutcome(ev, '60', (o) => {
    const d = String(o.desc || '');
    if (isTied) return d === 'Draw' || d === 'X' || String(o.id) === '2';
    if (homeLeads) return d === 'Home' || d === '1' || String(o.id) === '1';
    if (awayLeads) return d === 'Away' || d === '2' || String(o.id) === '3';
    return false;
  }) || findOutcome(ev, '60', (o) => {
    const odd = parseFloat(o.odds);
    return odd <= 2.20;
  });

  if (pick) {
    const pickName = isTied ? '1st Half Draw' : `1st Half Winner: ${pick.outcome.desc}`;
    return {
      window: '43min_h1_winner',
      type: isTied ? 'h1_draw' : 'h1_winner',
      description: `${pickName} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(minute)}')`,
      reasoning: isTied
        ? `Match is tied ${h}-${a} at ${Math.round(minute)}'. Whistle is imminent — 1st Half Draw (X).`
        : `${homeLeads ? 'Home' : 'Away'} leads ${h}-${a} at ${Math.round(minute)}'. Closing 1st Half lock.`,
      ...pick
    };
  }
  return null;
}

/**
 * Rule 3: 85-minute window to Full Time → Dynamic FT Under
 * Trigger: ~85' (Window: 82.0' – 87.0', ~164s - 174s into 3-min round)
 * Target: Under (currentGoals + 0.5)
 *  • 0-0  → Under 0.5 FT
 *  • 1-0  → Under 1.5 FT
 *  • 1-1  → Under 2.5 FT
 *  • 2-1+ → Under 3.5 FT
 */
function analyze85_FTUnder(ev, minute, h, a) {
  if (minute < 82.0 || minute > 87.0) return null;

  const currentGoals = (h || 0) + (a || 0);
  const targetLine = currentGoals + 0.5;

  // Market 18: Full Time Over/Under closest to targetLine
  const pick = findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return Math.abs(total - targetLine) < 0.1 && String(o.desc || '').startsWith('Under');
  }) || findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total >= targetLine && total <= targetLine + 1.0 && String(o.desc || '').startsWith('Under');
  }) || findOutcome(ev, '18', (o, m) => {
    const total = parseFloat((/total=([\d.]+)/.exec(m.specifier || '') || [])[1] || 0);
    return total <= 2.5 && String(o.desc || '').startsWith('Under');
  });

  if (pick) {
    const line = (/total=([\d.]+)/.exec(pick.market.specifier || '') || [])[1] || String(targetLine);
    return {
      window: '85min_ft_under',
      type: 'ft_under',
      description: `Full Time Under ${line} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(minute)}')`,
      reasoning: `Score is ${h}-${a} at ${Math.round(minute)}'. Imminent Full Time whistle — Safe Under ${line}.`,
      ...pick
    };
  }
  return null;
}

/**
 * Rule 4: 88-minute window to Full Time → FT Draw, 1X2 Winner, or Handicap
 * Trigger: ~88' (Window: 86.5' – 90.0', ~173s - 180s into 3-min round)
 *  • Tied (0-0, 1-1, etc.) → Full Time Draw (X) in Market 1
 *  • 2+ goal lead          → 1X2 Match Winner on leading team in Market 1
 *  • 1-goal lead           → Handicap (+1.5 / +2.0 cushion) or 1X2 on leader
 */
function analyze88_LateLead(ev, minute, h, a) {
  if (minute < 86.5 || minute > 90.0) return null;

  const margin = Math.abs((h || 0) - (a || 0));
  const isTied = margin === 0;
  const homeLeads = (h || 0) > (a || 0);
  const awayLeads = (a || 0) > (h || 0);
  const leaderTag = homeLeads ? 'Home' : 'Away';

  // ── Case 1: Tied game at 87'-88' → Full Time Draw (X) ──
  if (isTied) {
    const pickDraw = findOutcome(ev, '1', (o) => {
      const d = String(o.desc || '');
      return d === 'Draw' || d === 'X' || String(o.id) === '2';
    });
    if (pickDraw) {
      return {
        window: '88min_draw',
        type: 'match_draw',
        description: `Full Time Draw (X) (${h}-${a} at ${Math.round(minute)}')`,
        reasoning: `Match is tied ${h}-${a} at ${Math.round(minute)}'. Full time whistle is imminent — Full Time Draw (X).`,
        ...pickDraw
      };
    }
  }

  // ── Case 2: 2+ goal lead: 1X2 Match Winner ──────────────────────
  if (margin >= 2) {
    const pick1x2 = findOutcome(ev, '1', (o) => {
      const d = String(o.desc || '');
      return homeLeads ? (d === 'Home' || d === '1' || String(o.id) === '1') : (d === 'Away' || d === '2' || String(o.id) === '3');
    });
    if (pick1x2) {
      return {
        window: '88min_lead',
        type: 'match_winner_2lead',
        description: `${leaderTag} to Win (${h}-${a} at ${Math.round(minute)}')`,
        reasoning: `${leaderTag} holds a 2+ goal lead (${h}-${a}) at ${Math.round(minute)}'. 1X2 Winner guaranteed.`,
        ...pick1x2
      };
    }
  }

  // ── Case 3: 1-goal lead: Handicap cushion or 1X2 Winner ─────────
  if (margin === 1) {
    const pickHcap = findOutcome(ev, '14', (o, m) => {
      const spec = String(m.specifier || '');
      if (homeLeads && (spec.includes('hcp=2:0') || spec.includes('hcp=1:0'))) {
        return String(o.desc || '').startsWith('Home') || String(o.id) === '1711';
      }
      if (awayLeads && (spec.includes('hcp=0:2') || spec.includes('hcp=0:1'))) {
        return String(o.desc || '').startsWith('Away') || String(o.id) === '1713';
      }
      return false;
    });

    if (pickHcap) {
      return {
        window: '88min_hcap',
        type: 'handicap_1lead',
        description: `${leaderTag} Handicap (${h}-${a} at ${Math.round(minute)}')`,
        reasoning: `${leaderTag} leads ${h}-${a} at ${Math.round(minute)}'. Secured with Handicap cushion.`,
        ...pickHcap
      };
    }

    // Fallback: 1X2 Match Winner on leader
    const pickLeader = findOutcome(ev, '1', (o) => {
      const d = String(o.desc || '');
      return homeLeads ? (d === 'Home' || d === '1' || String(o.id) === '1') : (d === 'Away' || d === '2' || String(o.id) === '3');
    });
    if (pickLeader) {
      return {
        window: '88min_1x2',
        type: 'match_winner_1lead',
        description: `${leaderTag} to Win (${h}-${a} at ${Math.round(minute)}')`,
        reasoning: `${leaderTag} leads ${h}-${a} at ${Math.round(minute)}'. Match Winner.`,
        ...pickLeader
      };
    }
  }

  // ── Case 4: Virtual Match (Score feed silent): Strong Favorite or Handicap Cushion ──
  const pickLate = findOutcome(ev, '1', (o) => {
    const odd = parseFloat(o.odds);
    return odd >= 1.10 && odd <= 1.85;
  }) || findOutcome(ev, '14', (o, m) => {
    const spec = String(m.specifier || '');
    return (spec.includes('hcp=2:0') || spec.includes('hcp=0:2')) && parseFloat(o.odds) <= 1.35;
  });

  if (pickLate) {
    return {
      window: '88min_late',
      type: 'late_security',
      description: `${pickLate.outcome.desc} (${ev.homeTeamName} vs ${ev.awayTeamName} at ${Math.round(minute)}')`,
      reasoning: `Live virtual match at ${Math.round(minute)}' (final whistle approach). Late game winning security.`,
      ...pickLate
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
      await sleep(80);
    }
  }

  return events;
}

/**
 * Scan all live vFootball matches and return the first qualifying signal
 * matching strictly:
 *  1) 41' HT Under 0.5
 *  2) 43' Winner of H1
 *  3) 85' FT Under 0.5
 *  4) 88' FT Handicap / 1X2 Winner based on 2-goal or 1-goal lead
 * NOTE: Never returns generic pre-match Over 0.5 picks.
 */
async function scanQuestSpecial() {
  const events = await fetchLiveVFootball();
  if (!events.length) return null;

  for (const ev of events) {
    const minute = clockOf(ev);
    if (minute == null) continue;

    const [h, a] = scoreOf(ev);
    const homeScore = Number.isFinite(h) ? h : 0;
    const awayScore = Number.isFinite(a) ? a : 0;

    const signal = analyze41_HTUnder(ev, minute, homeScore, awayScore)
      || analyze43_H1Winner(ev, minute, homeScore, awayScore)
      || analyze85_FTUnder(ev, minute, homeScore, awayScore)
      || analyze88_LateLead(ev, minute, homeScore, awayScore);

    if (signal) {
      return {
        eventId: ev.eventId,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        league: ev.league || 'vFootball',
        minute: Math.round(minute),
        homeScore,
        awayScore,
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

  // Poll every 3 seconds for active virtual matches
  const timer = setInterval(async () => {
    if (!session.active) { clearInterval(timer); activeSessions.delete(id); return; }

    // Auto-timeout after 10 minutes (allows spanning multiple scheduled virtual rounds)
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
  }, 4000);

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
  startSession,
  stopSession,
  isActive,
  getStatus,
  getLastResult,
  clearLastResult,
  getDailyCount,
  MAX_DAILY
};
