'use strict';
const fs = require('fs');
const path = require('path');
const { CFG, ROOT } = require('./config');

const DB_FILE = path.join(ROOT, 'subscribers.json');
const DATA_DIR = path.join(ROOT, 'data');
const SLIPS_FILE = path.join(DATA_DIR, 'slips.json');

// Ensure local directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Environment credentials for databases
const RAW_DB_URL = process.env.DATABASE_URL || '';
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL || (RAW_DB_URL.startsWith('mongodb') ? RAW_DB_URL : '');
const POSTGRES_URL = RAW_DB_URL.startsWith('postgres') ? RAW_DB_URL : '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

// In-memory cache for sub-millisecond lookups
const subCache = new Map(); // chatId -> { expiresAt, updatedAt, meta }

let mongoClient = null;
let mongoDb = null;
let subscribersCol = null;
let slipsCol = null;
let isMongoReady = false;

let pgPool = null;
let isPgReady = false;

// ----------------------------------------------------
// 1. MongoDB Initialization (Top Priority)
// ----------------------------------------------------
if (MONGO_URI) {
  try {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });

    (async () => {
      try {
        await mongoClient.connect();
        const dbName = process.env.MONGO_DB_NAME || 'sportybet';
        mongoDb = mongoClient.db(dbName);
        subscribersCol = mongoDb.collection('subscribers');
        slipsCol = mongoDb.collection('slips');

        // Ensure indices for performance
        await subscribersCol.createIndex({ chatId: 1 }, { unique: true }).catch(() => {});
        await slipsCol.createIndex({ shareCode: 1 }).catch(() => {});
        await slipsCol.createIndex({ userId: 1 }).catch(() => {});

        isMongoReady = true;
        console.log(`✅ MongoDB connected successfully to database: "${dbName}"`);

        // Warm up in-memory cache from MongoDB
        const cursor = subscribersCol.find({});
        for await (const doc of cursor) {
          subCache.set(String(doc.chatId), {
            chatId: String(doc.chatId),
            expiresAt: Number(doc.expiresAt),
            updatedAt: Number(doc.updatedAt),
            ...doc.meta
          });
        }
      } catch (err) {
        console.error('MongoDB connection error, falling back to local storage:', err.message);
      }
    })();
  } catch (err) {
    console.warn('MongoDB client initialization failed:', err.message);
  }
}

// ----------------------------------------------------
// 2. PostgreSQL Initialization (Secondary)
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
          CREATE TABLE IF NOT EXISTS slips (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            share_code TEXT NOT NULL,
            sport TEXT NOT NULL,
            total_odds NUMERIC(8,2) NOT NULL,
            status TEXT DEFAULT 'pending',
            legs JSONB NOT NULL DEFAULT '[]'::jsonb,
            url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            settled_at TIMESTAMPTZ
          );
        `);
        client.release();
        isPgReady = true;
        console.log('✅ PostgreSQL connected and initialized');

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
// 3. Local File Helpers (Safety Fallback)
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

// Warm up local cache
const localData = loadLocalSubscribers();
for (const [id, data] of Object.entries(localData)) {
  subCache.set(String(id), data);
}

// ----------------------------------------------------
// 4. Universal Operations (Subscribers)
// ----------------------------------------------------

async function getSubscriber(chatId) {
  const id = String(chatId);
  if (subCache.has(id)) {
    return subCache.get(id);
  }

  // 1. MongoDB
  if (isMongoReady && subscribersCol) {
    try {
      const doc = await subscribersCol.findOne({ chatId: id });
      if (doc) {
        const data = {
          chatId: id,
          expiresAt: Number(doc.expiresAt),
          updatedAt: Number(doc.updatedAt),
          ...(doc.meta || {})
        };
        subCache.set(id, data);
        return data;
      }
    } catch (_) {}
  }

  // 2. PostgreSQL
  if (isPgReady && pgPool) {
    try {
      const res = await pgPool.query('SELECT * FROM subscribers WHERE chat_id = $1 LIMIT 1', [id]);
      if (res.rows.length) {
        const row = res.rows[0];
        const data = {
          chatId: id,
          expiresAt: Number(row.expires_at),
          updatedAt: Number(row.updated_at),
          ...row.meta
        };
        subCache.set(id, data);
        return data;
      }
    } catch (_) {}
  }

  // 3. Supabase REST
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?chat_id=eq.${encodeURIComponent(id)}&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        const data = {
          chatId: id,
          expiresAt: Number(row.expires_at),
          updatedAt: Number(row.updated_at),
          ...(row.meta || {})
        };
        subCache.set(id, data);
        return data;
      }
    } catch (_) {}
  }

  return null;
}

async function saveSubscriber(chatId, expiresAt, meta = {}) {
  const id = String(chatId);
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

  // 3. MongoDB
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

  // 4. PostgreSQL
  if (isPgReady && pgPool) {
    try {
      await pgPool.query(`
        INSERT INTO subscribers (chat_id, expires_at, updated_at, meta)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (chat_id) DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at,
          meta = EXCLUDED.meta
      `, [id, data.expiresAt, data.updatedAt, JSON.stringify(meta)]);
    } catch (e) {
      console.error('Failed to save subscriber to PostgreSQL:', e.message);
    }
  }

  // 5. Supabase REST
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          chat_id: id,
          expires_at: data.expiresAt,
          updated_at: data.updatedAt,
          meta
        })
      });
    } catch (_) {}
  }

  return data;
}

async function removeSubscriber(chatId) {
  const id = String(chatId);
  subCache.delete(id);

  const local = loadLocalSubscribers();
  delete local[id];
  saveLocalSubscribers(local);

  if (isMongoReady && subscribersCol) {
    try { await subscribersCol.deleteOne({ chatId: id }); } catch (_) {}
  }

  if (isPgReady && pgPool) {
    try { await pgPool.query('DELETE FROM subscribers WHERE chat_id = $1', [id]); } catch (_) {}
  }

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers?chat_id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
    } catch (_) {}
  }

  return true;
}

// ----------------------------------------------------
// 5. Universal Operations (Slips for Analytics)
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
  syncSlipToDb,
  subCache
};
