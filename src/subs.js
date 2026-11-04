'use strict';
const { CFG } = require('./config');
const { getSubscriber, saveSubscriber, removeSubscriber, subCache } = require('./db');

function isAdmin(chatId) {
  if (!CFG.ADMIN_ID) return false;
  return String(chatId) === String(CFG.ADMIN_ID);
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
  revokeSubscription,
  listSubscribers
};
