'use strict';
const http = require('http');
const crypto = require('crypto');
const { CFG } = require('./config');
const { parseQuestPayWebhook } = require('./questpay');
const { addSubscription } = require('./subs');
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

module.exports = { startWebhookServer, verifySignature };
