'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { CFG, ROOT } = require('./config');

// Ensure reliable SRV DNS resolution across all networks/ISPs
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

const DB_FILE = path.join(ROOT, 'subscribers.json');
const DATA_DIR = path.join(ROOT, 'data');
const SLIPS_FILE = path.join(DATA_DIR, 'slips.json');
const USAGE_FILE = path.join(DATA_DIR, 'quest_usage.json');
const PAID_REFS_FILE = process.env.PAID_REFS_FILE || path.join(DATA_DIR, 'paid_refs.json');

// Ensure local directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Environment credentials for databases (Always fallback to Atlas Cloud app database)
const MONGO_FALLBACK = 'mongodb+srv://giftjacksun_db_user:RWSadh1hEdJrJBgX@cluster0.2rcvw7a.mongodb.net/app';
const RAW_DB_URL = process.env.DATABASE_URL || '';
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL || CFG.MONGODB_URI || (RAW_DB_URL.startsWith('mongodb') ? RAW_DB_URL : MONGO_FALLBACK);
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || CFG.MONGO_DB_NAME || 'app';

const POSTGRES_URL = RAW_DB_URL.startsWith('postgres') ? RAW_DB_URL : '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

// In-memory cache for sub-millisecond lookups across all aliases
const subCache = new Map(); // identifier (chatId, email, _id, username) -> { expiresAt, updatedAt, meta }
const questUsageCache = new Map(); // userId -> { date, count, updatedAt }

let mongoClient = null;
let mongoDb = null;
let subscribersCol = null;
let usersCol = null;
let slipsCol = null;
let questUsageCol = null;
let paidRefsCol = null;
let checkoutsCol = null;
let isMongoReady = false;
let mongoConnectPromise = null;

async function ensureMongo() {
  if (mongoConnectPromise) {
    try { await mongoConnectPromise; } catch (_) {}
  }
}

let pgPool = null;
let isPgReady = false;

// ----------------------------------------------------
// 1. Local File Helpers (Safety Fallback)
// ----------------------------------------------------
function loadLocalSubscribers() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {};
    }
  } catch (_) {}
  return {};
}

function saveLocalSubscribers(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (_) {}
}

function loadLocalQuestUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) || {};
    }
  } catch (_) {}
  return {};
}

function saveLocalQuestUsage(data) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

// Initial warm up from local backup
const localData = loadLocalSubscribers();
for (const [id, data] of Object.entries(localData)) {
  subCache.set(String(id), data);
}

// Payment references that already credited a subscription (idempotency: webhook retries, repeated verify calls)
const paidRefs = new Set();
function loadPaidRefs() {
  try {
    if (fs.existsSync(PAID_REFS_FILE)) {
      for (const r of (JSON.parse(fs.readFileSync(PAID_REFS_FILE, 'utf8')) || [])) paidRefs.add(String(r));
    }
  } catch (_) {}
}
function savePaidRefs() {
  try { fs.writeFileSync(PAID_REFS_FILE, JSON.stringify([...paidRefs].slice(-5000)), 'utf8'); } catch (_) {}
}
loadPaidRefs();

// Issued checkouts per user and the ones voided because another checkout of the same user was credited first
// (one transfer must never be able to settle several open checkouts).
const CHECKOUTS_FILE = process.env.CHECKOUTS_FILE || PAID_REFS_FILE.replace(/\.json$/, '') + '.checkouts.json';
const checkouts = new Map(); // ref -> { userKey, at, voided }
try {
  if (fs.existsSync(CHECKOUTS_FILE)) {
    for (const [ref, v] of Object.entries(JSON.parse(fs.readFileSync(CHECKOUTS_FILE, 'utf8')) || {})) checkouts.set(ref, v);
  }
} catch (_) {}
function saveCheckouts() {
  try {
    const entries = [...checkouts.entries()].slice(-5000);
    fs.writeFileSync(CHECKOUTS_FILE, JSON.stringify(Object.fromEntries(entries)), 'utf8');
  } catch (_) {}
}

const localUsage = loadLocalQuestUsage();
for (const [uid, item] of Object.entries(localUsage)) {
  questUsageCache.set(String(uid), item);
}

// ----------------------------------------------------
// 2. User Profile Multi-Key Resolution
// ----------------------------------------------------
async function findUser(q) {
  if (!q) return null;
  const str = String(q).trim();
  if (!str) return null;

  await ensureMongo();

  if (isMongoReady && usersCol) {
    try {
      const { ObjectId } = require('mongodb');
      const orList = [
        { telegramId: str },
        { email: str.toLowerCase() },
        { username: str.toLowerCase() }
      ];
      if (ObjectId.isValid(str) && str.length === 24) {
        orList.push({ _id: new ObjectId(str) });
      }
      return await usersCol.findOne({ $or: orList });
    } catch (_) {}
  }
  return null;
}

// ----------------------------------------------------
// 3. MongoDB Initialization (Persistent Cloud Atlas)
// ----------------------------------------------------
if (MONGO_URI) {
  try {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000
    });

    mongoConnectPromise = (async () => {
      try {
        await mongoClient.connect();
        mongoDb = mongoClient.db(MONGO_DB_NAME);
        const dbName = mongoDb.databaseName || 'app';
        subscribersCol = mongoDb.collection('subscribers');
        usersCol = mongoDb.collection('users');
        slipsCol = mongoDb.collection('slips');
        questUsageCol = mongoDb.collection('quest_usage');
        paidRefsCol = mongoDb.collection('paid_refs');
        await paidRefsCol.createIndex({ ref: 1 }, { unique: true }).catch(() => {});
        checkoutsCol = mongoDb.collection('checkout_refs');
        await checkoutsCol.createIndex({ ref: 1 }, { unique: true }).catch(() => {});
        await checkoutsCol.createIndex({ userKey: 1 }).catch(() => {});

        // Ensure indices for performance
        await subscribersCol.createIndex({ chatId: 1 }, { unique: true }).catch(() => {});
        await slipsCol.createIndex({ shareCode: 1 }).catch(() => {});
        await slipsCol.createIndex({ userId: 1 }).catch(() => {});
        await usersCol.createIndex({ telegramId: 1 }).catch(() => {});
        await usersCol.createIndex({ email: 1 }).catch(() => {});
        await questUsageCol.createIndex({ userId: 1, date: 1 }).catch(() => {});

        isMongoReady = true;
        console.log(`✅ MongoDB Atlas connected successfully to database: "${dbName}"`);

        // Warm up quest usage directly from MongoDB for today
        try {
          const today = todayStr();
          const todayUsageDocs = await questUsageCol.find({ date: today }).toArray();
          for (const doc of todayUsageDocs) {
            questUsageCache.set(String(doc.userId), {
              date: doc.date,
              count: Number(doc.count || 0),
              updatedAt: Number(doc.updatedAt || Date.now())
            });
          }
        } catch (_) {}

        // 1. Warm up in-memory cache directly from MongoDB subscribers collection
        const allDocs = await subscribersCol.find({}).toArray();
        for (const doc of allDocs) {
          const entry = {
            chatId: String(doc.chatId),
            expiresAt: Number(doc.expiresAt),
            updatedAt: Number(doc.updatedAt || Date.now()),
            ...(doc.meta || {})
          };
          subCache.set(String(doc.chatId), entry);
        }

        // 2. Cross-link and sync with all user profiles in MongoDB users collection
        const allUsers = await usersCol.find({}).toArray();
        for (const user of allUsers) {
          const tId = user.telegramId ? String(user.telegramId) : null;
          const uId = user._id ? user._id.toString() : null;
          const uEmail = user.email ? String(user.email).toLowerCase() : null;
          const uName = user.username ? String(user.username).toLowerCase() : null;

          // Check if user has active subscription under any key
          let activeSub = null;
          for (const k of [tId, uId, uEmail, uName]) {
            if (k && subCache.has(k)) {
              const s = subCache.get(k);
              if (s && Number(s.expiresAt) > Date.now()) {
                activeSub = s;
                break;
              }
            }
          }

          if (activeSub) {
            // Mirror active subscription to ALL connected profile keys
            const keys = [tId, uId, uEmail, uName].filter(Boolean);
            for (const key of keys) {
              subCache.set(key, activeSub);
            }
            // Update user document in MongoDB users collection
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { isVip: true, vipExpiresAt: activeSub.expiresAt, updatedAt: new Date() } }
            ).catch(() => {});
          }
        }

        // 3. Auto-migrate any local subscribers into MongoDB
        const localSubs = loadLocalSubscribers();
        for (const [chatId, data] of Object.entries(localSubs)) {
          if (!subCache.has(String(chatId))) {
            await subscribersCol.updateOne(
              { chatId: String(chatId) },
              { $set: { chatId: String(chatId), expiresAt: data.expiresAt, updatedAt: data.updatedAt || Date.now(), meta: data } },
              { upsert: true }
            ).catch(() => {});
            subCache.set(String(chatId), data);
          }
        }
      } catch (err) {
        console.error('MongoDB Atlas connection error, using local storage fallback:', err.message);
      }
    })();
  } catch (err) {
    console.warn('MongoDB client initialization failed:', err.message);
  }
}

// ----------------------------------------------------
// 4. PostgreSQL Initialization (Secondary)
// ----------------------------------------------------
if (!MONGO_URI && POSTGRES_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: POSTGRES_URL,
      ssl: POSTGRES_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    (async () => {
      try {
        const client = await pgPool.connect();
        await client.query(`
          CREATE TABLE IF NOT EXISTS subscribers (
            chat_id TEXT PRIMARY KEY,
            expires_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            meta JSONB DEFAULT '{}'::jsonb
          );
        `);
        client.release();
        isPgReady = true;

        const res = await pgPool.query('SELECT * FROM subscribers');
        for (const row of res.rows) {
          subCache.set(String(row.chat_id), {
            chatId: String(row.chat_id),
            expiresAt: Number(row.expires_at),
            updatedAt: Number(row.updated_at),
            ...row.meta
          });
        }
      } catch (e) {
        console.error('PostgreSQL connection error:', e.message);
      }
    })();
  } catch (e) {
    console.warn('PostgreSQL pool init failed:', e.message);
  }
}

// ----------------------------------------------------
// 5. Universal Operations (Subscribers & Profile 2-Way Sync)
// ----------------------------------------------------

async function getSubscriber(chatId) {
  if (!chatId) return null;
  const id = String(chatId).trim();
  const now = Date.now();

  // 1. In-memory check
  if (subCache.has(id)) {
    const cached = subCache.get(id);
    if (cached && Number(cached.expiresAt) > now) {
      return cached;
    }
  }

  await ensureMongo();

  // 2. Direct MongoDB subscribers collection lookup
  if (isMongoReady && subscribersCol) {
    try {
      const doc = await subscribersCol.findOne({ chatId: id });
      if (doc && Number(doc.expiresAt) > now) {
        const data = {
          chatId: id,
          expiresAt: Number(doc.expiresAt),
          updatedAt: Number(doc.updatedAt || now),
          ...(doc.meta || {})
        };
        subCache.set(id, data);
        return data;
      }
    } catch (_) {}
  }

  // 3. User profile resolution (Cross-sync: email, _id, telegramId, username)
  if (isMongoReady && usersCol) {
    try {
      const user = await findUser(id);
      if (user) {
        const tId = user.telegramId ? String(user.telegramId) : null;
        const uId = user._id ? user._id.toString() : null;
        const uEmail = user.email ? String(user.email).toLowerCase() : null;
        const uName = user.username ? String(user.username).toLowerCase() : null;

        // Check if ANY linked alias has active VIP
        const candidates = [tId, uId, uEmail, uName].filter(Boolean);
        for (const cand of candidates) {
          if (subCache.has(cand)) {
            const s = subCache.get(cand);
            if (s && Number(s.expiresAt) > now) {
              // Replicate to all aliases
              for (const k of candidates) subCache.set(k, s);
              return s;
            }
          }
          if (subscribersCol) {
            const doc = await subscribersCol.findOne({ chatId: cand });
            if (doc && Number(doc.expiresAt) > now) {
              const data = {
                chatId: cand,
                expiresAt: Number(doc.expiresAt),
                updatedAt: Number(doc.updatedAt || now),
                ...(doc.meta || {})
              };
              for (const k of candidates) subCache.set(k, data);
              return data;
            }
          }
        }

        // Check if user document itself has active vipExpiresAt
        if (user.vipExpiresAt && Number(user.vipExpiresAt) > now) {
          const data = {
            chatId: id,
            expiresAt: Number(user.vipExpiresAt),
            updatedAt: now,
            isVip: true
          };
          for (const k of candidates) subCache.set(k, data);
          return data;
        }
      }
    } catch (_) {}
  }

  return null;
}

async function saveSubscriber(chatId, expiresAt, meta = {}) {
  await ensureMongo();
  const id = String(chatId).trim();
  const data = {
    chatId: id,
    expiresAt: Number(expiresAt),
    updatedAt: Date.now(),
    ...meta
  };

  // 1. In-memory
  subCache.set(id, data);

  // 2. Local File backup
  const local = loadLocalSubscribers();
  local[id] = data;
  saveLocalSubscribers(local);

  // 3. MongoDB subscribers collection
  if (isMongoReady && subscribersCol) {
    try {
      await subscribersCol.updateOne(
        { chatId: id },
        { $set: { chatId: id, expiresAt: data.expiresAt, updatedAt: data.updatedAt, meta } },
        { upsert: true }
      );
    } catch (e) {
      console.error('Failed to save subscriber to MongoDB:', e.message);
    }
  }

  // 4. Cross-sync: Link to MongoDB users collection (unifies web + bot)
  if (isMongoReady && usersCol) {
    try {
      const user = await findUser(id);
      if (user) {
        const tId = user.telegramId ? String(user.telegramId) : null;
        const uId = user._id ? user._id.toString() : null;
        const uEmail = user.email ? String(user.email).toLowerCase() : null;
        const uName = user.username ? String(user.username).toLowerCase() : null;

        const aliases = [tId, uId, uEmail, uName].filter(Boolean);
        for (const alias of aliases) {
          subCache.set(alias, data);
          if (subscribersCol && alias !== id) {
            await subscribersCol.updateOne(
              { chatId: alias },
              { $set: { chatId: alias, expiresAt: data.expiresAt, updatedAt: data.updatedAt, meta } },
              { upsert: true }
            ).catch(() => {});
          }
        }

        // Mark user document in users collection as VIP
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { isVip: true, vipExpiresAt: data.expiresAt, updatedAt: new Date() } }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to cross-sync user profile in MongoDB:', e.message);
    }
  }

  return data;
}

async function removeSubscriber(chatId) {
  const id = String(chatId).trim();
  subCache.delete(id);

  const local = loadLocalSubscribers();
  delete local[id];
  saveLocalSubscribers(local);

  if (isMongoReady && subscribersCol) {
    try { await subscribersCol.deleteOne({ chatId: id }); } catch (_) {}
  }

  if (isMongoReady && usersCol) {
    try {
      const user = await findUser(id);
      if (user) {
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { isVip: false, vipExpiresAt: 0, updatedAt: new Date() } }
        ).catch(() => {});
      }
    } catch (_) {}
  }

  return true;
}

// ----------------------------------------------------
// 6. Universal Operations (Slips for Analytics)
// ----------------------------------------------------
async function syncSlipToDb(slip) {
  if (isMongoReady && slipsCol) {
    try {
      await slipsCol.updateOne(
        { id: slip.id },
        { $set: slip },
        { upsert: true }
      );
    } catch (e) {
      console.error('Failed to sync slip to MongoDB:', e.message);
    }
  }
}

// ----------------------------------------------------
// 7. Quest Special Daily Usage Persistence
// ----------------------------------------------------
function getQuestUsage(userId) {
  const id = String(userId || '').trim();
  const today = todayStr();
  const item = questUsageCache.get(id);
  return (item && item.date === today) ? item.count : 0;
}

async function incrementQuestUsage(userId) {
  const id = String(userId || '').trim();
  const today = todayStr();
  const current = getQuestUsage(id);
  const newCount = current + 1;
  const entry = { date: today, count: newCount, updatedAt: Date.now() };

  questUsageCache.set(id, entry);

  // 1. Local backup
  const local = loadLocalQuestUsage();
  local[id] = entry;
  saveLocalQuestUsage(local);

  // 2. MongoDB upsert
  if (isMongoReady && questUsageCol) {
    try {
      await questUsageCol.updateOne(
        { userId: id, date: today },
        { $set: { userId: id, date: today, count: newCount, updatedAt: entry.updatedAt } },
        { upsert: true }
      );
    } catch (e) {
      console.error('Failed to persist quest_usage to MongoDB:', e.message);
    }
  }

  return newCount;
}

/**
 * Claim a payment reference so it can credit a subscription only once.
 * Returns true if this call is the first claim, false if the reference was already credited.
 * A missing reference cannot be de-duplicated, so it returns true.
 * Atomic within a process (in-memory Set) and across processes/restarts (unique index in MongoDB).
 */
async function claimPaymentRef(reference, meta = {}) {
  const ref = String(reference || '').trim();
  if (!ref) return true;
  if (paidRefs.has(ref)) return false;
  paidRefs.add(ref); // claim synchronously so concurrent callers in this process lose the race
  savePaidRefs();

  await ensureMongo();
  if (isMongoReady && paidRefsCol) {
    try {
      await paidRefsCol.insertOne({ ref, claimedAt: new Date(), ...meta });
    } catch (e) {
      if (e && e.code === 11000) return false; // already credited earlier (another instance / before a restart)
      console.error('Failed to persist paid reference:', e.message);
    }
  }
  return true;
}

/** Undo a claim when crediting failed after the claim, so the payment can be retried. */
async function releasePaymentRef(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return;
  paidRefs.delete(ref);
  savePaidRefs();
  if (isMongoReady && paidRefsCol) {
    try { await paidRefsCol.deleteOne({ ref }); } catch (_) {}
  }
}

/** Stable per-person key: the user document _id when the id resolves to a user, otherwise the id itself. */
async function userKeyOf(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return '';
  try {
    const u = await findUser(id);
    if (u && u._id) return String(u._id);
  } catch (_) {}
  return id;
}

/** Remember that a checkout reference was issued to this person. */
async function registerCheckout(reference, chatId) {
  const ref = String(reference || '').trim();
  if (!ref) return;
  const userKey = await userKeyOf(chatId);
  checkouts.set(ref, { userKey, at: Date.now(), voided: false });
  saveCheckouts();
  if (isMongoReady && checkoutsCol) {
    try { await checkoutsCol.insertOne({ ref, userKey, voided: false, createdAt: new Date() }); } catch (_) {}
  }
}

async function isRefVoided(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return false;
  const c = checkouts.get(ref);
  if (c && c.voided) return true;
  if (isMongoReady && checkoutsCol) {
    try {
      const d = await checkoutsCol.findOne({ ref });
      if (d && d.voided) { checkouts.set(ref, { ...(c || {}), userKey: d.userKey, voided: true }); return true; }
    } catch (_) {}
  }
  return false;
}

/** After one checkout of this person was credited, void every other checkout issued to them. */
async function voidOtherCheckouts(chatId, exceptRef) {
  const userKey = await userKeyOf(chatId);
  const keep = String(exceptRef || '').trim();
  if (!userKey) return 0;
  let n = 0;
  for (const [ref, c] of checkouts) {
    if (ref !== keep && c.userKey === userKey && !c.voided) { c.voided = true; n++; }
  }
  if (n) saveCheckouts();
  if (isMongoReady && checkoutsCol) {
    try { await checkoutsCol.updateMany({ userKey, ref: { $ne: keep }, voided: { $ne: true } }, { $set: { voided: true, voidedAt: new Date() } }); } catch (_) {}
  }
  return n;
}

module.exports = {
  registerCheckout,
  isRefVoided,
  voidOtherCheckouts,
  claimPaymentRef,
  releasePaymentRef,
  getSubscriber,
  saveSubscriber,
  removeSubscriber,
  findUser,
  syncSlipToDb,
  subCache,
  getQuestUsage,
  incrementQuestUsage
};
