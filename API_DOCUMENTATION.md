# SportyBet Automation & VIP Platform API Documentation

Official API documentation for the SportyBet Automation engine, Telegram bot, QuestPay v1 payment system, and Next.js web dashboard integration.

- **Production Base URL:** `https://sportybetcodeautomation.onrender.com`
- **CORS:** Enabled globally (`Access-Control-Allow-Origin: *`)
- **Protocol:** HTTPS / JSON

---

## Table of Contents
1. [Telegram Login & Authentication](#1-telegram-login--authentication)
   - `POST /api/auth/telegram`
   - Setup in `@BotFather`
2. [Code Generation APIs](#2-code-generation-apis)
   - `POST /api/generate`
   - `GET /api/sports`
3. [Analytics & Boom Rate APIs](#3-analytics--boom-rate-apis)
   - `GET /api/analytics/global`
   - `GET /api/analytics/user/:userId`
   - `GET /api/slips/latest`
4. [Payment & QuestPay Webhooks](#4-payment--questpay-webhooks)
   - `POST /webhook/questpay`
   - `GET /ping`
5. [Next.js / TypeScript Integration Client](#5-nextjs--typescript-integration-client)

---

## 1. Telegram Login & Authentication

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

#### Error Response (`401 Unauthorized`)
```json
{
  "success": false,
  "error": "Invalid Telegram cryptographic signature"
}
```

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
    }
  ]
}
```

---

## 2. Analytics & Boom Rate APIs

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

## 3. Payment & QuestPay Webhooks

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

## 4. Next.js / TypeScript Integration Client

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

