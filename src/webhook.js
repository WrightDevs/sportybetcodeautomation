'use strict';
const http = require('http');
const { CFG } = require('./config');
const { parseQuestPayWebhook } = require('./questpay');
const { addSubscription } = require('./subs');

function startWebhookServer(onPaymentActivated) {
  const port = CFG.WEBHOOK_PORT || 3000;

  const server = http.createServer((req, res) => {
    // Health check
    if (req.method === 'GET' && (req.url === '/' || req.url === '/ping' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', service: 'questpay-webhook-v1', port }));
    }

    // Webhook endpoint: /webhook/questpay or /webhook
    if (req.method === 'POST' && (req.url.startsWith('/webhook') || req.url.startsWith('/api/webhook'))) {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 1e6) {
          req.connection.destroy();
        }
      });

      req.on('end', async () => {
        const parsed = parseQuestPayWebhook(body);

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

module.exports = { startWebhookServer };
