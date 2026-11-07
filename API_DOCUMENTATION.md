# SportyBet Automation & VIP Platform API Documentation

Official API documentation for the SportyBet Automation engine, Telegram bot, QuestPay v1 payment system, and Next.js web dashboard integration.

- **Production Base URL:** `https://sportybetcodeautomation.onrender.com`
- **CORS:** Enabled globally (`Access-Control-Allow-Origin: *`)
- **Protocol:** HTTPS / JSON

---

## Table of Contents
0. [⚡ Web Developer Quickstart Guide](#-web-developer-quickstart-guide)
1. [Telegram Login & Account Linking](#1-telegram-login--account-linking)
   - `POST /api/auth/telegram`
   - `GET /api/subscription/:userId`
   - [How Web and Telegram Sync Payments (2-Way Flow)](#how-web-and-telegram-sync-payments-2-way-flow)
   - Setup in `@BotFather`
2. [Code Generation APIs](#2-code-generation-apis)
   - `POST /api/generate`
   - `GET /api/sports`
3. [Quest Special APIs (Live Sniper)](#3-quest-special-apis-live-sniper)
   - `POST /api/quest-special/start`
   - `GET /api/quest-special/status/:userId`
   - `POST /api/quest-special/stop`
   - `GET /api/quest-special/scan`
4. [Analytics & Boom Rate APIs](#4-analytics--boom-rate-apis)
   - `GET /api/analytics/global`
   - `GET /api/analytics/user/:userId`
   - `GET /api/slips/latest`
5. [Payment & QuestPay Checkout](#5-payment--questpay-checkout)
   - `POST /api/payment/initialize` *(Web Dashboard Checkout)*
   - `GET /api/payment/verify/:reference` *(Web Verification)*
   - `POST /webhook/questpay` *(QuestPay IPN)*
   - `GET /ping`
6. [Next.js / TypeScript Integration Client](#6-nextjs--typescript-integration-client)

---

## ⚡ Web Developer Quickstart Guide

### 1. Essential Overview
- **Production Base URL:** `https://sportybetcodeautomation.onrender.com`
- **Database:** MongoDB Atlas Cloud (Database: `app`, Collections: `users`, `subscribers`, `slips`).
- **VIP Subscription Price:** **₦10 for 7 Days** (updated from ₦1,000). The backend bills exactly ₦10.
- **CORS:** Enabled globally (`Access-Control-Allow-Origin: *`). You can call endpoints directly from client-side or server-side Next.js / React.

### 2. Multi-Key Identity & 2-Way Synchronization
The backend unifies the web dashboard and Telegram bot accounts automatically. You can pass **ANY** identifier in your API requests:
- MongoDB User `_id` (e.g. `"6aeb75c21deed4a3d7e4a8ef"`)
- User Email (e.g. `"codewithjacksun@gmail.com"`)
- Username (e.g. `"jacksun"`)
- Telegram ID (e.g. `"5436260273"`)

The backend automatically searches the `users` collection, detects connected accounts, and syncs VIP status across both platforms:
- **If user pays on website:** Website unlocks immediately AND their Telegram bot unlocks immediately.
- **If user pays on Telegram:** Telegram unlocks immediately AND their website dashboard unlocks immediately.

---

### 3. Core 5-Step Web Implementation

#### Step 1: Check User VIP Status
```ts
// Call this on page load or user login:
const res = await fetch(`https://sportybetcodeautomation.onrender.com/api/subscription/${user._id || user.email}`);
const { subscription } = await res.json();

console.log(subscription.active);   // boolean (true / false)
console.log(subscription.daysLeft); // integer (e.g. 7)
console.log(subscription.expDate);  // formatted date string
```

#### Step 2: Initialize ₦10 VIP Payment
When the user clicks "Upgrade to VIP" on the website:
```ts
const res = await fetch('https://sportybetcodeautomation.onrender.com/api/payment/initialize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: user._id,           // MongoDB user _id
    email: user.email,          // User's email
    telegramId: user.telegramId // Optional: if already known
  })
});

const { checkoutUrl, reference, virtualAccount } = await res.json();
// Redirect user to `checkoutUrl` or display `virtualAccount` bank details for ₦10!
```

#### Step 3: Verify Payment Status
When user completes payment or returns from QuestPay checkout:
```ts
const res = await fetch(`https://sportybetcodeautomation.onrender.com/api/payment/verify/${reference}`);
const result = await res.json();

if (result.success && result.status === 'paid') {
  // Re-fetch subscription status; VIP is now active on web and Telegram!
}
```

#### Step 4: Generate SportyBet Booking Codes
```ts
const res = await fetch('https://sportybetcodeautomation.onrender.com/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sport: 'football', // 'football' (tiered safe slips), 'efootball', or 'vfootball'
    userId: user._id || user.email
  })
});

const data = await res.json();
if (data.success && data.codes?.length > 0) {
  // Football returns up to 4 codes, one per tier: pick by `tier`, do not assume codes[0] is the ~10 odds slip.
  const rookie = data.codes.find(c => c.tier === 'rookie');          // safest, low odds
  const highRoller = data.codes.find(c => c.tier === 'high_roller'); // ~@10
  const legend = data.codes.find(c => c.tier === 'legend');          // >= @100, up to 50 legs
  const first = data.codes[0];
  const code = first.code; // e.g. "BC7X92K"
  const url = first.url;   // e.g. "https://www.sportybet.com/ng/?shareCode=BC7X92K"
  const odds = first.odds; // e.g. 1.13
} else if (!data.success && data.noSafeSlip) {
  // Football: no tier cleared its safety bar. Show data.message (and optionally data.noSafeSlip[].reasons).
}
```

#### Step 5: Quest Special (Live Virtual Sniper)
Quest Special scans live virtual football, picks the **safest handicap-first** leg(s) at minute 40 (half-time markets) and minute 80 (full-time markets), and mints a SportyBet booking code only when the safety bar is met. If nothing is safe it returns *no safe slip* (never a forced pick):
```ts
// 1. Start background scan (mode: 'any' | 'handicap' | 'ou', legs: 1 for a single, 5 for a combo):
await fetch('https://sportybetcodeautomation.onrender.com/api/quest-special/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: user._id || user.email, mode: 'any', legs: 1 })
});

// 2. Poll status every 3-4 seconds:
const poll = setInterval(async () => {
  const res = await fetch(`https://sportybetcodeautomation.onrender.com/api/quest-special/status/${user._id || user.email}`);
  const status = await res.json();
  const r = status.lastResult;
  if (!r) return;                       // still scanning
  clearInterval(poll);
  if (r.timedOut) {
    console.log('No safe slip this round:', r.noSafeSlip?.reasons);
    return;
  }
  const picks = r.isMultiLeg ? r.legs : [r];
  console.log('Booking Code:', r.code);          // e.g. "GU2JGA"
  console.log('Direct Booking URL:', r.url);
  console.log('Joint probability:', r.jointProb); // high probability, never guaranteed
  picks.forEach(p => console.log(p.description, '@' + p.odds, 'prob', p.prob, 'score', p.safetyScore));
}, 3500);
```

---

---

## 1. Telegram Login & Account Linking

Users authenticate into the web dashboard directly using their Telegram account via the Telegram Login Widget or Telegram Login JS SDK. Once verified, the API returns the user profile along with their real-time VIP subscription status (active, days left, expiration date).

### Authenticate Telegram User
- **Endpoint:** `/api/auth/telegram`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

#### Request Payload Options

##### Option A: Classic Telegram Login Widget
When using the Telegram Login widget (`data-telegram-login="my_sporty_daily_bot"`), pass the callback payload:
```json
{
  "id": 6916043986,
  "first_name": "Wright",
  "last_name": "Dev",
  "username": "wrightdev",
  "photo_url": "https://t.me/i/userpic/320/wrightdev.jpg",
  "auth_date": 1741234567,
  "hash": "d17d685ba9ae31b025fc768caaeb6bc6f2362f4164c041204c3ac36b5c33f454"
}
```

##### Option B: Telegram Login Library / OpenID Connect (`id_token`)
When using `telegram-login.js` or OpenID Connect:
```json
{
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

##### Option C: Telegram Mini App `initData`
```json
{
  "initData": "query_id=...&user=%7B%22id%22%3A6916043986...&auth_date=1741234567&hash=..."
}
```

##### Option D: OpenID Connect Authorization Code (Client ID & Secret Flow)
When using standard OAuth2 / OpenID Connect authorization code redirect flow:
```json
{
  "code": "AUTH_CODE_FROM_TELEGRAM_REDIRECT",
  "redirect_uri": "https://sportybetcodes.com/auth/callback"
}
```
*The backend automatically exchanges the code with `https://oauth.telegram.org/token` using your bot's Client ID and Client Secret, decodes the claims, and verifies the subscription.*

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "user": {
    "id": "6916043986",
    "firstName": "Wright",
    "lastName": "Dev",
    "username": "wrightdev",
    "photoUrl": "https://t.me/i/userpic/320/wrightdev.jpg",
    "phoneNumber": "+2348012345678",
    "authDate": 1741234567
  },
  "subscription": {
    "active": true,
    "isAdmin": false,
    "daysLeft": 7,
    "expiresAt": 1741839367000,
    "expDate": "13 Mar 2026, 17:36"
  }
}
```

---

### Check Subscription Status Anytime
- **Endpoint:** `/api/subscription/:userId`
- **Method:** `GET`
- **Example:** `GET /api/subscription/6916043986`

#### Response (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "subscription": {
    "active": true,
    "isAdmin": false,
    "daysLeft": 7,
    "expiresAt": 1741839367000,
    "expDate": "13 Mar 2026, 17:36"
  }
}
```

---

### How Web and Telegram Sync Payments (2-Way Flow)

The system unifies identity using the **Telegram User ID** (`chatId`, e.g. `6916043986`). Because MongoDB persists subscribers under this unique ID, payments made on either platform instantly unlock both:

#### Scenario A: User pays inside the Telegram Bot ➔ Opens Website
1. User pays ₦10 on Telegram via the bot (`/pay` or QuestPay link).
2. The payment webhook saves their subscription under their Telegram ID: `6916043986`.
3. User opens the website dashboard and clicks **"Log In with Telegram"**.
4. The dashboard calls `POST /api/auth/telegram`.
5. The API detects user `6916043986` and returns `subscription.active: true` with remaining days.
6. **Result:** User immediately gets VIP on the dashboard without paying again!

#### Scenario B: User signs up on Website ➔ Pays on Web Dashboard
1. On the website dashboard, user logs in with Telegram (or links their Telegram account in Settings). The website stores their `telegramId: "6916043986"`.
2. User clicks **"Upgrade to VIP"** on the website.
3. The website calls `POST /api/payment/initialize` with `{ "telegramId": "6916043986" }`.
4. User pays via dynamic Virtual Account (Bank Transfer) or Card.
5. QuestPay webhook fires or web verification runs:
   - Backend marks `6916043986` as VIP active in MongoDB.
   - The Telegram bot sends a direct message to the user on Telegram:
     *`🎉 Payment of ₦10 received! Your VIP subscription has been activated for 7 days!`*
6. **Result:** User immediately gets VIP on both the website and Telegram!

#### Scenario C: Website has existing Email/Password Auth
If the website dashboard uses traditional Email/Password accounts:
1. In the User Settings/Profile tab, show a **"Link Telegram Account"** button containing the Telegram Login Widget.
2. When the user taps it, Telegram sends the verified `id` (e.g. `6916043986`).
3. Save `telegramId: id` in your user document in MongoDB.
4. Call `GET /api/subscription/:telegramId` to check if they already have an active subscription from the bot!

---

#### BotFather Whitelist Configuration (Required)
Before embedding the widget or login button on your site, authorize your website URL in Telegram:
1. Open [@BotFather](https://t.me/botfather) in Telegram.
2. Send `/setdomain`
3. Select your bot: `@my_sporty_daily_bot`
4. Enter your web app domain (e.g., `https://sportybet-frontend.vercel.app` or your custom domain).
*(For local development testing, you can use an ngrok or Cloudflare tunnel URL).*

---

## 2. Code Generation APIs

### Generate Booking Codes
Mints fresh, ranked SportyBet booking code(s) with pre-calculated odds and direct booking URLs.

- **Endpoint:** `/api/generate`
- **Method:** `POST` *(or `GET /api/generate?sport=football&userId=...`)*
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "sport": "football",
  "userId": "user_or_email@example.com",
  "fresh": false
}
```

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sport` | string | **Yes** | Options: `"football"`, `"efootball"`, `"vfootball"` |
| `userId` | string | Optional | Email or user ID to attribute the slip for personal win-rate tracking |
| `fresh` | boolean | Optional | Default `false`. If `true`, forces a live scraper run bypassing the 60s cache |

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "sport": "football",
  "count": 1,
  "cached": false,
  "codes": [
    {
      "code": "BC7X92K",
      "url": "https://www.sportybet.com/ng/?shareCode=BC7X92K",
      "odds": 1.13,
      "legsCount": 4,
      "sport": "football",
      "tier": "rookie",
      "tierName": "Rookie",
      "jointProb": 0.72
    },
    {
      "code": "BC8Y10M",
      "url": "https://www.sportybet.com/ng/?shareCode=BC8Y10M",
      "odds": 10.64,
      "legsCount": 16,
      "sport": "football",
      "tier": "high_roller",
      "tierName": "High Roller",
      "jointProb": 0.04,
      "highRisk": true
    },
    {
      "code": "BC9Z22P",
      "url": "https://www.sportybet.com/ng/?shareCode=BC9Z22P",
      "odds": 119.15,
      "legsCount": 18,
      "sport": "football",
      "tier": "legend",
      "tierName": "Legend",
      "jointProb": 0.003,
      "highRisk": true
    }
  ],
  "lines": [
    "Rookie  BC7X92K  4 legs  @1.13\nhttps://www.sportybet.com/ng/?shareCode=BC7X92K",
    "Hustler: not available right now",
    "High Roller  BC8Y10M  16 legs  @10.64\nhttps://www.sportybet.com/ng/?shareCode=BC8Y10M",
    "Legend  BC9Z22P  18 legs  @119.15\nhttps://www.sportybet.com/ng/?shareCode=BC9Z22P"
  ],
  "generatedAt": "2026-11-04T15:54:00.000Z"
}
```

**Football changes (the route, method and request body are unchanged):**
- `codes` holds **up to 4** items, one per tier, each with **at most 50 legs**. Select by `tier`, not by position.
- `tier` is a slug: `"rookie"` | `"hustler"` | `"high_roller"` | `"legend"`. `tierName` is the display label: `"Rookie"`, `"Hustler"`, `"High Roller"`, `"Legend"`. (Earlier drafts used banker / safe / long.)
- **Rookie**: ~4 legs, handicap / double chance only, low total odds (typically @1.1-1.3). **Hustler**: ~8 legs. **High Roller**: about @10. **Legend**: @100 or more, up to 50 legs.
- Optional fields on each football code: `tier`, `tierName`, `jointProb` (0-1 estimated probability that every leg wins) and `highRisk` (`true` for High Roller and Legend). `odds`, `legsCount`, `code`, `url`, `sport` keep their meaning. `efootball` / `vfootball` responses are unchanged.
- **Do not show `jointProb` to end users.** It stays in the API for the dashboard's own use (sorting, analytics, admin views). The `lines` strings contain no probabilities.
- A tier that cannot be built is simply missing from `codes` (for example Legend when 50 legs cannot reach @100); `lines` then has a `"<Tier>: not available right now"` entry. `count` equals `codes.length`.
- Probabilities are estimates, not guarantees. Legend in particular is a long shot, so keep a general disclaimer in the UI.
- A fresh football run takes longer (roughly 1-3 minutes with four tiers and up to 50-leg codes). Use a client timeout of at least 180 seconds, keep the `429 busy` handling, and prefer the 60s cache (`fresh: false`).

#### No Fixtures Response (`200 OK`)
```json
{
  "success": false,
  "sport": "efootball",
  "count": 0,
  "message": "eFootball: nothing qualified right now. Check back shortly!"
}
```

#### No Safe Slip Response - football (`200 OK`)
Returned when none of the tiers cleared its safety bar. The bar is never lowered.
```json
{
  "success": false,
  "sport": "football",
  "count": 0,
  "message": "Football: no safe slip right now. The selector does not lower its safety bar.",
  "noSafeSlip": [
    { "tier": "rookie", "tierName": "Rookie", "reasons": ["only 2/4 legs passed the filters"], "refreshDropped": [] }
  ],
  "lines": ["Rookie: not available right now"]
}
```

---

### Available Sports Presets
Returns metadata for all available sports to populate UI tabs and buttons.

- **Endpoint:** `/api/sports`
- **Method:** `GET`

#### Response (`200 OK`)
```json
{
  "success": true,
  "sports": [
    {
      "id": "football",
      "name": "Football",
      "icon": "⚽",
      "desc": "Real fixtures: Rookie, Hustler, High Roller and Legend slips (handicap / double chance first)"
    },
    {
      "id": "efootball",
      "name": "eFootball",
      "icon": "🕹",
      "desc": "In-play matches with 3+ margin after 40′"
    },
    {
      "id": "vfootball",
      "name": "vFootball",
      "icon": "⚡",
      "desc": "Virtual football rapid 3-minute rounds"
    },
    {
      "id": "quest_special",
      "name": "Quest Special",
      "icon": "🎯",
      "desc": "Live vFootball sniper: handicap-first safe selection at 40′ (half-time) and 80′ (full-time); Under / No GG only as a stricter fallback"
    }
  ]
}
```

---

## 3. Quest Special APIs (Live Sniper)

### Overview
**Quest Special** is a real-time in-play engine for **vFootball (virtual football)** (`sr:sport:202120001`). Every ~3.5 seconds it reads the live feed, scores every candidate leg with a probability model, and mints a SportyBet **booking code** (never a stake) only when a leg (or slip) clears the safety bar. If nothing clears the bar it keeps scanning and returns **no safe slip** instead of lowering the bar.

> A slip is **high probability, never guaranteed.** Virtual football is simulated; calibrate against real settled results before relying on the numbers (see the README "Quest Special safe selector" section and `npm run settle`).

### Selection logic (what the API result means)

| Step | Rule |
| :--- | :--- |
| **Window** | Half-time markets are considered from **40:00 to 43:00** (active `H1`). Full-time markets from **80:00 to 86:00** (active `H2`). Clock = `playedSeconds`; a match without a clock or score is skipped. |
| **Pool** | One leg per match. Only active markets (`status 0`, not banned, outcome active). |
| **Probability** | The remaining-goal rate is fitted from the match's own live Over/Under ladder, then every leg is priced with a Poisson model of the remaining goals given the current score. The leg's own de-vigged market price is a cross-check. `prob` is the **lower** of the two. The time window is treated as effective playing time (HT 40 / FT 80), so remaining risk is scaled by 45/40 (HT) and 90/80 (FT). |
| **Hard filters** | `prob >= 0.78`, odds `1.10 – 1.35`, model/market gap `<= 0.10`; straight 1X2 wins only if `prob >= 0.85` and no Double Chance leg is available. |
| **Handicap first** | **Tier 1 = Handicap + Double Chance (+0.5)** is always preferred. **Fallbacks** are used only when no tier-1 leg survives (or to fill remaining slots of a multi-leg slip): **No GG** (tier 2), then **Under** (tier 3), then straight results (tier 4). Fallback legs must clear a stricter `prob >= 0.85`. |
| **Safety score** | 0–100: probability (70%), coherence (15%), market-type safety (10%), league (5%). Ranks legs inside a tier. |
| **Slip** | Joint probability = product of leg probabilities must be `>= 0.45`, no two legs sharing a team. Otherwise **no safe slip**. |
| **LLM veto** | Multi-leg only, 2 s budget, fail-open. May only drop a leg (replaced from reserves); never adds legs or changes numbers. |
| **Booking** | `POST /orders/share` only. There is no staking code path. |

All thresholds are configurable by environment variable (`SEL_MIN_LEG_PROB`, `SEL_MIN_FALLBACK_PROB`, `SEL_MIN_SLIP_PROB`, `SEL_WINDOW_HT`, `SEL_WINDOW_FT`, `SEL_PREFER_HANDICAP`, …; see `.env.example`).

> **5-leg slips:** five legs at ~0.80 give ~0.33 joint probability, below the 0.45 bar, so 5-leg requests frequently end with *no safe slip*. That is intentional.

### Operational constraints
- **Scan interval:** 3.5 seconds.
- **Lifespan:** up to **10 minutes** per session. If no safe slip appears the session ends with `lastResult.timedOut = true` (and a `noSafeSlip` explanation).
- **Daily quota:** 20 activations per user per day (admins unlimited). Counted only when a slip is found.
- **VIP only:** non-VIP users receive `403`.
- **Boom tracking:** every minted slip is stored with `isQuestSpecial: true`; each leg is settled by market/outcome (half-time markets use the half-time score).

---

### Start Background Session
- **Endpoint:** `/api/quest-special/start`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

```json
{
  "userId": "6916043986",
  "mode": "any",
  "legs": 1
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `userId` | string | **Required.** Mongo `_id`, email, username or Telegram id. |
| `mode` | string | `"any"` / `"mix"` (default, **handicap first**, then No GG / Under fallback), `"handicap"` (handicap + Double Chance only, with the existing No GG fallback on a 3+ goal lead), `"ou"` (Under lines only; still needs `prob >= 0.85`). |
| `legs` | number | `1` (default) single leg, or `2`–`10` multi-leg accumulator (`5` is the common combo). |

#### Success (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "mode": "any",
  "legs": 1,
  "message": "🔍 Quest Special (ANY) activated! Scanning live vFootball matches…",
  "dailyUsed": 0,
  "maxDaily": "Unlimited",
  "isUnlimited": true
}
```
`maxDaily` is a number (`20`) for normal users and the string `"Unlimited"` for admins.

#### Errors
| Status | Body |
| :--- | :--- |
| `400` | `{ "success": false, "error": "userId is required" }` or `"Quest Special is already active…"` / daily limit reached |
| `403` | `{ "success": false, "error": "VIP subscription required to activate Quest Special" }` |

---

### Check Session Status / Result
Poll every 3–5 seconds while active.

- **Endpoint:** `/api/quest-special/status/:userId`
- **Method:** `GET`

#### While scanning
```json
{
  "success": true,
  "userId": "6916043986",
  "active": true,
  "mode": "any",
  "legs": 1,
  "scans": 3,
  "runningFor": 24,
  "dailyUsed": 0,
  "maxDaily": 20,
  "isUnlimited": false,
  "lastResult": null
}
```

#### Single leg found
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "dailyUsed": 1,
  "maxDaily": 20,
  "isUnlimited": false,
  "lastResult": {
    "isMultiLeg": false,
    "eventId": "sr:match:200026110531420",
    "home": "CHE",
    "away": "HUL",
    "league": "Virtual",
    "minute": 83,
    "homeScore": 1,
    "awayScore": 2,
    "odds": 1.11,
    "description": "Full Time CHE Handicap [hcp=2:0] (CHE vs HUL at 83')",
    "reasoning": "Score is 1-2 at 83'. CHE holds a +1 cushion on full time handicap [hcp=2:0].",
    "prob": 0.8681,
    "safetyScore": 78,
    "jointProb": 0.8681,
    "analysis": {
      "category": "handicap",
      "window": "ft_handicap",
      "type": "ft_handicap",
      "marketId": "14",
      "specifier": "hcp=2:0",
      "outcomeId": "1711",
      "odds": 1.11,
      "cushion": 1,
      "description": "Full Time CHE Handicap [hcp=2:0] (CHE vs HUL at 83')",
      "reasoning": "Score is 1-2 at 83'. CHE holds a +1 cushion on full time handicap [hcp=2:0].",
      "prob": 0.8681,
      "safetyScore": 78
    },
    "mode": "any",
    "code": "BC9X2A",
    "url": "https://www.sportybet.com/ng/?shareCode=BC9X2A",
    "mintError": null,
    "timestamp": 1741234567890
  }
}
```
*Existing fields are unchanged. New in this version:* `prob`, `safetyScore`, `jointProb`, `analysis.prob`, `analysis.safetyScore`. `analysis` also carries the raw SportyBet `market` and `outcome` objects the pick came from (ignore them in UIs). `analysis.type` tells you the market family (`*_handicap` / `*_double_chance` = tier 1; `*_nogg`, `*_under`, results = fallback).

#### Multi-leg slip found
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "lastResult": {
    "isMultiLeg": true,
    "legsCount": 5,
    "totalOdds": 1.62,
    "jointProb": 0.47,
    "code": "ZNM4T0",
    "url": "https://www.sportybet.com/ng/?shareCode=ZNM4T0",
    "mode": "any",
    "timestamp": 1741234567890,
    "legs": [
      {
        "eventId": "sr:match:200026110522226",
        "home": "ALA",
        "away": "ELC",
        "league": "Virtual",
        "minute": 83,
        "homeScore": 0,
        "awayScore": 0,
        "odds": 1.07,
        "description": "Full Time ELC Handicap [hcp=0:1] (ALA vs ELC at 83')",
        "reasoning": "Score is 0-0 at 83'. ELC holds a +1 cushion on full time handicap [hcp=0:1].",
        "prob": 0.89,
        "safetyScore": 81,
        "analysis": { "type": "ft_handicap", "marketId": "14", "specifier": "hcp=0:1", "outcomeId": "1713", "odds": 1.07, "prob": 0.89, "safetyScore": 81 }
      }
    ]
  }
}
```

#### Cycle ended with no safe slip
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "lastResult": {
    "timedOut": true,
    "timestamp": 1741234747000,
    "mode": "any",
    "legs": 5,
    "noSafeSlip": {
      "timestamp": 1741234745000,
      "reasons": ["only 3/5 legs passed the safety filters"],
      "considered": 3,
      "inWindow": 10,
      "rejected": {
        "odds<MIN_LEG_ODDS": 21,
        "prob #<MIN_LEG_PROB": 5,
        "fallback prob #<MIN_FALLBACK_PROB": 6
      }
    }
  }
}
```
`noSafeSlip` is `null` when no match was inside the 40:00–43:00 / 80:00–86:00 window during the session. `reasons` is a human-readable summary; `rejected` counts why candidate legs were filtered out (numbers in the keys are normalised to `#`).

---

### Stop Background Session
- **Endpoint:** `/api/quest-special/stop`
- **Method:** `POST`

```json
{ "userId": "6916043986" }
```
Response: `{ "success": true, "userId": "...", "stopped": true, "message": "Quest Special stopped successfully" }`

---

### Instant Live Scan (One-Off)
Runs the selector once, right now, without a background session. **This mints a real booking code when a safe slip is found.**

- **Endpoint:** `/api/quest-special/scan?mode=any&legs=1`
- **Method:** `GET`

Found: `{ "success": true, "found": true, "mode": "any", "legs": 1, "signal": { …same shape as lastResult… } }`

Nothing safe right now:
```json
{
  "success": true,
  "found": false,
  "mode": "any",
  "legs": 1,
  "message": "No safe slip right now for the any criteria.",
  "noSafeSlip": { "reasons": ["only 0/1 legs passed the safety filters"], "considered": 0, "inWindow": 0, "rejected": {}, "timestamp": 1741234745000 }
}
```
(`noSafeSlip` may be `null`.)

---

### Web Dashboard Implementation Example (React / Next.js)

```tsx
'use client';
import { useState, useEffect } from 'react';
import { startQuestSpecial, getQuestSpecialStatus, stopQuestSpecial } from '@/lib/sportyApi';

export function QuestSpecialWidget({ userId }: { userId: string }) {
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<'any' | 'handicap' | 'ou'>('any');
  const [legs, setLegs] = useState(1);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('Idle');
  const [result, setResult] = useState<any>(null);

  const handleStart = async () => {
    setLoading(true);
    setResult(null);
    const res = await startQuestSpecial(userId, mode, legs);
    setLoading(false);
    if (res.success) {
      setActive(true);
      setStatusText(`Scanning live vFootball (${mode.toUpperCase()}, ${legs} leg${legs > 1 ? 's' : ''})…`);
    } else {
      alert(res.error || 'Failed to activate Quest Special');
    }
  };

  const handleStop = async () => {
    await stopQuestSpecial(userId);
    setActive(false);
    setStatusText('Cancelled');
  };

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(async () => {
      const data = await getQuestSpecialStatus(userId);
      const r = data.lastResult;
      if (!r) return;
      setActive(false);
      if ('timedOut' in r && r.timedOut) {
        setStatusText(
          r.noSafeSlip?.reasons?.[0]
            ? `No safe slip this round (${r.noSafeSlip.reasons[0]}).`
            : 'No match reached the safety bar this round.'
        );
      } else {
        setResult(r);
        setStatusText('Safe slip found');
      }
    }, 3500);
    return () => clearInterval(interval);
  }, [active, userId]);

  // Normalise single vs multi-leg to a list of legs
  const legsList = result ? (result.isMultiLeg ? result.legs : [result]) : [];

  return (
    <div className="p-6 bg-gray-900 border border-yellow-500/30 rounded-xl text-white">
      <h3 className="text-xl font-bold mb-2">🎯 Quest Special (Live Sniper)</h3>
      <p className="text-sm text-gray-300 mb-4">
        Handicap-first safe selection on live vFootball at 40′ (half-time) and 80′ (full-time). High probability, never guaranteed.
      </p>

      {result && (
        <div className="p-4 bg-green-950/60 border border-green-500 rounded-lg mb-4">
          {result.isMultiLeg && (
            <p className="text-sm mb-2">{result.legsCount} legs @ {result.totalOdds} (joint probability {(result.jointProb * 100).toFixed(0)}%)</p>
          )}
          {legsList.map((l: any) => (
            <div key={l.eventId} className="mb-2">
              <p className="font-semibold">{l.home} vs {l.away} ({l.minute}′ — {l.homeScore}:{l.awayScore})</p>
              <p className="text-sm text-yellow-300">
                {l.description} @{l.odds} · {(l.prob * 100).toFixed(0)}% · score {l.safetyScore}
              </p>
            </div>
          ))}
          {result.code && (
            <div className="mt-3 flex items-center justify-between bg-black/40 p-2 rounded">
              <span className="font-mono text-lg font-bold text-yellow-400">{result.code}</span>
              <a href={result.url} target="_blank" rel="noreferrer" className="text-xs bg-red-600 px-3 py-1.5 rounded font-bold">
                Open in SportyBet ↗
              </a>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        {!active ? (
          <button onClick={handleStart} disabled={loading} className="px-5 py-2.5 bg-yellow-500 text-black font-bold rounded-lg">
            {loading ? 'Activating…' : '🎯 Activate Quest Special'}
          </button>
        ) : (
          <button onClick={handleStop} className="px-5 py-2.5 bg-red-600 text-white font-bold rounded-lg">
            🛑 Stop Scanning
          </button>
        )}
        <span className="text-sm text-gray-400">{statusText}</span>
      </div>
    </div>
  );
}
```

---

## 4. Analytics & Boom Rate APIs

### Platform-Wide Transparency & Proof
Ideal for the **Landing Page**. Displays total slips generated, global boom rate (win rate %), breakdown by sport, and recent boomed slips.

- **Endpoint:** `/api/analytics/global`
- **Method:** `GET`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "totalSlips": 154,
    "boomed": 132,
    "lost": 22,
    "pending": 8,
    "overallBoomRate": "85.7%",
    "overallBoomRateNum": 85.7,
    "bySport": {
      "football": { "total": 92, "boomed": 80, "lost": 12, "pending": 4, "boomRate": "87.0%" },
      "efootball": { "total": 38, "boomed": 31, "lost": 7, "pending": 2, "boomRate": "81.6%" },
      "vfootball": { "total": 24, "boomed": 21, "lost": 3, "pending": 2, "boomRate": "87.5%" },
      "quest_special": { "total": 18, "boomed": 16, "lost": 2, "pending": 1, "boomRate": "88.9%" }
    },
    "questSpecial": { "total": 18, "boomed": 16, "lost": 2, "pending": 1, "boomRate": "88.9%" },
    "recentBoomed": [
      {
        "code": "BC8491A",
        "sport": "football",
        "odds": 10.45,
        "legs": 14,
        "settledAt": "2026-11-04T15:30:12.000Z"
      }
    ]
  }
}
```

---

### User Personal Analytics
Ideal for the **Logged-In User Dashboard**. Returns personal stats, win rate, best hit ticket, and recent slips history with status badges (`boomed`, `lost`, `pending`).

- **Endpoint:** `/api/analytics/user/:userId`
- **Method:** `GET`
- **Example:** `/api/analytics/user/user@example.com` or `/api/analytics/user/6916043986`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "userId": "user@example.com",
    "totalSlips": 12,
    "boomed": 10,
    "lost": 2,
    "pending": 1,
    "boomRate": "83.3%",
    "boomRateNum": 83.3,
    "bestBoom": {
      "code": "BC1092Z",
      "odds": 11.2,
      "sport": "football",
      "date": "2026-11-03T18:40:00.000Z"
    },
    "bySport": {
      "football": { "total": 8, "boomed": 7, "lost": 1, "pending": 0, "boomRate": "87.5%" },
      "efootball": { "total": 4, "boomed": 3, "lost": 1, "pending": 1, "boomRate": "75.0%" },
      "vfootball": { "total": 0, "boomed": 0, "lost": 0, "pending": 0, "boomRate": "N/A" },
      "quest_special": { "total": 5, "boomed": 4, "lost": 1, "pending": 0, "boomRate": "80.0%" }
    },
    "questSpecial": { "total": 5, "boomed": 4, "lost": 1, "pending": 0, "boomRate": "80.0%" },
    "recentSlips": [
      {
        "code": "BC1092Z",
        "sport": "football",
        "odds": 11.2,
        "status": "boomed",
        "legs": 12,
        "createdAt": "2026-11-03T17:00:00.000Z",
        "settledAt": "2026-11-03T18:40:00.000Z"
      },
      {
        "code": "BC8491A",
        "sport": "efootball",
        "odds": 9.8,
        "status": "pending",
        "legs": 10,
        "createdAt": "2026-11-04T14:10:00.000Z",
        "settledAt": null
      }
    ]
  }
}
```

---

### Recent Slips Live Feed
Returns the latest slips for live tickers, proof tickers, or recent activity streams.

- **Endpoint:** `/api/slips/latest`
- **Method:** `GET`

---

## 5. Payment & QuestPay Checkout

### Initialize Web Checkout
Used when a user clicks "Upgrade to VIP" on the web dashboard. Automatically links the checkout to their Telegram ID so both platforms get credited.

- **Endpoint:** `/api/payment/initialize`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "telegramId": "6916043986",
  "email": "user@example.com"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "reference": "VIP-6916043986-1741234567890",
  "checkoutUrl": "https://payments.questlabs.cc/pay/VIP-6916043986-1741234567890",
  "amount": 10,
  "virtualAccount": {
    "bankName": "Wema Bank / Xixapay",
    "accountNumber": "9876543210",
    "accountName": "SportyBet Codes VIP",
    "expiresAt": "2026-11-04T18:30:00.000Z"
  }
}
```

---

### Verify Web Payment Status
Called by the web frontend after the user completes payment (or clicks "I have transferred"):

- **Endpoint:** `/api/payment/verify/:reference`
- **Method:** `GET`
- **Example:** `/api/payment/verify/VIP-6916043986-1741234567890`

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "status": "paid",
  "chatId": "6916043986",
  "reference": "VIP-6916043986-1741234567890",
  "amount": 10
}
```

---

### QuestPay Payment Webhook
Configured inside the QuestPay Merchant Dashboard under **Webhook Settings**:
- **URL:** `https://sportybetcodeautomation.onrender.com/webhook/questpay`
- **Security:** Verified with HMAC-SHA256 signature header `x-questpay-signature`.
- **Event:** `payment.received`
- **Action:** Automatically credits the subscriber for `SUB_DAYS` (7 days) and notifies them in Telegram.

### Health Check & Keep-Alive
- **URL:** `https://sportybetcodeautomation.onrender.com/ping`
- **Method:** `GET`
- **Use Case:** Ping every 5 minutes from UptimeRobot to keep the free Render service awake.

---

## 6. Next.js / TypeScript Integration Client

Your friend can copy this file into their Next.js project under `lib/sportyApi.ts`:

```typescript
// lib/sportyApi.ts

const API_BASE = 'https://sportybetcodeautomation.onrender.com';

export interface SportyCode {
  code: string;
  url: string;
  odds: number;
  legsCount: number;
  sport: string;
  tier?: FootballTier;  // football only
  tierName?: string;    // football only, display label e.g. 'High Roller'
  jointProb?: number;   // football only, 0-1 estimate. Do NOT show to end users.
  highRisk?: boolean;   // football only: true for 'high_roller' and 'legend'
}

export type FootballTier = 'rookie' | 'hustler' | 'high_roller' | 'legend';

export interface NoSafeSlipTier {
  tier: FootballTier;
  tierName?: string;
  reasons: string[];
  refreshDropped: string[];
}

export interface GenerateResponse {
  success: boolean;
  sport: string;
  count: number;
  cached?: boolean;
  codes?: SportyCode[];
  lines?: string[];
  message?: string;
  noSafeSlip?: NoSafeSlipTier[]; // football, when no tier cleared its bar
  generatedAt?: string;
}

export interface GlobalStatsResponse {
  success: boolean;
  data: {
    totalSlips: number;
    boomed: number;
    lost: number;
    pending: number;
    overallBoomRate: string;
    overallBoomRateNum: number;
    bySport: Record<string, { total: number; boomed: number; lost: number; pending: number; boomRate: string }>;
    questSpecial: { total: number; boomed: number; lost: number; pending: number; boomRate: string };
    recentBoomed: Array<{ code: string; sport: string; odds: number; legs: number; settledAt: string }>;
  };
}

export interface UserStatsResponse {
  success: boolean;
  data: {
    userId: string;
    totalSlips: number;
    boomed: number;
    lost: number;
    pending: number;
    boomRate: string;
    boomRateNum: number;
    bestBoom: { code: string; odds: number; sport: string; date: string } | null;
    bySport: Record<string, { total: number; boomed: number; lost: number; pending: number; boomRate: string }>;
    questSpecial: { total: number; boomed: number; lost: number; pending: number; boomRate: string };
    recentSlips: Array<{
      code: string;
      sport: string;
      odds: number;
      status: 'pending' | 'boomed' | 'lost';
      legs: number;
      createdAt: string;
      settledAt: string | null;
    }>;
  };
}

export interface QuestSpecialAnalysis {
  category?: string;            // 'handicap' | 'nogg' | 'ou' | 'result'
  window: string;
  type: string;                 // ft_handicap, ht_handicap, ft_double_chance, ht_double_chance (tier 1);
                                // ft_nogg, ht_nogg, ft_under, ht_under, results (fallbacks)
  marketId: string;
  specifier: string;
  outcomeId: string;
  description: string;
  odds: number;
  reasoning: string;
  prob: number;                 // de-vigged, coherence-checked leg probability (0-1)
  safetyScore: number;          // 0-100
  market?: unknown;             // raw SportyBet market object (ignore in UIs)
  outcome?: unknown;            // raw SportyBet outcome object (ignore in UIs)
}

export interface QuestSpecialLeg {
  eventId: string;
  home: string;
  away: string;
  league: string;
  minute: number;
  homeScore: number;
  awayScore: number;
  odds: number;
  description: string;
  reasoning: string;
  prob: number;
  safetyScore: number;
  analysis: QuestSpecialAnalysis;
}

export interface QuestSpecialSingleResult extends QuestSpecialLeg {
  isMultiLeg: false;
  mode: string;
  code: string | null;
  url: string | null;
  mintError: string | null;
  jointProb: number;            // equals prob for a single leg
  timestamp: number;
}

export interface QuestSpecialMultiResult {
  isMultiLeg: true;
  legsCount: number;
  totalOdds: number;
  jointProb: number;            // product of leg probabilities (>= 0.45 or no slip is produced)
  code: string | null;
  url: string | null;
  mode: string;
  legs: QuestSpecialLeg[];
  timestamp: number;
}

export interface QuestSpecialNoSafeSlip {
  timestamp: number;
  reasons: string[];
  considered: number;           // matches that produced at least one safe leg
  inWindow: number;             // matches inside the 40:00-43:00 / 80:00-86:00 window
  rejected: Record<string, number>; // why candidate legs were filtered out
}

export interface QuestSpecialTimedOut {
  timedOut: true;
  timestamp: number;
  mode: string;
  legs: number;
  noSafeSlip: QuestSpecialNoSafeSlip | null;
}

export interface QuestSpecialStatusResponse {
  success: boolean;
  userId: string;
  active: boolean;
  mode: string;
  legs: number;
  scans: number;
  runningFor: number;
  dailyUsed: number;
  maxDaily: number | 'Unlimited';
  isUnlimited: boolean;
  lastResult: QuestSpecialSingleResult | QuestSpecialMultiResult | QuestSpecialTimedOut | null;
  error?: string;
}

export interface SubscriptionResponse {
  success: boolean;
  userId: string;
  subscription: {
    active: boolean;
    isAdmin: boolean;
    daysLeft: number | string;
    expiresAt: number | null;
    expDate: string | null;
  };
}

export interface CheckoutResponse {
  success: boolean;
  reference?: string;
  checkoutUrl?: string;
  amount?: number;
  virtualAccount?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    expiresAt?: string;
  };
  error?: string;
}

export interface TelegramAuthResponse {
  success: boolean;
  error?: string;
  user?: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    photoUrl: string;
    phoneNumber?: string;
    authDate: number;
  };
  subscription?: {
    active: boolean;
    isAdmin: boolean;
    daysLeft: number | string;
    expiresAt: number | null;
    expDate: string | null;
  };
}

/**
 * Verify Telegram login data and fetch user profile + VIP subscription
 */
export async function authenticateTelegramUser(authData: Record<string, any>): Promise<TelegramAuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authData)
  });
  return res.json();
}

/**
 * Check a user's subscription status anytime using their Telegram ID
 */
export async function checkSubscription(telegramId: string): Promise<SubscriptionResponse> {
  const res = await fetch(`${API_BASE}/api/subscription/${encodeURIComponent(telegramId)}`, { cache: 'no-store' });
  return res.json();
}

/**
 * Initialize QuestPay checkout for a user on the web dashboard
 */
export async function initializePayment(telegramId: string, email?: string): Promise<CheckoutResponse> {
  const res = await fetch(`${API_BASE}/api/payment/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId, email })
  });
  return res.json();
}

/**
 * Verify a payment reference after user transfers or pays
 */
export async function verifyPayment(reference: string): Promise<{ success: boolean; status?: string; message?: string }> {
  const res = await fetch(`${API_BASE}/api/payment/verify/${encodeURIComponent(reference)}`, { cache: 'no-store' });
  return res.json();
}

/**
 * Generate fresh booking codes for a sport
 */
export async function generateCode(
  sport: 'football' | 'efootball' | 'vfootball',
  userId?: string,
  fresh = false
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sport, userId, fresh })
  });
  return res.json();
}

/**
 * Fetch global proof analytics for the landing page
 */
export async function getGlobalStats(): Promise<GlobalStatsResponse> {
  const res = await fetch(`${API_BASE}/api/analytics/global`, { next: { revalidate: 60 } });
  return res.json();
}

/**
 * Fetch personal stats for a logged in user
 */
export async function getUserStats(userId: string): Promise<UserStatsResponse> {
  const res = await fetch(`${API_BASE}/api/analytics/user/${encodeURIComponent(userId)}`, { cache: 'no-store' });
  return res.json();
}

/**
 * Start a Quest Special background scanning session
 */
export async function startQuestSpecial(
  userId: string,
  mode: 'handicap' | 'ou' | 'any' = 'any',
  legs = 1
): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/quest-special/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, mode, legs })
  });
  return res.json();
}

/**
 * Poll Quest Special status and get live signal results
 */
export async function getQuestSpecialStatus(userId: string): Promise<QuestSpecialStatusResponse> {
  const res = await fetch(`${API_BASE}/api/quest-special/status/${encodeURIComponent(userId)}`, { cache: 'no-store' });
  return res.json();
}

/**
 * Stop active Quest Special session
 */
export async function stopQuestSpecial(userId: string): Promise<{ success: boolean; stopped: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/api/quest-special/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  return res.json();
}

/**
 * Direct instant probe of live vFootball games (one-off scan)
 */
export async function scanQuestSpecialLive(
  mode: 'handicap' | 'ou' | 'any' = 'any',
  legs = 1
): Promise<{
  success: boolean;
  found: boolean;
  signal?: QuestSpecialSingleResult | QuestSpecialMultiResult;
  message?: string;
  noSafeSlip?: QuestSpecialNoSafeSlip | null;
}> {
  // NOTE: when a safe slip is found this mints a real booking code.
  const res = await fetch(`${API_BASE}/api/quest-special/scan?mode=${mode}&legs=${legs}`, { cache: 'no-store' });
  return res.json();
}
```

### React / Next.js Telegram Login Button Component Example

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { authenticateTelegramUser, TelegramAuthResponse } from '@/lib/sportyApi';

interface TelegramLoginProps {
  botUsername?: string;
  onAuth: (res: TelegramAuthResponse) => void;
}

export function TelegramLoginButton({
  botUsername = 'my_sporty_daily_bot',
  onAuth
}: TelegramLoginProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Expose callback on global window object for the Telegram widget
    (window as any).onTelegramAuth = async (user: any) => {
      try {
        const result = await authenticateTelegramUser(user);
        onAuth(result);
      } catch (err) {
        console.error('Failed to verify Telegram auth:', err);
      }
    };

    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.setAttribute('data-telegram-login', botUsername);
      script.setAttribute('data-size', 'large');
      script.setAttribute('data-radius', '8');
      script.setAttribute('data-request-access', 'write');
      script.setAttribute('data-userpic', 'true');
      script.setAttribute('data-onauth', 'onTelegramAuth(user)');
      script.async = true;
      containerRef.current.appendChild(script);
    }
  }, [botUsername, onAuth]);

  return <div ref={containerRef} className="my-4 flex justify-center" />;
}
```

