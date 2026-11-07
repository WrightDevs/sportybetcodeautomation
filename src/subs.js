'use strict';
const { CFG } = require('./config');
const { getSubscriber, saveSubscriber, removeSubscriber, subCache, claimPaymentRef, releasePaymentRef, isRefVoided, voidOtherCheckouts } = require('./db');

function isAdmin(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (Array.isArray(CFG.ADMIN_IDS) && CFG.ADMIN_IDS.includes(id)) return true;
  if (CFG.ADMIN_ID && id === String(CFG.ADMIN_ID).trim()) return true;
  return false;
}

function isSubscribed(chatId) {
  if (isAdmin(chatId)) return true;
  const id = String(chatId);
  const sub = subCache.get(id);
  if (!sub || !sub.expiresAt) return false;
  return Number(sub.expiresAt) > Date.now();
}

function getSubscription(chatId) {
  if (isAdmin(chatId)) {
    return { active: true, isAdmin: true, expiresAt: Infinity, daysLeft: 'Lifetime (Admin)' };
  }
  const id = String(chatId);
  const sub = subCache.get(id);
  if (!sub || !sub.expiresAt) {
    return { active: false, daysLeft: 0 };
  }
  const msLeft = Number(sub.expiresAt) - Date.now();
  if (msLeft <= 0) {
    return { active: false, daysLeft: 0, expired: true };
  }
  const daysLeft = Math.ceil(msLeft / (24 * 3600 * 1000));
  const expDate = new Date(Number(sub.expiresAt)).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos'
  });
  return { active: true, daysLeft, expiresAt: sub.expiresAt, expDate, sub };
}

function addSubscription(chatId, days = 7, meta = {}) {
  const id = String(chatId);
  const existing = subCache.get(id);
  const currentExp = (existing && Number(existing.expiresAt) > Date.now()) ? Number(existing.expiresAt) : Date.now();
  const newExp = currentExp + (Number(days) * 24 * 3600 * 1000);

  // Saves to in-memory cache, local JSON, and PostgreSQL/Supabase if configured
  saveSubscriber(id, newExp, meta);

  return {
    chatId: id,
    expiresAt: newExp,
    updatedAt: Date.now(),
    ...meta
  };
}

/**
 * Credit a paid reference at most once. Webhook retries, repeated /api/payment/verify calls and the bot's
 * verify button can all report the same payment; only the first one extends the subscription.
 * Returns { credited: true } or { credited: false, duplicate: true }.
 */
async function creditPaymentOnce(chatId, reference, days, meta = {}) {
  // A checkout voided because the same person's other checkout was already credited must not credit again
  if (await isRefVoided(reference)) {
    console.warn(`[payments] ref=${reference} reported paid but was voided (another checkout of the same user was credited first) - not credited; review manually if the user really paid twice`);
    return { credited: false, duplicate: true, superseded: true };
  }
  const fresh = await claimPaymentRef(reference, { chatId: String(chatId) });
  if (!fresh) return { credited: false, duplicate: true };
  try {
    addSubscription(chatId, days, { ...meta, reference });
  } catch (e) {
    await releasePaymentRef(reference); // let the payment be retried
    throw e;
  }
  try { await voidOtherCheckouts(chatId, reference); } catch (_) {} // never fail a successful credit
  return { credited: true, duplicate: false };
}

function revokeSubscription(chatId) {
  const id = String(chatId);
  removeSubscriber(id);
  return true;
}

function listSubscribers() {
  const now = Date.now();
  const list = [];
  for (const s of subCache.values()) {
    if (Number(s.expiresAt) > now) {
      list.push({
        chatId: s.chatId,
        daysLeft: Math.ceil((Number(s.expiresAt) - now) / (24 * 3600 * 1000)),
        expDate: new Date(Number(s.expiresAt)).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' }),
        name: s.name || s.username || 'Anonymous'
      });
    }
  }
  return list;
}

module.exports = {
  isAdmin,
  isSubscribed,
  getSubscription,
  addSubscription,
  creditPaymentOnce,
  revokeSubscription,
  listSubscribers
};
