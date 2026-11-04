'use strict';
const http = require('http');
const crypto = require('crypto');
const { CFG } = require('./config');
const { parseQuestPayWebhook } = require('./questpay');
const { addSubscription } = require('./subs');

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
    // Health check
    if (req.method === 'GET' && (req.url === '/' || req.url === '/ping' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', service: 'questpay-webhook-v1', port }));
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
        if (sig && !verifySignature(rawBody, sig)) {
          console.warn('  questpay webhook: invalid signature rejected');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid signature' }));
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
