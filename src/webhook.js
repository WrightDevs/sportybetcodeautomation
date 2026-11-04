'use strict';
const http = require('http');
const crypto = require('crypto');
const { CFG } = require('./config');
const { parseQuestPayWebhook } = require('./questpay');
const { addSubscription, getSubscription } = require('./subs');
const { getGlobalStats, getUserStats, loadSlips } = require('./tracker');
const { generate } = require('./run');
const { PRESETS } = require('./presets');

// In-memory cache & concurrency lock for web generation
let isGenerating = false;
const codeCache = new Map(); // sport -> { data, timestamp }

/**
 * Verify QuestPay HMAC-SHA256 signature
 * Header: x-questpay-signature
 * Secret: CFG.QUESTPAY_API_KEY (or CFG.QUESTPAY_WEBHOOK_SECRET)
 */
function verifySignature(rawBody, signatureHeader) {
  const secret = CFG.QUESTPAY_WEBHOOK_SECRET || CFG.QUESTPAY_API_KEY;
  if (!secret) return true; // If no key configured, skip check
  if (!signatureHeader) return false;

  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signatureHeader).trim(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

/**
 * Verify Telegram Login Widget, Mini App initData, or OpenID Connect token
 */
function verifyTelegramAuth(data, botToken, maxAgeSec = 86400) {
  if (!data) return { ok: false, error: 'Missing Telegram authentication payload' };

  // 1. Telegram Mini App initData (passed as { initData: "..." } or raw string)
  let authData = { ...data };
  if (typeof data === 'string' || data.initData) {
    const raw = typeof data === 'string' ? data : data.initData;
    const params = new URLSearchParams(raw);
    authData = {};
    for (const [k, v] of params.entries()) {
      authData[k] = v;
    }
    if (authData.hash) {
      const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
      const { hash, ...fields } = authData;
      const checkString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
      const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
      const a = Buffer.from(expectedHash, 'utf8');
      const b = Buffer.from(String(hash).trim(), 'utf8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        let userObj = {};
        try { userObj = JSON.parse(authData.user || '{}'); } catch (_) {}
        return { ok: true, user: { ...authData, ...userObj } };
      }
    }
  }

  // 2. Telegram OpenID Connect / JS SDK (id_token JWT)
  if (authData.id_token && typeof authData.id_token === 'string') {
    try {
      const parts = authData.id_token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload && payload.id) {
          if (payload.exp && Date.now() / 1000 > payload.exp) {
            return { ok: false, error: 'Telegram ID token expired' };
          }
          return {
            ok: true,
            user: {
              id: payload.id,
              first_name: payload.given_name || payload.name || '',
              last_name: payload.family_name || '',
              username: payload.preferred_username || '',
              photo_url: payload.picture || '',
              phone_number: payload.phone_number || '',
              auth_date: payload.iat || Math.floor(Date.now() / 1000)
            }
          };
        }
      }
    } catch (_) {}
  }

  // 3. Classic Telegram Login Widget (HMAC-SHA256 with SHA256(botToken))
  if (authData.hash && authData.auth_date) {
    const authTime = Number(authData.auth_date);
    if (Math.abs(Date.now() / 1000 - authTime) > maxAgeSec) {
      return { ok: false, error: 'Auth date expired (older than 24 hours)' };
    }

    const { hash, ...fields } = authData;
    const checkString = Object.keys(fields)
      .sort()
      .map(k => `${k}=${fields[k]}`)
      .join('\n');

    const secret = crypto.createHash('sha256').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

    const a = Buffer.from(expectedHash, 'utf8');
    const b = Buffer.from(String(hash).trim(), 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, user: fields };
    }
    return { ok: false, error: 'Invalid Telegram cryptographic signature' };
  }

  return { ok: false, error: 'Missing Telegram hash or id_token' };
}

function startWebhookServer(onPaymentActivated) {
  const port = CFG.WEBHOOK_PORT || 3000;

  const server = http.createServer((req, res) => {
    // CORS headers for web client (e.g. Next.js on Vercel)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Health check
    if (req.method === 'GET' && (req.url === '/' || req.url === '/ping' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', service: 'questpay-webhook-v1', port }));
    }

    // Analytics API for Next.js Landing Page: GET /api/analytics/global
    if (req.method === 'GET' && req.url === '/api/analytics/global') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: getGlobalStats() }));
    }

    // Analytics API for Next.js User Dashboard: GET /api/analytics/user/:userId
    if (req.method === 'GET' && req.url.startsWith('/api/analytics/user/')) {
      const userId = decodeURIComponent(req.url.slice('/api/analytics/user/'.length).split('?')[0]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: getUserStats(userId) }));
    }

    // Slips API: GET /api/slips/latest
    if (req.method === 'GET' && req.url.startsWith('/api/slips/latest')) {
      const slips = loadSlips().slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: slips }));
    }

    // Available Sports API: GET /api/sports
    if (req.method === 'GET' && (req.url === '/api/sports' || req.url === '/api/presets')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        sports: [
          { id: 'football', name: 'Football', icon: '⚽', desc: 'Real fixtures, ~10 odds accumulators' },
          { id: 'efootball', name: 'eFootball', icon: '🕹', desc: 'In-play matches with 3+ margin after 40′' },
          { id: 'vfootball', name: 'vFootball', icon: '⚡', desc: 'Virtual football rapid 3-minute rounds' }
        ]
      }));
    }

    // Telegram Login Authentication: POST /api/auth/telegram
    if (req.method === 'POST' && req.url === '/api/auth/telegram') {
      let bodyStr = '';
      req.on('data', chunk => {
        bodyStr += chunk.toString();
        if (bodyStr.length > 50000) req.connection.destroy();
      });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(bodyStr); } catch (_) {}

        const verification = verifyTelegramAuth(payload, CFG.TG_TOKEN);
        if (!verification.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: verification.error || 'Invalid Telegram authentication'
          }));
        }

        const user = verification.user;
        const sub = getSubscription(user.id);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          user: {
            id: String(user.id),
            firstName: user.first_name || user.firstName || user.given_name || user.name || '',
            lastName: user.last_name || user.lastName || user.family_name || '',
            username: user.username || user.preferred_username || '',
            photoUrl: user.photo_url || user.photoUrl || user.picture || '',
            phoneNumber: user.phone_number || user.phoneNumber || null,
            authDate: Number(user.auth_date) || Number(user.iat) || Math.floor(Date.now() / 1000)
          },
          subscription: {
            active: sub.active,
            isAdmin: !!sub.isAdmin,
            daysLeft: sub.daysLeft,
            expiresAt: sub.expiresAt || null,
            expDate: sub.expDate || null
          }
        }));
      });
      return;
    }

    // Code Generator API: GET or POST /api/generate
    if ((req.method === 'GET' || req.method === 'POST') && req.url.startsWith('/api/generate')) {
      const handleGenerate = async (params) => {
        const sportKey = String(params.sport || params.preset || 'football').toLowerCase();
        const userId = params.userId || params.email || 'web_user';
        const fresh = params.fresh === true || params.fresh === 'true';

        const preset = PRESETS[sportKey];
        if (!preset) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: `Invalid sport '${sportKey}'. Valid options: football, efootball, vfootball`
          }));
        }

        // Return recent cache (within 60s) to give instant sub-50ms response if not forced fresh
        const cached = codeCache.get(sportKey);
        if (!fresh && cached && Date.now() - cached.timestamp < 60000) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            cached: true,
            sport: sportKey,
            count: cached.data.count,
            codes: cached.data.codes || [],
            lines: cached.data.lines || [],
            generatedAt: new Date(cached.timestamp).toISOString()
          }));
        }

        if (isGenerating) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            busy: true,
            message: 'Another code generation is currently in progress. Please retry in a few seconds.'
          }));
        }

        isGenerating = true;
        try {
          const result = await generate(preset, userId);

          if (!result.count) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: false,
              sport: sportKey,
              count: 0,
              message: `${preset.label}: nothing qualified right now. Check back shortly!`
            }));
          }

          codeCache.set(sportKey, { data: result, timestamp: Date.now() });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            cached: false,
            sport: sportKey,
            count: result.count,
            codes: result.codes || [],
            lines: result.lines || [],
            generatedAt: new Date().toISOString()
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: err.message
          }));
        } finally {
          isGenerating = false;
        }
      };

      if (req.method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const params = Object.fromEntries(u.searchParams.entries());
        return handleGenerate(params);
      }

      // POST request with JSON body
      let bodyStr = '';
      req.on('data', chunk => {
        bodyStr += chunk.toString();
        if (bodyStr.length > 50000) req.connection.destroy();
      });
      req.on('end', () => {
        let params = {};
        try { params = JSON.parse(bodyStr); } catch (_) {}
        return handleGenerate(params);
      });
      return;
    }

    // Webhook endpoint: /webhook/questpay, /webhook, or /api/webhook
    if (req.method === 'POST' && (req.url.startsWith('/webhook') || req.url.startsWith('/api/webhook'))) {
      let rawBody = '';
      req.on('data', chunk => {
        rawBody += chunk.toString();
        if (rawBody.length > 1e6) {
          req.connection.destroy();
        }
      });

      req.on('end', async () => {
        const sig = req.headers['x-questpay-signature'];
        console.log(`[QuestPay Webhook] Incoming POST to ${req.url}, signature: ${sig ? 'present' : 'none'}`);

        if (sig && !verifySignature(rawBody, sig)) {
          console.warn('  questpay webhook signature mismatch. Received sig:', sig);
          if (process.env.STRICT_WEBHOOK === 'true') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid signature' }));
          }
        }

        const parsed = parseQuestPayWebhook(rawBody);

        if (!parsed.ok) {
          console.log('  questpay webhook unhandled:', parsed.err || 'event ignored');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'ignored', reason: parsed.err }));
        }

        const { chatId, reference, amount, days } = parsed;
        console.log(`  questpay webhook: payment.received success for chat=${chatId} ref=${reference} amount=₦${amount}`);

        if (chatId) {
          addSubscription(chatId, days || CFG.SUB_DAYS, {
            method: 'questpay_webhook',
            reference,
            amount: amount || CFG.SUB_PRICE,
            paidAt: Date.now()
          });

          if (typeof onPaymentActivated === 'function') {
            await onPaymentActivated(chatId, reference, amount);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: 'Webhook processed', chatId, reference }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`questpay webhook server listening on port ${port} (/webhook/questpay)`);
  });

  return server;
}

module.exports = { startWebhookServer, verifySignature, verifyTelegramAuth };
