'use strict';
// Single source of truth for every selection threshold. All overridable via env (SEL_*).
const num = (k, d) => {
  const v = process.env[k];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/*
 * TIME WINDOW (product spec: 40 min for half-time markets, 80 min for full-time markets).
 * Interpretation used: MARKET_WINDOW is the EFFECTIVE playing time. The sniper fires in a span
 * around that minute (see WINDOW_SPAN), and the goal exposure of the remaining time is scaled by
 * END/W (HT 45/40, FT 90/80): every remaining minute is treated as carrying 12.5% / 12.5% more
 * scoring risk than the raw clock says, leaving a deliberate safety buffer instead of assuming
 * a full 45/90. To change: edit MARKET_WINDOW, or set SEL_TIME_SCALING=off for the raw clock.
 */
const MARKET_WINDOW = {
  HT: num('SEL_WINDOW_HT', 40),
  FT: num('SEL_WINDOW_FT', 80)
};
const MATCH_END = { HT: 45, FT: 90 };
// Firing span relative to MARKET_WINDOW: selection opens AT minute 40 (HT) and 80 (FT) and closes at 43 / 86.
const WINDOW_SPAN = { HT: [0, 3], FT: [0, 6] };

const SELECTION = {
  MARKET_WINDOW,
  MATCH_END,
  WINDOW_SPAN,
  TIME_SCALING: (process.env.SEL_TIME_SCALING || 'on') !== 'off',

  MIN_LEG_PROB: num('SEL_MIN_LEG_PROB', 0.78),
  MIN_LEG_ODDS: num('SEL_MIN_LEG_ODDS', 1.10),
  MAX_LEG_ODDS: num('SEL_MAX_LEG_ODDS', num('QUEST_MAX_ODDS', 1.35)),
  MIN_SLIP_PROB: num('SEL_MIN_SLIP_PROB', 0.45),
  COHERENCE_TOL: num('SEL_COHERENCE_TOL', 0.10),
  MAX_RESERVES: num('SEL_MAX_RESERVES', 5),
  // Straight win (1X2 home/away) needs at least this probability, and is rejected when a
  // Double Chance leg on the same match is available with an acceptable price.
  MIN_WIN_PROB: num('SEL_MIN_WIN_PROB', 0.85),

  LLM_VETO_TIMEOUT_MS: num('SEL_VETO_TIMEOUT_MS', 2000),

  // Higher = safer market type (used in the 0-100 safety score)
  TYPE_SAFETY: {
    ft_double_chance: 1.0, ht_double_chance: 1.0,
    ft_under_high: 1.0, ht_under_high: 1.0,   // Under >= 4.5 (FT) / >= 2.5 (HT)
    ft_under: 0.85, ht_under: 0.85,
    ft_handicap: 0.7, ht_handicap: 0.7,
    ft_nogg: 0.55, ht_nogg: 0.55,
    h1_winner: 0.35, match_winner_2lead: 0.35,
    h1_draw: 0.1, match_draw: 0.1
  },
  SCORE_WEIGHTS: { prob: 0.70, coherence: 0.15, type: 0.10, league: 0.05 },
  // Real-football junk leagues (virtual leagues are the product here, so only applied to non-virtual sports)
  JUNK_LEAGUE: /(friendl|youth|reserve|u-?(1[6-9]|2[0-3])\b|women|amateur)/i,

  LOG_FILE: process.env.SEL_LOG_FILE || null // null => data/selection-log.jsonl
};

module.exports = { SELECTION, MARKET_WINDOW };
