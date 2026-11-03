'use strict';
const fs = require('fs');
const path = require('path');
const { CFG, ROOT } = require('./config');

const DB_FILE = path.join(ROOT, 'subscribers.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load subscribers.json:', e.message);
  }
  return {};
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save subscribers.json:', e.message);
  }
}

function isAdmin(chatId) {
  if (!CFG.ADMIN_ID) return false;
  return String(chatId) === String(CFG.ADMIN_ID);
}

function isSubscribed(chatId) {
  if (isAdmin(chatId)) return true;
  const db = loadDB();
  const sub = db[String(chatId)];
  if (!sub || !sub.expiresAt) return false;
  return Number(sub.expiresAt) > Date.now();
}

function getSubscription(chatId) {
  if (isAdmin(chatId)) {
    return { active: true, isAdmin: true, expiresAt: Infinity, daysLeft: 'Lifetime (Admin)' };
  }
  const db = loadDB();
  const sub = db[String(chatId)];
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
  const db = loadDB();
  const id = String(chatId);
  const currentExp = (db[id] && Number(db[id].expiresAt) > Date.now()) ? Number(db[id].expiresAt) : Date.now();
  const newExp = currentExp + (Number(days) * 24 * 3600 * 1000);

  db[id] = {
    chatId: id,
    expiresAt: newExp,
    updatedAt: Date.now(),
    ...meta
  };
  saveDB(db);
  return db[id];
}

function revokeSubscription(chatId) {
  const db = loadDB();
  const id = String(chatId);
  if (db[id]) {
    delete db[id];
    saveDB(db);
    return true;
  }
  return false;
}

function listSubscribers() {
  const db = loadDB();
  const now = Date.now();
  return Object.values(db)
    .filter(s => Number(s.expiresAt) > now)
    .map(s => ({
      chatId: s.chatId,
      daysLeft: Math.ceil((Number(s.expiresAt) - now) / (24 * 3600 * 1000)),
      expDate: new Date(Number(s.expiresAt)).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' }),
      name: s.name || 'Anonymous'
    }));
}

module.exports = {
  isAdmin,
  isSubscribed,
  getSubscription,
  addSubscription,
  revokeSubscription,
  listSubscribers
};

