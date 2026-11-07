# sb-codes — SportyBet Daily Booking-Code Generator

Daily SportyBet booking-code generator with safety ranking and Telegram delivery.

Repo-ready, modular architecture with **zero external dependencies** — runs on vanilla Node.js 20+ using built-in `fetch` and standard library modules.

> Booking codes are **non-staking**. This never places a wager or touches money. You open each code and stake manually.

---

## Contents

1. [File Layout](#file-layout)
2. [How It Works](#how-it-works)
3. [Requirements](#requirements)
4. [Setup & Quick Start](#setup--quick-start)
5. [Telegram Setup](#telegram-setup)
6. [LLM Setup](#llm-setup)
7. [Configuration (`.env`)](#configuration-env)
8. [Run Modes](#run-modes)
9. [GitHub Actions Automation](#github-actions-automation)
10. [Troubleshooting](#troubleshooting)
11. [Tuning](#tuning)
12. [Caveats & Responsible Betting](#caveats--responsible-betting)
13. [License](#license)

---

## File Layout

```
.
├── bin/
│   └── sb.js                     # CLI executable entrypoint
├── src/
│   ├── config.js                 # Environment variable parsing & runtime config
│   ├── constants.js              # Market IDs, labels, weights & junk tournament regex
│   ├── util.js                   # Timezone calculations (Africa/Lagos) and timing helpers
│   ├── api.js                    # SportyBet HTTP client (fetch wrapper with retry)
│   ├── scan.js                   # Upcoming match scraper, filtering & heuristic scoring
│   ├── rank.js                   # LLM re-ranking using OpenAI-compatible API
│   ├── mint.js                   # Booking code generation with exponential backoff & chunk splitting
│   ├── notify.js                 # Telegram bot messaging
│   └── index.js                  # Pipeline coordinator and CLI flow controller
├── .github/
│   └── workflows/
│       └── daily.yml             # Scheduled GitHub Actions workflow (05:00 UTC / 06:00 Lagos)
├── .env.example                  # Environment configuration template
├── .gitignore                    # Git exclusions
├── package.json                  # Project manifest with npm scripts
├── LICENSE                       # MIT License
└── README.md                     # Documentation
```

---

## How It Works

1. Scans `pcUpcomingEvents` for football fixtures from **00:00 today (Africa/Lagos)** onward.
2. Keeps one leg per match inside the configured odds band (`1.05`–`1.25` by default), prioritizing Double chance (1X/X2) on heavy favorites over riskier markets.
3. Scores every leg `(1 / odds) × marketWeight`, caps any single league at `LEAGUE_CAP`, and filters out simulated competitions (e-soccer, SRL, virtual).
4. Optionally sends candidates to an LLM (Gemini 2.0 Flash / DeepSeek) to re-rank safest-first.
5. Mints booking codes via `POST /api/{region}/orders/share` in batches of up to 50 legs, with stepped backoff on rate limits (`429` / `19411`) and binary chunk splitting on failure.
6. Writes generated codes to `codes/YYYY-MM-DD.txt` and sends them to Telegram.

Booking is **anonymous** — no account, no cookie, and no API key required. SportyBet's `/orders/share` endpoint creates a shareable booking code and stakes nothing.

### Endpoints Used

| Purpose | Endpoint | Method |
|---|---|---|
| Fixtures, markets, odds | `/api/{region}/factsCenter/pcUpcomingEvents` | GET |
| Create booking code | `/api/{region}/orders/share` | POST |

Required headers: `accept: application/json`, `content-type: application/json`, `current-country: {REGION}`.

---

## Requirements

- Node.js **20+** (`node -v`)
- Telegram bot token & chat ID (free)
- LLM API key (optional; Gemini 2.0 Flash has a free tier)

---

## Setup & Quick Start

1. **Clone repository:**
   ```bash
   git clone https://github.com/WrightDevs/sportybetcodeautomation.git
   cd sportybetcodeautomation
   ```

2. **Copy `.env.example` to `.env`:**
   ```bash
   cp .env.example .env
   ```

3. **Smoke test your setup:**
   ```bash
   # 1. Verify Telegram delivery:
   npm run ping

   # 2. Dry run candidate scan without minting:
   npm run dry

   # 3. Test booking-code minting with a single match:
   npm run test-leg
   ```

4. **Run production generation:**
   ```bash
   npm start
   ```

---

## Telegram Setup

Both values are generated in Telegram. Never share or commit them.

1. Search **@BotFather**, open it, send `/newbot`.
2. Name it, then give it a username ending in `bot` (e.g. `my_sb_codes_bot`).
3. BotFather returns a token:
   ```
   Use this token to access the HTTP API:
   8123456789:AAHk3xQ9vT2mB8pL1nR7wY4sD6fG0jK5cVz
   ```
   That is `TG_TOKEN`.
4. Open your new bot and send it any message — `hi` is enough. **A bot cannot message you until you message it first.**
5. Read your chat ID back out:
   ```bash
   curl -s "https://api.telegram.org/bot<TG_TOKEN>/getUpdates"
   ```
   Find `"chat":{"id":123456789` — that number is `TG_CHAT`.

---

## LLM Setup

Free option via Google AI Studio:

1. Visit [Google AI Studio](https://aistudio.google.com/apikey) → **Create API key**.
2. Configure in `.env`:
   ```env
   LLM_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
   LLM_MODEL=gemini-2.0-flash
   LLM_KEY=your_gemini_api_key
   ```

DeepSeek, Groq, and OpenAI are drop-in compatible — simply change `LLM_URL`, `LLM_MODEL`, and `LLM_KEY`. To skip LLM re-ranking, leave `LLM_KEY` blank or set `USE_LLM=false`.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `REGION` | `gh` | SportyBet region: `gh` (Ghana) or `ng` (Nigeria) |
| `TG_TOKEN` | *empty* | Telegram Bot API token |
| `TG_CHAT` | *empty* | Telegram Chat or Channel ID |
| `LLM_URL` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `gemini-2.0-flash` | LLM model name |
| `LLM_KEY` | *empty* | API key for LLM |
| `MIN_ODDS` | `1.05` | Lower threshold for match odds |
| `MAX_ODDS` | `1.25` | Upper threshold for match odds |
| `TARGET` | `150` | Maximum candidate legs to harvest |
| `LEGS_PER_CODE` | `50` | Maximum legs per booking slip (capped at 50) |
| `MAX_CODES` | `4` | Maximum codes to generate |
| `GAP_MS` | `90000` | Delay between consecutive booking requests (ms) |
| `LEAGUE_CAP` | `6` | Maximum legs from any single league |
| `USE_LLM` | `true` | Set `false` to disable LLM ranking |

---

## Run Modes

| Command | Flag | Action |
|---|---|---|
| `npm start` | *(none)* | Full run: scans card, ranks, mints codes, outputs to `codes/YYYY-MM-DD.txt`, and delivers to Telegram |
| `npm run dry` | `--dry` | Scans and prints ranked picks to console without minting codes or messaging Telegram |
| `npm run test-leg` | `--test` | Tests minting on a single leg to verify API connectivity and regional validity |
| `npm run ping` | `--ping` | Sends a connectivity test message to Telegram |

---

## GitHub Actions Automation

A scheduled workflow is provided at [`.github/workflows/daily.yml`](.github/workflows/daily.yml).

- **Schedule**: Runs automatically every day at 05:00 UTC (06:00 Africa/Lagos time).
- **Manual Trigger**: Can be run on-demand under GitHub Actions → **daily-codes** → **Run workflow**.

### Setup in GitHub:

1. Navigate to **Settings** → **Secrets and variables** → **Actions** in your GitHub repository.
2. Add secrets:
   - `TG_TOKEN` : Your Telegram Bot Token.
   - `TG_CHAT` : Your Telegram Chat ID.
   - `LLM_KEY` : (Optional) Your Gemini/DeepSeek API key.
3. If betting in Nigeria (`ng`), adjust `REGION: ng` in `.github/workflows/daily.yml`.

> [!NOTE]
> **Operational Notes:**
> - `.env` is gitignored — commit `.env.example` only. Never commit live bot tokens.
> - Scheduled Actions cron jobs can experience 5–20 minute timing drift during peak GitHub traffic.
> - GitHub disables scheduled workflows if the repository has no commits for 60 consecutive days.

---

## Quest Special safe selector

Quest Special is a **live vFootball sniper**. Selection is deterministic code (`src/selection/`); the LLM can only veto.

**Pipeline**
1. *Pool* - live events inside the firing window (HT: 40-43', FT: 80-86'), clock and score known, one leg per match, only `status 0` markets.
2. *Probability* - the remaining-goal rate is fitted from the match's own live Over/Under ladder (markets 18/68; team split from 19/20), then each leg is priced with a Poisson model of the remaining goals given the current score. The leg's own de-vigged market price is the cross-check; the leg probability is the **lower** of the two. Nothing is hard-coded or invented; if the ladder is missing the match is skipped.
3. *Handicap first* - Handicap + Double Chance (+0.5) legs are tier 1 and always preferred. No GG (tier 2), Under (tier 3) and straight results (tier 4) are fallbacks used only when no tier-1 leg survives, or to fill the remaining slots of a multi-leg slip, and they must clear the stricter `SEL_MIN_FALLBACK_PROB` (0.85). `SEL_PREFER_HANDICAP=off` restores pure safety-score ranking.
4. *Hard filters* - `MIN_LEG_PROB`, odds band, coherence (|model - market| <= tol), straight wins only when no Double Chance survives and prob >= `MIN_WIN_PROB`.
5. *Score 0-100* - probability (70%), coherence (15%), market-type safety (10%), league (5%).
6. *Slip* - top `legs` legs, no shared teams, joint probability (product) must be >= `MIN_SLIP_PROB`, else **"no safe slip"** and the scan keeps going. Reserves are kept for replacement.
7. *Veto* - multi-leg only, 2s, fail-open, may only drop a leg; a dropped leg is replaced from reserves and the bar re-checked.
8. *Booking* - `POST /orders/share` only. No staking code path exists.

**Time window.** `MARKET_WINDOW = { HT: 40, FT: 80 }` (`src/selection/config.js`) is the *effective playing time*. The firing window is centred on it, and the scoring exposure of the remaining time is multiplied by END/W (45/40 for HT, 90/80 for FT), so the model deliberately assumes more risk than the raw clock. Set `SEL_TIME_SCALING=off` for the raw clock, or change `SEL_WINDOW_HT/FT`.

**Config** (env, defaults): `SEL_MIN_LEG_PROB` 0.78, `SEL_MIN_LEG_ODDS` 1.10, `SEL_MAX_LEG_ODDS` 1.35, `SEL_MIN_SLIP_PROB` 0.45, `SEL_COHERENCE_TOL` 0.10, `SEL_MIN_WIN_PROB` 0.85, `SEL_MIN_FALLBACK_PROB` 0.85, `SEL_PREFER_HANDICAP` on, `SEL_WINDOW_HT` 40, `SEL_WINDOW_FT` 80, `SEL_TIME_SCALING` on, `SEL_VETO_TIMEOUT_MS` 2000.

Note: a 5-leg slip needs an average leg probability of about 0.85 to clear `MIN_SLIP_PROB` 0.45 (0.78^5 = 0.29), so 5-leg requests will often return "no safe slip". That is intended.

**Calibration.** Every minted slip logs its legs to `data/selection-log.jsonl`. `npm run settle` settles them from final results and prints hit rate per market type and per 5% probability bucket plus the Brier score (lower is better; always predicting 0.8 and hitting 80% gives 0.16). Calibrated means hit rate ~= predicted in each bucket. If a bucket under-performs, raise `SEL_MIN_LEG_PROB`. `node bin/settle.js --backtest 0.85` replays settled legs under a stricter threshold. Tests: `npm test`.

A slip is "high probability", never guaranteed.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no candidates in band` | Odds band too tight for today's card | Raise `MAX_ODDS` to 1.30 or 1.35 |
| `404` on every call | `REGION` does not match site | Set `gh` (Ghana) or `ng` (Nigeria) |
| `19411` repeatedly | SportyBet rate limiting per IP | Increase `GAP_MS=180000`, reduce `MAX_CODES=2` |
| `19001` / `400` | Slip payload rejected | Check match start times or suspended markets |
| No Telegram message | Wrong `TG_CHAT` or bot never messaged | Redo step 4 & 5 under [Telegram Setup](#telegram-setup) |
| `llm failed` | Invalid key or network timeout | Heuristic safety order kept automatically |
| Codes short of 50 legs | Too few matches in band | Raise `TARGET` or widen odds band |

---

## Tuning

- **Codes that actually land:** Set `LEGS_PER_CODE=15`, `MAX_CODES=8`.
- **Higher volume:** Set `MAX_ODDS=1.35`, `TARGET=250`.
- **Lower exposure to obscure leagues:** Set `LEAGUE_CAP=3`.
- **Skip the LLM entirely:** Set `USE_LLM=false`.
- **Ultra-short odds:** Set `MIN_ODDS=1.01`, `MAX_ODDS=1.15`.

*Note: Fifty legs at ~1.15 average is roughly 1,000/1 — an accumulator lottery ticket. Fifteen legs at the same average is ~8/1 and far more probable.*

---

## Caveats & Responsible Betting

- **Codes expire:** SportyBet booking codes expire over time as events begin. Open and load them on the day of generation.
- **Odds fluctuate:** Lines move between scan and mint. If a market gets suspended, the batch retry split halves the payload to preserve the rest of the slip.
- **Morning cards:** Early morning cards have fewer markets posted; candidate density increases as kickoff approaches.
- **No staking:** This software only produces booking codes. No money is deposited, wagered, or handled.
- Betting involves financial risk. Gamble responsibly.

---

## License

This project is licensed under the [MIT License](LICENSE).

## Normal football: tiered safe slips

`src/selection/football.js` (+ `src/safe-football.js`) replaces the old "lowest odds in band" scan for the Football preset
(`FB_LEGACY=on` restores it). For every upcoming match it fits a Poisson goal model to the de-vigged 1X2 and
over/under ladder, prices each candidate (Handicap on the head-start side, Double Chance 1X/X2, No GG, Under 3.5+,
straight win) and uses `min(model, de-vigged market)` as the leg probability. Legs failing the odds band, junk-league,
coherence (`FB_COHERENCE_TOL`) or probability bars are dropped. Handicap/Double Chance are preferred; No GG, Under and
straight wins need a stricter bar.

Four tiers are built (one leg per match, no shared teams, per-league cap, max `FB_MAX_LEGS`=50 legs): **Rookie** (4 legs, joint >= 0.60, handicap family only), **Hustler** (8 legs, joint >= 0.30), **High Roller** (~@10) and **Legend** (>= @100, up to 50 legs). High Roller and Legend pick the most odds per unit of risk and are flagged `highRisk`; if 50 legs cannot reach the target odds the tier is simply absent. A tier that cannot clear its bar returns "no safe slip" instead of lowering it. Odds are re-fetched right before minting and legs that moved more than `FB_MAX_MOVE` are dropped. User-facing text (`lines`, bot messages) shows no probabilities; the API payload keeps `jointProb` and the selection log keeps every number for calibration. Booking codes only; nothing is staked. Legend realistically hits well under 1% of the time.

Limits: probabilities come from market prices (no team form/injury data yet), so they cannot beat the market; the
independent-Poisson model understates draws (the coherence check covers this); safe legs sit at odds ~1.03-1.30 so the
Rookie pays little (~@1.1-1.3). Calibrate with `npm run settle -- --report` after some days of logged slips.
