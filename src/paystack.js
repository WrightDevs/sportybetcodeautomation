'use strict';
const { CFG } = require('./config');

async function initializePayment(chatId, email = null) {
  if (!CFG.PAYSTACK_SECRET) {
    return { ok: false, err: 'Paystack is not configured in .env' };
  }

  const userEmail = email || `user_${chatId}@sportybot.com`;
  const amountKobo = Math.round(Number(CFG.SUB_PRICE) * 100);

  try {
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CFG.PAYSTACK_SECRET}`
      },
      body: JSON.stringify({
        email: userEmail,
        amount: amountKobo,
        metadata: {
          chatId: String(chatId),
          days: CFG.SUB_DAYS
        }
      })
    });

    const j = await r.json();
    if (j.status && j.data) {
      return {
        ok: true,
        url: j.data.authorization_url,
        reference: j.data.reference,
        accessCode: j.data.access_code
      };
    }
    return { ok: false, err: j.message || 'Payment initialization failed' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function verifyPayment(reference) {
  if (!CFG.PAYSTACK_SECRET) {
    return { ok: false, err: 'Paystack is not configured in .env' };
  }

  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${CFG.PAYSTACK_SECRET}`
      }
    });

    const j = await r.json();
    if (j.status && j.data) {
      const data = j.data;
      const expectedKobo = Math.round(Number(CFG.SUB_PRICE) * 100);
      if (data.status === 'success' && data.amount >= expectedKobo) {
        return {
          ok: true,
          status: 'success',
          chatId: data.metadata?.chatId,
          days: data.metadata?.days || CFG.SUB_DAYS,
          amount: data.amount / 100,
          customer: data.customer
        };
      }
      return { ok: false, status: data.status, err: `Status: ${data.status} (Amount: ₦${data.amount / 100})` };
    }
    return { ok: false, err: j.message || 'Verification failed' };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

module.exports = {
  initializePayment,
  verifyPayment
};
