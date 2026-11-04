# SportyBet Automation & VIP Platform API Documentation

Official API documentation for the SportyBet Automation engine, Telegram bot, QuestPay v1 payment system, and Next.js web dashboard integration.

- **Production Base URL:** `https://sportybetcodeautomation.onrender.com`
- **CORS:** Enabled globally (`Access-Control-Allow-Origin: *`)
- **Protocol:** HTTPS / JSON

---

## Table of Contents
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
1. User pays ₦1,000 on Telegram via the bot (`/pay` or QuestPay link).
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
     *`🎉 Payment of ₦1,000 received! Your VIP subscription has been activated for 7 days!`*
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
      "desc": "Live background sniper: vFootball at 38′ (HT O/U) & 80′ (Late Lead)"
    }
  ]
}
```

---

## 3. Quest Special APIs (Live Sniper)

**Quest Special** is a specialized background sniper engine exclusively targeting **vFootball live games**:
- **38th-minute window (Half Time O/U):**
  - If score is `0-0` at 38′: targets **Under 0.5 HT** (halftime whistle imminent).
  - If score is `1-0+` at 38′: targets **Over 0.5 HT** (goals already scored).
- **80th-minute window (Late Match / Handicap):**
  - If a team leads by **2+ goals** (e.g. `0-2`): targets **Match Winner (1X2)** on the leader.
  - If a team leads by **1 goal** (e.g. `1-2`):
    - If the leader dominates possession/shots (or no stats available): targets **Match Winner (1X2)** on the leader.
    - If the trailing team dominates possession and shots: applies **Handicap (trailing team +1.5 / +2.0)**.
- **Delivery:** Generates a **single-leg booking code** with full breakdown, URL, and tracks it in Boom Rate analytics.
- **Quota:** VIP members only, maximum **20 signals per day**. Runs for one match cycle (~3 minutes) and auto-stops.

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
      "vfootball": { "total": 24, "boomed": 21, "lost": 3, "pending": 2, "boomRate": "87.5%" }
    },
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
      "vfootball": { "total": 0, "boomed": 0, "lost": 0, "pending": 0, "boomRate": "N/A" }
    },
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
  "amount": 1000,
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
  "amount": 1000
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

