'use strict';
const fs = require('fs');
const path = require('path');
const { CFG, ROOT } = require('./config');

const DB_FILE = path.join(ROOT, 'subscribers.json');
const DATA_DIR = path.join(ROOT, 'data');
const SLIPS_FILE = path.join(DATA_DIR, 'slips.json');

// Ensure local directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Check for PostgreSQL (Render Postgres, Neon, Supabase connection string, or Railway)
const DATABASE_URL = process.env.DATABASE_URL || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let pgPool = null;
let isPgReady = false;

// In-memory cache for ultra-fast lookups
const subCache = new Map(); // chatId -> { expiresAt, updatedAt, meta }

// ----------------------------------------------------
// 1. PostgreSQL Initialization
// ----------------------------------------------------
if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    // Auto-create required tables if they don't exist yet
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
        console.log('✅ PostgreSQL database connected and tables initialized');

        // Warm up cache from Postgres
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
        console.error('PostgreSQL connection error, falling back to local storage:', e.message);
      }
    })();
  } catch (e) {
    console.warn('pg package initialization failed, falling back:', e.message);
  }
}

// ----------------------------------------------------
// 2. Local File Helpers (Fallback)
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

// Warm up in-memory cache from local file
const localData = loadLocalSubscribers();
for (const [id, data] of Object.entries(localData)) {
  subCache.set(String(id), data);
}

// ----------------------------------------------------
// 3. Database Operations (Universal API)
// ----------------------------------------------------

async function getSubscriber(chatId) {
  const id = String(chatId);
  // Check memory cache first for instant lookup
  if (subCache.has(id)) {
    return subCache.get(id);
  }

  // If Postgres is active, query Postgres
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

  // Fallback to Supabase REST if configured
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

  // 1. Update in-memory cache
  subCache.set(id, data);

  // 2. Always write to local JSON as safety backup
  const local = loadLocalSubscribers();
  local[id] = data;
  saveLocalSubscribers(local);

  // 3. If Postgres is active, write to Postgres
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
      console.error('Failed to save subscriber to Postgres:', e.message);
    }
  }

  // 4. If Supabase REST is active, upsert to Supabase
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

  if (isPgReady && pgPool) {
    try {
      await pgPool.query('DELETE FROM subscribers WHERE chat_id = $1', [id]);
    } catch (_) {}
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

module.exports = {
  getSubscriber,
  saveSubscriber,
  removeSubscriber,
  subCache
};
