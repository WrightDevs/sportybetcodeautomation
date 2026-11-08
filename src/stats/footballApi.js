'use strict';
/**
 * 5DollarFootballAPI Client
 * Docs: https://5dollarfootballapi.com/docs
 * Base URL: https://api.5dollarfootballapi.com/v1
 * Features:
 *  - Bearer token authentication
 *  - Multi-tier caching (in-memory + disk at data/stats_cache.json)
 *  - Rate-limit aware throttling (max 20/min burst, 60/hr limit)
 */

const fs = require('fs');
const path = require('path');
const { CFG } = require('../config');

const CACHE_FILE = path.join(__dirname, '../../data/stats_cache.json');
const memCache = new Map();

// Rate limit tracker
const requestTimestamps = [];
const BURST_LIMIT = 18; // conservative cap below 20/min
const HOURLY_LIMIT = 55; // conservative cap below 60/hr

function ensureDataDir() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (v && v.expiresAt > now) {
          memCache.set(k, v);
        }
      }
    }
  } catch (_) {}
}

function saveDiskCache() {
  try {
    ensureDataDir();
    const obj = {};
    const now = Date.now();
    for (const [k, v] of memCache.entries()) {
      if (v && v.expiresAt > now) {
        obj[k] = v;
      }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {}
}

loadDiskCache();

function getCached(key) {
  const item = memCache.get(key);
  if (item && item.expiresAt > Date.now()) {
    return item.data;
  }
  return null;
}

function setCache(key, data, ttlMs = CFG.FOOTBALL_API_CACHE_TTL_MS) {
  const entry = { data, expiresAt: Date.now() + ttlMs };
  memCache.set(key, entry);
  saveDiskCache();
}

function canMakeRequest() {
  const now = Date.now();
  // Clean older than 1 hour
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 3600000) {
    requestTimestamps.shift();
  }
  const lastMinute = requestTimestamps.filter(t => t > now - 60000).length;
  const lastHour = requestTimestamps.length;
  return lastMinute < BURST_LIMIT && lastHour < HOURLY_LIMIT;
}

/**
 * Perform authenticated request to 5DollarFootballAPI
 */
async function apiRequest(endpoint, params = {}) {
  const apiKey = CFG.FOOTBALL_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'No FOOTBALL_API_KEY configured' };
  }

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) query.set(k, String(v));
  }
  const qs = query.toString();
  const url = `${CFG.FOOTBALL_API_BASE.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}${qs ? '?' + qs : ''}`;
  const cacheKey = `req:${url}`;

  const cached = getCached(cacheKey);
  if (cached) {
    return { ok: true, data: cached, fromCache: true };
  }

  if (!canMakeRequest()) {
    return { ok: false, error: '5DollarFootballAPI rate limit guard reached (wait for window)', rateLimited: true };
  }

  const timeoutMs = CFG.FOOTBALL_API_TIMEOUT_MS || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    requestTimestamps.push(Date.now());
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }

    const json = await res.json();
    if (json.success === 1 && json.data) {
      setCache(cacheKey, json.data);
      return { ok: true, data: json.data, fromCache: false };
    } else {
      return { ok: false, error: json.error?.message || 'API returned failure envelope' };
    }
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? 'API request timed out' : err.message };
  }
}

/**
 * Get supported leagues (e.g. Premier League, La Liga, Serie A, Bundesliga, Ligue 1)
 */
async function getLeagues() {
  return apiRequest('leagues');
}

/**
 * Get standings table for a league
 * @param {string|number} leagueId 
 */
async function getStandings(leagueId) {
  if (!leagueId) return { ok: false, error: 'leagueId required' };
  return apiRequest('standings', { league: leagueId });
}

/**
 * Get team details and recent fixtures
 * @param {string|number} teamId 
 */
async function getTeamFixtures(teamId) {
  if (!teamId) return { ok: false, error: 'teamId required' };
  return apiRequest(`teams/${encodeURIComponent(teamId)}/fixtures`);
}

/**
 * Get all today's fixtures
 */
async function getTodayFixtures() {
  return apiRequest('fixtures');
}

function clearCache() {
  memCache.clear();
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch (_) {}
}

module.exports = {
  apiRequest,
  getLeagues,
  getStandings,
  getTeamFixtures,
  getTodayFixtures,
  clearCache,
  getCached,
  setCache
};
