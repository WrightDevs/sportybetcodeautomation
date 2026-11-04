'use strict';
const { CFG } = require('./config');

const BASE_URL = (CFG.QUESTPAY_API_URL || 'https://payments-api.questlabs.cc/api').replace(/\/+$/, '');

/**
 * Initialize a hosted QuestPay v1 checkout session
 * Endpoint: POST /v1/checkout/initialize
 */
async function initializeQuestPayCheckout(chatId, email = null) {
  if (!CFG.QUESTPAY_API_KEY) {
    return { ok: false, err: 'QuestPay API key (QUESTPAY_API_KEY) is not set in .env' };
  }

  // Use a valid email domain (@gmail.com) as QuestPay payment providers (Xixapay) validate MX records
  const userEmail = email || `user_${chatId}@gmail.com`;
  const reference = `VIP-${chatId}-${Date.now()}`;
  const amount = Number(CFG.SUB_PRICE) || 1000;

  try {
    const r = await fetch(`${BASE_URL}/v1/checkout/initialize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CFG.QUESTPAY_API_KEY}`,
        'x-api-key': CFG.QUESTPAY_API_KEY
      },
      body: JSON.stringify({
        reference,
        email: userEmail,
        amount,
        description: `SportyBet Codes VIP (${CFG.SUB_DAYS} Days)`,
        metadata: {
          chatId: String(chatId),
          userId: String(chatId),
          days: CFG.SUB_DAYS
        }
      })
    });

    const j = await r.json().catch(() => ({}));

    if (j.success && j.data && j.data.checkout_url) {
      // Fetch dynamic virtual bank account assigned to this checkout reference
      let virtualAccount = null;
      try {
        const pub = await fetch(`${BASE_URL}/public/checkout/${encodeURIComponent(reference)}`);
        const pubJ = await pub.json().catch(() => ({}));
        if (pubJ.success && pubJ.data?.business?.virtualAccount) {
          virtualAccount = pubJ.data.business.virtualAccount;
        }
      } catch (_) {}

      return {
        ok: true,
        reference,
        checkout_url: j.data.checkout_url,
        amount: j.data.amount || amount,
        virtualAccount,
        data: j.data
      };
    }

    const errMsg = j.message || j.error || 'Failed to initialize QuestPay checkout';
    return { ok: false, err: errMsg, raw: j };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * Verify a QuestPay v1 checkout session by reference
 * Endpoint: GET /v1/checkout/verify/:reference
 */
async function verifyQuestPayCheckout(reference) {
  if (!reference) {
    return { ok: false, err: 'Reference is required' };
  }
  if (!CFG.QUESTPAY_API_KEY) {
    return { ok: false, err: 'QuestPay API key is not configured in .env' };
  }

  const cleanRef = reference.trim();

  try {
    const r = await fetch(`${BASE_URL}/v1/checkout/verify/${encodeURIComponent(cleanRef)}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${CFG.QUESTPAY_API_KEY}`,
        'x-api-key': CFG.QUESTPAY_API_KEY
      }
    });

    const j = await r.json().catch(() => ({}));
    const data = j.data || j;

    const status = String(data.status || j.status || '').toLowerCase();
    const isPaid = status === 'paid' || status === 'success' || status === 'completed';

    if (isPaid) {
      const chatId = data.metadata?.chatId || data.metadata?.userId || null;
      const amount = data.transaction?.amount || data.amount || CFG.SUB_PRICE;
      const days = Number(data.metadata?.days) || CFG.SUB_DAYS;

      return {
        ok: true,
        status: 'paid',
        reference: cleanRef,
        chatId,
        days,
        amount,
        paidAt: data.paid_at || data.transaction?.paid_at || Date.now(),
        data
      };
    }

    return {
      ok: false,
      status: status || 'unpaid',
      err: j.message || `Checkout status is '${status || 'unpaid'}'`,
      data
    };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * Parse an incoming QuestPay webhook payload
 * Event: payment.received
 */
function parseQuestPayWebhook(body) {
  try {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    const payload = data.data || data;

    const event = String(data.event || payload.event || '').toLowerCase();
    const status = String(payload.status || data.status || '').toLowerCase();

    const isSuccess = event === 'payment.received' || status === 'paid' || status === 'success' || status === 'completed';

    if (!isSuccess) {
      return { ok: false, status, err: `Event '${event || status}' is not a completed payment` };
    }

    const reference = payload.reference || payload.tx_ref || payload.id || null;
    const amount = Number(payload.transaction?.amount || payload.amount || data.amount || 0);

    // Extract chatId from metadata or user email (user_12345@...)
    let chatId = payload.metadata?.chatId || payload.metadata?.userId || null;
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
      days: Number(payload.metadata?.days) || CFG.SUB_DAYS,
      raw: data
    };
  } catch (e) {
    return { ok: false, err: 'Invalid JSON webhook payload: ' + e.message };
  }
}

module.exports = {
  initializeQuestPayCheckout,
  verifyQuestPayCheckout,
  parseQuestPayWebhook
};
