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
