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
    sport: 'football', // 'football' (~10 odds), 'efootball' (in-play), or 'vfootball'
    userId: user._id || user.email
  })
});

const data = await res.json();
if (data.success && data.codes?.length > 0) {
  const code = data.codes[0].code; // e.g. "BC7X92K"
  const url = data.codes[0].url;   // e.g. "https://www.sportybet.com/ng/?shareCode=BC7X92K"
  const odds = data.codes[0].odds; // e.g. 10.45
}
```

#### Step 5: Quest Special (Live Virtual Sniper)
Quest Special is a real-time live background sniper for virtual football. Matches are sniped at exact clock marks with buffered staking time before whistles blow:
```ts
// 1. Start background scan:
await fetch('https://sportybetcodeautomation.onrender.com/api/quest-special/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: user._id || user.email })
});

// 2. Poll status every 3 seconds:
const poll = setInterval(async () => {
  const res = await fetch(`https://sportybetcodeautomation.onrender.com/api/quest-special/status/${user._id || user.email}`);
  const status = await res.json();

  if (status.lastResult && !status.lastResult.timedOut) {
    clearInterval(poll);
    const slip = status.lastResult;
    console.log('Sniper Locked Match:', slip.home, 'vs', slip.away);
    console.log('Booking Code:', slip.code);       // e.g. "GU2JGA"
    console.log('Direct Booking URL:', slip.url); // e.g. "http://www.sportybet.com/ng/?shareCode=GU2JGA"
    console.log('Pick:', slip.analysis.description);
    console.log('Odds:', slip.analysis.odds);
  }
}, 3000);
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
      "odds": 10.45,
      "legsCount": 12,
      "sport": "football"
    }
  ],
  "lines": [
    "BC7X92K  12 legs  @10.5\nhttps://www.sportybet.com/ng/?shareCode=BC7X92K"
  ],
  "generatedAt": "2026-11-04T15:54:00.000Z"
}
```

#### No Fixtures Response (`200 OK`)
```json
{
  "success": false,
  "sport": "efootball",
  "count": 0,
  "message": "eFootball: nothing qualified right now. Check back shortly!"
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
      "desc": "Real fixtures, ~10 odds accumulators"
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
      "desc": "Live background sniper: vFootball at 41′ (HT Under), 43′ (H1 Winner), 85′ (FT Under), 88′ (Late Lead/Hcap)"
    }
  ]
}
```

---

## 3. Quest Special APIs (Live Sniper)

### Overview & Philosophy
**Quest Special** is a specialized real-time in-play sniper engine built exclusively for **vFootball (Virtual Football)** live matches (`sr:sport:202120001` & `sr:sport:137`). 

Unlike multi-leg accumulators, Quest Special mints **single-leg (1-leg)** high-confidence booking codes. Virtual football matches run on a compressed 3-minute cycle (90 virtual minutes simulated in ~180 real seconds, where 1 virtual minute = 2 real seconds). At exact live clock intervals, high-probability betting opportunities emerge.

Quest Special continuously scans live vFootball rounds in the background, identifies qualifying fixtures at exact minute marks, immediately mints a single-leg SportyBet booking code, and delivers it to the user.

---

### Exact Quest Special 4-Stage Live Rules & Decision Logic

```
                             [ Live vFootball Match Detected ]
                                             │
      ┌─────────────────────┬────────────────┴──────────────────┬─────────────────────┐
      │                     │                                   │                     │
   At 41′ (HT)           At 43′ (H1)                         At 85′ (FT)           At 88′ (FT)
  HT Under 0.5          Winner of H1                        FT Under 0.5      Late Lead & Handicap
      │                     │                                   │                     │
      ▼                     ▼                                   ▼                     ▼
[ Under 0.5 HT ]       [ 1st Half 1X2 ]                    [ Under Line ]        Lead Evaluation:
Market 68 (total=0.5)  Market 60                           Market 18 Under       • 2+ Lead ➔ 1X2 Winner
Imminent whistle       Leader or 1st Half                  Imminent FT whistle   • 1 Lead  ➔ Handicap / 1X2
into half-time break.  favourite lock.                     into full time.       • Virtual ➔ Fav / Cushion
```

#### Rule 1: Half Time Sniper → Handicap Priority with Dynamic Under Fallback (40.0′ – 42.5′, Active H1)
- **Clock Window:** 40.0′ – 42.5′ (Must be active `H1`, starting from minute 40 with safe staking buffer before HT whistle).
- **Target Logic:**
  - **Priority 1 (Handicap):** Checks Market `65` (1st Half Handicap) for active lines providing a $\ge 1$ goal cushion within odds band (`1.05` – `1.35`).
  - **Priority 2 (O/U Fallback):** If handicap unavailable, falls back to `Under (Current Goals + 0.5)` in Market `68` (`1st Half - Over/Under`) with odds $\ge 1.05$.
- **Reasoning:** In virtual football, closing minutes of the 1st half have virtually no goal conversion. Starting at 40.0′ gives the user the ideal staking window before the halftime whistle.

#### Rule 2: 41 Minutes → 1st Half Winner or 1st Half Draw (40.0′ – 43.0′, Active H1)
- **Clock Window:** 40.0′ – 43.0′ (Must be active `H1`, preserving buffer before half-time).
- **Market Targeted:** Market `60` (`1st Half - 1X2`).
- **Selection:**
  - **Tied game (e.g. `0-0`, `1-1`):** Selects **1st Half Draw (X)**. Whistle is imminent and game will reach the break level.
  - **Team leading (e.g. `1-0`, `0-1`):** Selects **1st Half Winner** on the leading team.
- **Reasoning:** Locks in the 1st Half result with safe time remaining before the referee sounds the halftime whistle.

#### Rule 3: Full Time Handicap (75.0′ – 82.0′, Active H2)
- **Clock Window:** 75.0′ – 82.0′ (Must be active `H2`).
- **Target Logic:** Market `14` (**Full Time Handicap ONLY** with lines `hcp=1:0`, `hcp=2:0`, `hcp=0:1`, `hcp=0:2`, `hcp=3:0`) providing a $\ge 1$ goal cushion within odds band (`1.05` – `1.35`).
- **Reasoning:** SportyBet typically locks/suspends Handicap markets around 83′. Sniping Handicap early at 75′–82′ ensures markets are active and gives users ample staking time before any suspension.

#### Rule 4: Late Full Time Over/Under (83.0′ – 85.5′, Active H2)
- **Clock Window:** 83.0′ – 85.5′ (Must be active `H2`).
- **Target Logic:** Market `18` (`Full Time Over/Under`) at `Under (Current Goals + 0.5)` with odds in `1.05` – `1.35`.
- **Reasoning:** At 83′+, Handicap is locked, but Over/Under remains open and highly predictable in the closing stretch.

#### Rule 5: Late Full Time Result / Draw (83.0′ – 86.0′, Active H2)
- **Clock Window:** 83.0′ – 86.0′ (Must be active `H2`).
- **Lead-Based Logic:**
  - **Tied game (e.g. `0-0`, `1-1`, `2-2`):** Selects **Full Time Draw (X)** in Market `1`.
  - **2+ Goal Lead (e.g. `2-0`, `0-2`, `3-1`):** Selects **1X2 Match Winner (Market `1`)** on the leading team.

---

### Operational Constraints & Lifecycle
- **Scan Interval:** Polls SportyBet factsCenter every **3 seconds**.
- **Execution Lifespan:** Runs for up to **10 minutes** across multiple active and incoming virtual rounds until a qualifying match hits.
- **Daily Quota:** Limited to **20 activations per user per calendar day** (resets at 00:00 UTC).
- **VIP Protection:** Only available to users with active VIP subscriptions. Free/expired users receive `403 Forbidden`.
- **Boom Tracking:** Every generated slip is recorded in MongoDB with `isQuestSpecial: true` and automatically tracked for personal and global win rate analytics.

---

### Start Background Session
Starts background scanning for the user. When a game qualifies, the single-leg code is minted automatically.

- **Endpoint:** `/api/quest-special/start`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

#### Request Body
```json
{
  "userId": "6916043986"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "message": "🔍 Quest Special activated! Scanning vFootball live games…",
  "dailyUsed": 1,
  "maxDaily": 20
}
```

#### VIP Required Response (`403 Forbidden`)
```json
{
  "success": false,
  "error": "VIP subscription required to activate Quest Special"
}
```

---

### Check Session Status / Result
Poll every 3–5 seconds from the web dashboard while Quest Special is active:

- **Endpoint:** `/api/quest-special/status/:userId`
- **Method:** `GET`
- **Example:** `/api/quest-special/status/6916043986`

#### Response While Scanning (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "active": true,
  "scans": 3,
  "runningFor": 24,
  "dailyUsed": 1,
  "maxDaily": 20,
  "lastResult": null
}
```

#### Response When Game Found (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "dailyUsed": 1,
  "maxDaily": 20,
  "lastResult": {
    "code": "BC9X2A",
    "url": "https://www.sportybet.com/ng/?shareCode=BC9X2A",
    "home": "Manchester City",
    "away": "Liverpool",
    "league": "vFootball Premier League",
    "minute": 80,
    "homeScore": 0,
    "awayScore": 2,
    "analysis": {
      "window": "80min",
      "type": "match_winner",
      "description": "Away to Win (0-2 at 80')",
      "odds": 1.12,
      "reasoning": "Away leads 0-2 by 2 goals at 80'. Strong Match Winner."
    },
    "timestamp": 1741234567890
  }
}
```

#### Response When Cycle Ends With No Match (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "dailyUsed": 0,
  "maxDaily": 20,
  "lastResult": {
    "timedOut": true,
    "timestamp": 1741234747000
  }
}
```

---

### Stop Background Session
Cancels active scanning if the user navigates away or clicks Cancel:

- **Endpoint:** `/api/quest-special/stop`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

```json
{
  "userId": "6916043986"
}
```

---

### Instant Live Scan (One-Off)
Directly probes live in-play vFootball fixtures right now without starting a background poller:

- **Endpoint:** `/api/quest-special/scan`
- **Method:** `GET`

---

### Web Dashboard Implementation Example (React / Next.js)

```tsx
'use client';
import { useState, useEffect } from 'react';
import { startQuestSpecial, getQuestSpecialStatus, stopQuestSpecial } from '@/lib/sportyApi';

export function QuestSpecialWidget({ userId }: { userId: string }) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('Idle');
  const [result, setResult] = useState<any>(null);

  const handleStart = async () => {
    setLoading(true);
    setResult(null);
    const res = await startQuestSpecial(userId);
    setLoading(false);
    if (res.success) {
      setActive(true);
      setStatusText('Scanning live vFootball round…');
    } else {
      alert(res.error || 'Failed to activate Quest Special');
    }
  };

  const handleStop = async () => {
    await stopQuestSpecial(userId);
    setActive(false);
    setStatusText('Cancelled');
  };

  // Poll status while active
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(async () => {
      const data = await getQuestSpecialStatus(userId);
      if (data.lastResult) {
        if (data.lastResult.timedOut) {
          setStatusText('Round ended with no qualifying games. Tap to scan next round!');
        } else {
          setResult(data.lastResult);
          setStatusText('🎯 Qualifying signal found!');
        }
        setActive(false);
      }
    }, 3500);

    return () => clearInterval(interval);
  }, [active, userId]);

  return (
    <div className="p-6 bg-gray-900 border border-yellow-500/30 rounded-xl text-white">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold flex items-center gap-2">🎯 Quest Special (Live Sniper)</h3>
        <span className="text-xs bg-yellow-500/20 text-yellow-300 px-2 py-1 rounded">VIP Exclusive</span>
      </div>

      <p className="text-sm text-gray-300 mb-4">
        Background sniper targeting vFootball matches at 40′ (HT Handicap & O/U), 75′–82′ (FT Handicap pre-lock), and 83′ (FT Under). Mints a single-leg code the second criteria are met with ample staking breathing space.
      </p>

      {result && (
        <div className="p-4 bg-green-950/60 border border-green-500 rounded-lg mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="font-bold text-green-400">🟢 SIGNAL DETECTED</span>
            <span className="text-sm bg-green-800 px-2 py-0.5 rounded">@{result.analysis.odds}</span>
          </div>
          <p className="font-semibold">{result.home} vs {result.away} ({result.minute}′ — {result.homeScore}:{result.awayScore})</p>
          <p className="text-sm text-yellow-300 mt-1">Pick: {result.analysis.description}</p>
          <p className="text-xs text-gray-400 mt-1 italic">{result.analysis.reasoning}</p>

          {result.code && (
            <div className="mt-3 flex items-center justify-between bg-black/40 p-2 rounded">
              <span className="font-mono text-lg font-bold text-yellow-400">{result.code}</span>
              <a href={result.url} target="_blank" rel="noreferrer" className="text-xs bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded font-bold">
                Open in SportyBet ↗
              </a>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        {!active ? (
          <button
            onClick={handleStart}
            disabled={loading}
            className="px-5 py-2.5 bg-yellow-500 hover:bg-yellow-400 text-black font-bold rounded-lg transition"
          >
            {loading ? 'Activating…' : '🎯 Activate Quest Special'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg transition"
          >
            🛑 Stop Scanning
          </button>
        )}
        <span className="text-sm text-gray-400">{statusText}</span>
      </div>
    </div>
  );
}
```
  "scans": 3,
  "runningFor": 24,
  "dailyUsed": 1,
  "maxDaily": 20,
  "lastResult": null
}
```

#### Response When Game Found (`200 OK`)
```json
{
  "success": true,
  "userId": "6916043986",
  "active": false,
  "dailyUsed": 1,
  "maxDaily": 20,
  "lastResult": {
    "code": "BC9X2A",
    "url": "https://www.sportybet.com/ng/?shareCode=BC9X2A",
    "home": "Manchester City",
    "away": "Liverpool",
    "league": "vFootball Premier League",
    "minute": 80,
    "homeScore": 0,
    "awayScore": 2,
    "analysis": {
      "window": "80min",
      "type": "match_winner",
      "description": "Away to Win (0-2 at 80')",
      "odds": 1.12,
      "reasoning": "Away leads 0-2 by 2 goals at 80'. Strong Match Winner."
    },
    "timestamp": 1741234567890
  }
}
```

---

### Stop Background Session
Cancels active scanning if the user navigates away or cancels:

- **Endpoint:** `/api/quest-special/stop`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`

```json
{
  "userId": "6916043986"
}
```

---

### Instant Live Scan (One-Off)
Directly probes live in-play vFootball fixtures right now without starting a background poller:

- **Endpoint:** `/api/quest-special/scan`
- **Method:** `GET`

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

## 4. Payment & QuestPay Checkout

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

## 5. Next.js / TypeScript Integration Client

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
}

export interface GenerateResponse {
  success: boolean;
  sport: string;
  count: number;
  cached?: boolean;
  codes?: SportyCode[];
  lines?: string[];
  message?: string;
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

export interface QuestSpecialStatusResponse {
  success: boolean;
  userId: string;
  active: boolean;
  scans: number;
  runningFor: number;
  dailyUsed: number;
  maxDaily: number;
  lastResult: {
    code: string | null;
    url: string | null;
    home: string;
    away: string;
    league?: string;
    minute: number;
    homeScore: number;
    awayScore: number;
    analysis: {
      window: string;
      type: string;
      description: string;
      odds: number;
      reasoning: string;
    };
    timestamp: number;
  } | null;
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
export async function startQuestSpecial(userId: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/quest-special/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
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
export async function scanQuestSpecialLive(): Promise<{ success: boolean; found: boolean; signal?: any; message?: string }> {
  const res = await fetch(`${API_BASE}/api/quest-special/scan`, { cache: 'no-store' });
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

