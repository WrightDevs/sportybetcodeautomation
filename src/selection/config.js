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

  // HANDICAP-FIRST: tier 1 (handicap + Double Chance +0.5) is always preferred; No GG / Under /
  // straight results are fallbacks used only when no tier-1 leg survives (or to fill remaining
  // multi-leg slots), and must clear the stricter MIN_FALLBACK_PROB. SEL_PREFER_HANDICAP=off
  // restores pure safety-score ranking.
  PREFER_HANDICAP: (process.env.SEL_PREFER_HANDICAP || 'on') !== 'off',
  MIN_FALLBACK_PROB: num('SEL_MIN_FALLBACK_PROB', 0.85),
  TIER: {
    ft_handicap: 1, ht_handicap: 1, ft_double_chance: 1, ht_double_chance: 1,
    ft_nogg: 2, ht_nogg: 2,
    ft_under: 3, ht_under: 3,
    h1_winner: 4, match_winner_2lead: 4, h1_draw: 4, match_draw: 4
  },
  TIER_FAMILY: { 1: 'handicap', 2: 'nogg', 3: 'under', 4: 'result' },
  // Preferred handicap LINE (head start given to the backed team, e.g. hcp=3:0 backing Home = +3), best first.
  // +3 is preferred over +2; if +3 is unavailable the next entries are tried. Lines not listed rank after the
  // list; Double Chance (+0.5) ranks last inside the handicap family. Probability bars still apply to every line.
  HCP_LINE_ORDER: (process.env.SEL_HCP_LINE_ORDER || '3,4,5,2,1').split(',').map(s => Number(s.trim())).filter(Number.isFinite),

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

// ── Normal (pre-match) football safe selector. All overridable via FB_* env. ──
const FOOTBALL = {
  HORIZON_HOURS: num('FB_HORIZON_HOURS', 18),      // only matches kicking off within this window
  MIN_LEAD_MIN: num('FB_MIN_LEAD_MIN', 15),        // skip matches starting sooner than this
  MIN_ODDS: num('FB_MIN_ODDS', 1.03),              // de-vigged probability only reaches ~0.90 at odds ~1.03-1.05
  MAX_ODDS: num('FB_MAX_ODDS', 1.30),              // default per-leg ceiling; a tier may widen it with maxLegOdds
  COHERENCE_TOL: num('FB_COHERENCE_TOL', 0.07),    // max |model - de-vigged market|
  MAX_FIT_RMSE: num('FB_MAX_FIT_RMSE', 0.05),      // goal-model must reproduce 1X2 + totals this well
  ALLOW_DC_12: (process.env.FB_ALLOW_DC_12 || 'off') === 'on', // "Home or Away" is not a safe shape by default
  MIN_WIN_PROB: num('FB_MIN_WIN_PROB', 0.90),      // straight 1X2 legs
  MIN_FALLBACK_PROB: num('FB_MIN_FALLBACK_PROB', 0.88), // No GG / Under legs (tier >= 2)
  MIN_UNDER_LINE: num('FB_MIN_UNDER_LINE', 3.5),   // never Under a low line
  MAX_MOVE: num('FB_MAX_MOVE', 0.05),              // drop legs whose odds moved > 5% before minting
  LEAGUE_CAP: num('FB_LEAGUE_CAP', 2),
  MAX_LEGS: num('FB_MAX_LEGS', 50),                // hard cap on legs per slip, every tier
  // Tier ids are API slugs; NAMES are display labels.
  TIERS: {
    rookie:      { legs: num('FB_ROOKIE_LEGS', 4),  minLegProb: num('FB_ROOKIE_MIN_PROB', 0.90),  minJoint: num('FB_ROOKIE_MIN_JOINT', 0.60),  families: ['handicap'] },
    hustler:     { legs: num('FB_HUSTLER_LEGS', 8), minLegProb: num('FB_HUSTLER_MIN_PROB', 0.84), minJoint: num('FB_HUSTLER_MIN_JOINT', 0.30), families: ['handicap', 'nogg', 'under', 'result'] },
    // Target-odds tiers are not probability-gated: they stop at the target odds (or MAX_LEGS) and are flagged highRisk.
    high_roller: { targetOdds: num('FB_HIGH_ROLLER_TARGET_ODDS', 10), minLegProb: num('FB_HIGH_ROLLER_MIN_PROB', 0.80), minJoint: 0, highRisk: true, leagueCap: num('FB_HIGH_ROLLER_LEAGUE_CAP', 3), families: ['handicap', 'nogg', 'under', 'result'] },
    legend:     { targetOdds: num('FB_LEGEND_TARGET_ODDS', 100), minLegProb: num('FB_LEGEND_MIN_PROB', 0.70), maxLegOdds: num('FB_LEGEND_MAX_LEG_ODDS', 1.40), leagueCap: num('FB_LEGEND_LEAGUE_CAP', 4), minJoint: 0, highRisk: true, families: ['handicap', 'nogg', 'under', 'result'] }
  },
  NAMES: { rookie: 'Rookie', hustler: 'Hustler', high_roller: 'High Roller', legend: 'Legend' },
  TIER: { handicap: 1, dc: 1, nogg: 2, under: 3, win: 4 },
  FAMILY: { handicap: 'handicap', dc: 'handicap', nogg: 'nogg', under: 'under', win: 'result' },
  JUNK_LEAGUE: /(friendl|youth|reserve|u-?(1[6-9]|2[0-3])\b|women|amateur|srl|esoccer|e-football|efootball|virtual|simulated|cyber)/i,
  LEGACY: (process.env.FB_LEGACY || 'off') === 'on'
};

module.exports = { SELECTION, MARKET_WINDOW, FOOTBALL };
