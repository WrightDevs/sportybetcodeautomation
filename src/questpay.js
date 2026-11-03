'use strict';
const { CFG } = require('./config');

/**
 * Verify a QuestPay transaction reference
 * Supports both direct QuestPay API verification and fallback verification
 */
async function verifyQuestPay(reference) {
  if (!reference) {
    return { ok: false, err: 'Reference is required' };
  }

  const cleanRef = reference.trim();

  // If QuestPay API key is provided, query the QuestPay API
  if (CFG.QUESTPAY_API_KEY) {
    const baseUrl = CFG.QUESTPAY_API_URL || 'https://api.questpay.ng/v1';
    const urls = [
      `${baseUrl}/transaction/verify/${encodeURIComponent(cleanRef)}`,
      `${baseUrl}/payments/verify/${encodeURIComponent(cleanRef)}`,
      `${baseUrl}/verify/${encodeURIComponent(cleanRef)}`
    ];

    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${CFG.QUESTPAY_API_KEY}`
          }
        });

        if (r.status === 404) continue;

        const j = await r.json().catch(() => ({}));
        const data = j.data || j;
        const status = String(data.status || j.status || '').toLowerCase();
        const amount = Number(data.amount || j.amount || 0);

        if (['success', 'successful', 'paid', 'completed'].includes(status)) {
          // Extract chatId from metadata, customer, or reference
          const chatId = data.metadata?.chatId || data.chatId || data.customer?.chatId || null;
          return {
            ok: true,
            status: 'success',
            chatId,
            amount,
            reference: cleanRef,
            data
          };
        }
        if (status) {
          return { ok: false, status, err: `Transaction status is '${status}'` };
        }
      } catch (e) {
        // try next endpoint URL
      }
    }
  }

  return { ok: false, err: 'Could not verify automatically via QuestPay API' };
}

/**
 * Parse an incoming QuestPay webhook payload
 */
function parseQuestPayWebhook(body) {
  try {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    const payload = data.data || data;

    const status = String(payload.status || data.status || data.event || '').toLowerCase();
    const isSuccess = ['success', 'successful', 'paid', 'completed', 'charge.success', 'payment.success'].some(s => status.includes(s));

    if (!isSuccess) {
      return { ok: false, status, err: 'Transaction not successful' };
    }

    const reference = payload.reference || payload.tx_ref || payload.transaction_ref || payload.id || null;
    const amount = Number(payload.amount || data.amount || 0);

    // Look for chatId in metadata or email (e.g. user_6916043986@...)
    let chatId = payload.metadata?.chatId || data.metadata?.chatId || payload.chatId || null;
    if (!chatId) {
      const email = payload.customer?.email || payload.email || '';
      const m = /user_(\d+)@/.exec(email);
      if (m) chatId = m[1];
    }

    return {
      ok: true,
      chatId,
      reference,
      amount,
      raw: data
    };
  } catch (e) {
    return { ok: false, err: 'Invalid JSON payload: ' + e.message };
  }
}

module.exports = {
  verifyQuestPay,
  parseQuestPayWebhook
};
