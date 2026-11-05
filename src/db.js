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

// Ensure local directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

let mongoClient = null;
let mongoDb = null;
let subscribersCol = null;
let usersCol = null;
let slipsCol = null;
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

// Initial warm up from local backup
const localData = loadLocalSubscribers();
for (const [id, data] of Object.entries(localData)) {
  subCache.set(String(id), data);
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

        // Ensure indices for performance
        await subscribersCol.createIndex({ chatId: 1 }, { unique: true }).catch(() => {});
        await slipsCol.createIndex({ shareCode: 1 }).catch(() => {});
        await slipsCol.createIndex({ userId: 1 }).catch(() => {});
        await usersCol.createIndex({ telegramId: 1 }).catch(() => {});
        await usersCol.createIndex({ email: 1 }).catch(() => {});

        isMongoReady = true;
        console.log(`✅ MongoDB Atlas connected successfully to database: "${dbName}"`);

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

module.exports = {
  getSubscriber,
  saveSubscriber,
  removeSubscriber,
  findUser,
  syncSlipToDb,
  subCache
};
