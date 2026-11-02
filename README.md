# sb.js — SportyBet daily booking-code generator

Generates fresh booking codes every morning from a VPS, filters the card to a short-odds band, ranks legs by safety, and delivers the codes to Telegram. Runs on plain Node with no browser, no login and no stored credentials.

> Booking codes are **non-staking**. This never places a wager or touches money. You open each code and stake manually.

---

## Contents

1. [How it works](#how-it-works)
2. [Requirements](#requirements)
3. [Setup](#setup)
4. [Configuration](#configuration)
5. [Telegram setup](#telegram-setup)
6. [LLM setup](#llm-setup)
7. [Run modes](#run-modes)
8. [Scheduling](#scheduling)
9. [Troubleshooting](#troubleshooting)
10. [Tuning](#tuning)
11. [File layout](#file-layout)
12. [Appendix A — sb.js](#appendix-a--sbjs)
13. [Appendix B — .env.example](#appendix-b--envexample)
14. [Caveats](#caveats)

---

## How it works

1. Scans `pcUpcomingEvents` for football fixtures from **00:00 today (Africa/Lagos)** onward.
2. Keeps one leg per match, inside the configured odds band, preferring Double chance → Draw no bet → team goals → totals.
3. Scores every leg `(1 / odds) × marketWeight`, caps any single league at `LEAGUE_CAP`, pushes simulated competitions to the back.
4. Optionally sends the top ~150 to an LLM to re-rank safest-first.
5. Mints codes via `POST /api/{region}/orders/share` in batches, with backoff and split-on-failure.
6. Writes codes to `codes/YYYY-MM-DD.txt` and sends them to Telegram.

Booking is **anonymous** — no account, no cookie, no API key. SportyBet's `/orders/share` endpoint creates a shareable code and stakes nothing.

### Endpoints used

| Purpose | Endpoint | Method |
|---|---|---|
| Fixtures, markets, odds | `/api/{region}/factsCenter/pcUpcomingEvents` | GET |
| Create booking code | `/api/{region}/orders/share` | POST |

Required headers: `accept: application/json`, `content-type: application/json`, `current-country: {REGION}`.

Reference: [UbongErnest/Sportybet-mcp](https://github.com/UbongErnest/Sportybet-mcp) — confirms the payload shape (`selections[]` of `{eventId, marketId, specifier, outcomeId}`) and that `data.shareCode` is the success field.

---

## Requirements

- Ubuntu 22.04 / 24.04 VPS, root SSH, 1 vCPU / 1 GB (Hetzner CX22, DigitalOcean, Vultr — ~$4/mo)
- Node.js **20+**
- Telegram account
- LLM API key (optional; Gemini has a free tier)

No GUI, no Chromium, no display.

---

## Setup

### 1. Provision and harden

```bash
ssh root@YOUR_IP
apt update && apt upgrade -y
apt install -y curl ca-certificates
```

### 2. Install Node 20

The distro package is too old for `fetch`.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v      # v20.x or higher
```

### 3. Create the project

```bash
mkdir -p /root/sb/codes && cd /root/sb
nano sb.js
```

Paste [Appendix A](#appendix-a--sbjs), `Ctrl+O`, `Enter`, `Ctrl+X`.

### 4. Write `.env`

```bash
nano /root/sb/.env
chmod 600 /root/sb/.env
```

Use [Appendix B](#appendix-b--envexample) as the template. Fill in the Telegram and LLM values from steps 5 and 6 below.

`REGION` must match the site you bet on — `gh` for Ghana, `ng` for Nigeria. If every call returns `404`, you have the wrong one.

### 5. Telegram setup

Both values are generated in Telegram. Never share them.

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

### 6. LLM setup

Free option, Google AI Studio:

1. `https://aistudio.google.com/apikey` → **Create API key**
2. Set in `.env`:
   ```env
   LLM_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
   LLM_MODEL=gemini-2.0-flash
   LLM_KEY=your_key
   ```

Gemini exposes an OpenAI-compatible endpoint, so no code change is needed. DeepSeek, Groq and OpenAI are drop-in — change the same three lines.

### 7. Test delivery

```bash
cd /root/sb && node sb.js --ping
```

Phone should buzz. If not, `TG_CHAT` is wrong — redo 5.4.

### 8. Dry run

```bash
node sb.js --dry
```

Prints ranked picks, mints nothing. Check that all times are later today, odds sit inside the band, and markets skew to Double chance and DNB.

### 9. Live single-leg test

```bash
node sb.js --test
```

Mints one code. Open it in the betslip to confirm it resolves. `404` → fix `REGION`. `19411` → wait 30 minutes, you've tested too fast.

### 10. Schedule

```bash
crontab -e
```

```cron
TZ=Africa/Lagos
0 6 * * * cd /root/sb && /usr/bin/node sb.js >> run.log 2>&1
```

`TZ` on its own line fires the job at 06:00 Lagos regardless of server clock. Use the path from `which node`.

### 11. Verify next morning

```bash
tail -30 /root/sb/run.log
ls /root/sb/codes/
```

Codes arrive in Telegram and land in `codes/YYYY-MM-DD.txt`.

---

## Configuration

All values live in `.env`, read on startup. Nothing is compiled in.

| Variable | Default | Meaning |
|---|---|---|
| `REGION` | `gh` | Site region. `gh` or `ng`. Must match where you bet. |
| `MIN_ODDS` | `1.05` | Lower odds bound. 1.01 legs are padding and drag the code. |
| `MAX_ODDS` | `1.25` | Upper odds bound. Raise to 1.35 if days come back empty. |
| `TARGET` | `150` | Candidates to collect before ranking. |
| `LEGS_PER_CODE` | `50` | Legs per code. 50 is the site maximum. |
| `MAX_CODES` | `4` | Codes per day. Upper bound is `MAX_CODES × LEGS_PER_CODE` legs used. |
| `GAP_MS` | `90000` | Delay between booking calls. Raise on throttling. |
| `LEAGUE_CAP` | `6` | Max legs from any one league. Lower = more diversity. |
| `USE_LLM` | `true` | `false` skips the model entirely and uses heuristic order. |
| `LLM_URL` | DeepSeek | OpenAI-compatible chat-completions endpoint. |
| `LLM_MODEL` | `deepseek-chat` | Model name. |
| `LLM_KEY` | — | Bearer token. Empty = LLM skipped, run continues. |
| `TG_TOKEN` | — | Bot token from BotFather. Empty = no delivery. |
| `TG_CHAT` | — | Your chat ID. Empty = no delivery. |

The script loads `.env` itself, so cron needs no shell gymnastics.

---

## Run modes

| Command | Behaviour |
|---|---|
| `node sb.js` | Full run — scan, rank, mint, deliver. |
| `node sb.js --dry` | Scan and print ranked picks. No codes. |
| `node sb.js --test` | Mint a single one-leg code. |
| `node sb.js --ping` | Send a Telegram test message. |

Always `--dry` before trusting a config change.

---

## Scheduling

Cron at 06:00 Lagos daily. Codes reach Telegram and `codes/`.

To catch an evening card as well:

```cron
TZ=Africa/Lagos
0 6 * * * cd /root/sb && /usr/bin/node sb.js >> run.log 2>&1
0 16 * * * cd /root/sb && /usr/bin/node sb.js >> run.log 2>&1
```

Housekeeping — add to the same crontab:

```cron
30 3 * * * find /root/sb/codes -mtime +30 -delete && truncate -s 2M /root/sb/run.log
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no candidates in band` | band too tight for the day's card | raise `MAX_ODDS` to 1.35 |
| `404` on every call | `REGION` doesn't match the site | set `gh` or `ng` |
| `19411` repeatedly | per-IP throttle | `GAP_MS=180000`, `MAX_CODES=2` |
| `19001` / `400` | payload rejected | `run.log` names the offending leg |
| No Telegram message | wrong `TG_CHAT`, or bot never messaged | redo 5.4 |
| `llm failed` | bad key or URL | run continues on heuristic order; fix later |
| Codes short of 50 legs | too few candidates | raise `TARGET`, widen band |
| `fetch is not defined` | Node < 18 | reinstall Node 20 |

`run.log` is the first place to look for anything unexpected.

---

## Tuning

- **Want codes that actually land:** `LEGS_PER_CODE=15`, `MAX_CODES=8`.
- **Need more volume:** `MAX_ODDS=1.35`, `TARGET=250`.
- **Less junk competitions:** `LEAGUE_CAP=3`.
- **Skip the model:** `USE_LLM=false`.
- **Very short odds only:** `MIN_ODDS=1.01`, and set the LLM prompt to favour the shortest end.

Fifty legs at ~1.15 is roughly 1,000/1 — a coin-flip per code. Fifteen legs at the same average is ~8/1 and far likelier to return.

---

## File layout

```
/root/sb/
├── sb.js            # the generator
├── .env             # secrets + config (chmod 600)
├── run.log          # cron output
└── codes/
    └── 2026-11-02.txt
```

`.env` is the only secret-bearing file. `codes/` and `run.log` are safe to back up.

---

## Appendix A — sb.js

```js
#!/usr/bin/env node
/* SportyBet daily code generator — anonymous API only */
const fs = require('fs');
const path = require('path');

/* ---- env ---- */
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
  }
}
const E = (k, d) => process.env[k] ?? d;
const N = (k, d) => Number(E(k, d));

const CFG = {
  REGION: E('REGION', 'gh').toLowerCase(),
  MIN_ODDS: N('MIN_ODDS', 1.05),
  MAX_ODDS: N('MAX_ODDS', 1.25),
  TARGET: N('TARGET', 150),
  LEGS_PER_CODE: Math.min(50, N('LEGS_PER_CODE', 50)),
  MAX_CODES: N('MAX_CODES', 4),
  GAP_MS: N('GAP_MS', 90000),
  LEAGUE_CAP: N('LEAGUE_CAP', 6),
  USE_LLM: E('USE_LLM', 'true') === 'true',
  LLM_URL: E('LLM_URL', 'https://api.deepseek.com/v1/chat/completions'),
  LLM_MODEL: E('LLM_MODEL', 'deepseek-chat'),
  LLM_KEY: E('LLM_KEY', ''),
  TG_TOKEN: E('TG_TOKEN', ''),
  TG_CHAT: E('TG_CHAT', ''),
  OUT_DIR: path.join(__dirname, 'codes'),
  DRY: process.argv.includes('--dry'),
  TEST: process.argv.includes('--test'),
  PING: process.argv.includes('--ping')
};

const TZ = 'Africa/Lagos';
const API = `https://www.sportybet.com/api/${CFG.REGION}`;
const HDR = { accept: 'application/json', 'current-country': CFG.REGION.toUpperCase(),
  platform: 'web', clientid: 'web' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayStart = () => Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + 'T00:00:00+01:00');
const dayEnd = () => dayStart() + 86399000;
const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

const MARKETS = ['10', '11', '1', '26', '36', '18', '29', '14'];
const DESC = { '1': '1X2', '10': 'Double chance', '11': 'Draw no bet', '18': 'Over/Under',
  '29': 'GG/NG', '26': 'Home goals', '36': 'Away goals', '14': 'Handicap' };
const WEIGHT = { '10': 1.00, '11': 0.95, '26': 0.90, '18': 0.88, '36': 0.85, '1': 0.70, '29': 0.60, '14': 0.55 };
const JUNK = /(srl|esoccer|e-football|efootball|virtual|simulated|instant|cyber)/i;

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400 * (i + 1));
  }
  return null;
}

async function post(body) {
  const r = await fetch(`${API}/orders/share`, {
    method: 'POST', headers: { ...HDR, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  let j = {}; try { j = JSON.parse(raw); } catch {}
  return { status: r.status, j, raw };
}

async function scan() {
  const lo = dayStart(), hi = dayEnd(), now = Date.now();
  const hours = Math.min(720, Math.max(1, Math.ceil((hi - now) / 36e5)));
  const seen = new Map();

  for (let page = 1; page <= 30; page++) {
    const j = await get(`${API}/factsCenter/pcUpcomingEvents?sportId=sr:sport:1`
      + `&marketId=${MARKETS.join(',')}&pageSize=100&pageNum=${page}`
      + `&option=1&order=0&todayGames=false&timeline=${hours}&_t=${Date.now()}`);
    const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name }))) || [];
    if (!evs.length) break;

    for (const { e, league } of evs) {
      if (seen.has(e.eventId)) continue;
      const ko = Number(e.estimateStartTime);
      if (ko < now + 60000 || ko > hi || ko < lo) continue;

      let best = null;
      for (const mid of MARKETS) {
        const m = (e.markets || []).find(x => String(x.id) === mid && x.status === 0);
        if (!m) continue;
        for (const o of (m.outcomes || [])) {
          const odd = parseFloat(o.odds);
          if (odd < CFG.MIN_ODDS || odd > CFG.MAX_ODDS) continue;
          if (o.isActive === 0 || o.isActive === '0') continue;
          const score = (1 / odd) * WEIGHT[mid];
          if (!best || score > best.score) best = { m, o, odd, score };
        }
        if (best) break;
      }
      if (!best) continue;

      seen.set(e.eventId, {
        id: e.eventId, ko, league, home: e.homeTeamName, away: e.awayTeamName,
        marketId: String(best.m.id), specifier: best.m.specifier || '',
        outcomeId: String(best.o.id), odds: best.odd,
        desc: DESC[String(best.m.id)] || '', score: best.score
      });
    }
    await sleep(300);
    if (seen.size >= CFG.TARGET * 3) break;
  }

  let legs = [...seen.values()].sort((a, b) => b.score - a.score);
  const perLeague = {};
  legs = legs.filter(l => {
    perLeague[l.league] = (perLeague[l.league] || 0) + 1;
    return perLeague[l.league] <= CFG.LEAGUE_CAP;
  });
  return legs.filter(l => !JUNK.test(l.league))
    .concat(legs.filter(l => JUNK.test(l.league)))
    .slice(0, CFG.TARGET);
}

async function llmRank(legs) {
  if (!CFG.USE_LLM || !CFG.LLM_KEY || legs.length < 10) return legs;
  const list = legs.map((l, i) => `${i}|${l.league}|${l.home} v ${l.away}|${l.desc} @${l.odds}`).join('\n');
  const prompt = `Pick the safest legs for a long accumulator.
Double chance on a strong favourite beats draw-no-bet, which beats over 0.5 goals. Avoid tight 1X2, GG/NG,
handicap lines and obscure or simulated competitions.
Return JSON only: {"order":[indices safest first]}. Each index exactly once.

${list}`;
  try {
    const r = await fetch(CFG.LLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.LLM_KEY}` },
      body: JSON.stringify({ model: CFG.LLM_MODEL, temperature: 0,
        messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    const order = JSON.parse((j.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/)?.[0] || '{}').order;
    if (!Array.isArray(order)) throw new Error('no order');
    const picked = order.map(i => legs[i]).filter(Boolean);
    console.log(`  llm re-ranked ${picked.length}`);
    return picked.concat(legs.filter((_, i) => !order.includes(i)));
  } catch (e) {
    console.log('  llm failed:', e.message, '— heuristic order kept');
    return legs;
  }
}

async function mint(legs) {
  const waits = [60000, 180000, 360000];
  for (let i = 0; i <= waits.length; i++) {
    const { status, j, raw } = await post({
      selections: legs.map(l => ({ eventId: l.id, marketId: l.marketId,
        specifier: l.specifier, outcomeId: l.outcomeId }))
    });
    const code = j?.data?.shareCode || j?.data?.bookingCode;
    if (code) return { code, url: j.data.shareURL || '' };
    const limited = status === 429 || j?.bizCode === 19411 || /rate limit/i.test(raw);
    if (limited && i < waits.length) { await sleep(waits[i]); continue; }
    if (!limited && legs.length > 8) {
      const h = Math.ceil(legs.length / 2);
      const a = await mint(legs.slice(0, h));
      if (!a.code) return a;
      await sleep(20000);
      const b = await mint(legs.slice(h));
      return b.code ? { code: a.code, extra: b.code } : a;
    }
    return { err: `${status} ${raw.slice(0, 160)}` };
  }
  return { err: 'limiter' };
}

async function telegram(text) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT) return;
  const r = await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CFG.TG_CHAT, text, disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log('  telegram:', JSON.stringify(j).slice(0, 200));
}

(async () => {
  console.log(`region=${CFG.REGION} band=${CFG.MIN_ODDS}-${CFG.MAX_ODDS} target=${CFG.TARGET}`);

  if (CFG.PING) {
    await telegram('sb.js ping — delivery works');
    console.log('ping sent');
    return;
  }

  const day = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  let legs = await scan();
  console.log(`  ${legs.length} candidates from ${hhmm(dayStart())}`);
  if (!legs.length) { await telegram(`${day}: no candidates in band`); return; }

  legs = await llmRank(legs);
  const short = legs.slice(0, CFG.TEST ? 1 : CFG.MAX_CODES * CFG.LEGS_PER_CODE);

  if (CFG.DRY) {
    console.log(short.map(l => `${hhmm(l.ko)} ${l.league} | ${l.home} v ${l.away} | ${l.desc} @${l.odds}`).join('\n'));
    return;
  }

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
  const lines = [];
  for (let i = 0; i < short.length; i += CFG.LEGS_PER_CODE) {
    const chunk = short.slice(i, i + CFG.LEGS_PER_CODE);
    console.log(`  batch ${i / CFG.LEGS_PER_CODE + 1}: ${chunk.length} legs`);
    const r = await mint(chunk);
    if (r.code) {
      const combined = chunk.reduce((a, l) => a * l.odds, 1).toFixed(1);
      lines.push(`${r.code}  ${chunk.length} legs  @${combined}${r.url ? '\n' + r.url : ''}`);
      console.log(`    CODE ${r.code}`);
    } else {
      lines.push(`batch ${i / CFG.LEGS_PER_CODE + 1} FAILED: ${r.err}`);
      console.log(`    fail ${r.err}`);
    }
    if (i + CFG.LEGS_PER_CODE < short.length) await sleep(CFG.GAP_MS);
  }

  fs.writeFileSync(path.join(CFG.OUT_DIR, `${day}.txt`), lines.join('\n\n') + '\n');
  await telegram(`${day} — ${lines.filter(l => !l.startsWith('batch')).length} codes\n\n` + lines.join('\n\n'));
  console.log('done');
})();
```

---

## Appendix B — .env.example

```env
# region — must match the site you bet on: gh or ng
REGION=gh

# telegram delivery (see README step 5)
TG_TOKEN=
TG_CHAT=

# llm re-ranking (see README step 6). Leave LLM_KEY empty to skip.
LLM_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
LLM_MODEL=gemini-2.0-flash
LLM_KEY=

# odds band
MIN_ODDS=1.05
MAX_ODDS=1.25

# volume
TARGET=150
LEGS_PER_CODE=50
MAX_CODES=4
GAP_MS=90000
LEAGUE_CAP=6

# set false to skip the model entirely
USE_LLM=true
```

---

## Caveats

- **Fifty legs is a lottery.** ~1,000/1 at a 1.15 average. Four codes is four tickets. For something that actually lands, use 15 legs.
- **Codes expire.** Open them the same morning. Nothing here re-mints an expired code.
- **Odds move between scan and mint.** A suspended leg fails its batch; the split logic halves it rather than losing the whole code.
- **Morning cards are thin.** A 06:00 run sees the whole day, but the safest lines cluster in the afternoon. If `candidates` is low in `run.log`, that's normal, not a bug.
- **These are undocumented endpoints.** They can change without notice. `run.log` will show the breakage.
- **No wagering.** Codes are preparation only; every stake is placed by hand.
- Betting involves risk. Odds math is arithmetic, not prediction.
