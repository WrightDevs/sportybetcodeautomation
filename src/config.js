'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');

if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const E = (k, d) => process.env[k] ?? d;
const N = (k, d) => Number(E(k, d));
const list = (k, d) => E(k, d).split(',').map(s => s.trim()).filter(Boolean);

const CFG = {
  REGION: E('REGION', 'gh').toLowerCase(),
  LIVE_ENDPOINT: E('LIVE_ENDPOINT', 'inplayEvents'),
  SPORTS: list('SPORTS', 'sr:sport:1'),
  SURE_ONLY: E('SURE_ONLY', 'true') === 'true',
  VIRTUAL_WINDOW_MIN: N('VIRTUAL_WINDOW_MIN', 25),
  VIRTUAL_LEAGUE_CAP: N('VIRTUAL_LEAGUE_CAP', 40),
  MIN_ODDS: N('MIN_ODDS', 1.05),
  MAX_ODDS: N('MAX_ODDS', 1.25),
  TARGET: N('TARGET', 150),
  TARGET_ODDS: N('TARGET_ODDS', 0),
  LEGS_PER_CODE: Math.min(50, N('LEGS_PER_CODE', 50)),
  MAX_CODES: N('MAX_CODES', 4),
  GAP_MS: N('GAP_MS', 90000),
  LEAGUE_CAP: N('LEAGUE_CAP', 6),
  USE_LLM: E('USE_LLM', 'true') === 'true',
  LLM_URL: E('LLM_URL', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
  LLM_MODEL: E('LLM_MODEL', 'gemini-3.8-flash'),
  LLM_KEY: E('LLM_KEY', ''),
  TG_TOKEN: E('TG_TOKEN', ''),
  TG_CHAT: E('TG_CHAT', ''),
  OUT_DIR: path.join(ROOT, 'codes'),

  // VIP Subscription & Billing
  ADMIN_ID: E('ADMIN_ID', '6916043986'),
  SUB_PRICE: N('SUB_PRICE', 1000),
  SUB_DAYS: N('SUB_DAYS', 7),
  WEBHOOK_PORT: N('WEBHOOK_PORT', 3000),
  QUESTPAY_LINK: E('QUESTPAY_LINK', ''),
  QUESTPAY_API_KEY: E('QUESTPAY_API_KEY', ''),
  QUESTPAY_API_URL: E('QUESTPAY_API_URL', 'https://api.questpay.ng/v1'),
  QUESTPAY_WEBHOOK_SECRET: E('QUESTPAY_WEBHOOK_SECRET', ''),
  BANK_NAME: E('BANK_NAME', 'OPay'),
  ACCOUNT_NUMBER: E('ACCOUNT_NUMBER', ''),
  ACCOUNT_NAME: E('ACCOUNT_NAME', '')
};

CFG.VIRTUAL = CFG.SPORTS.some(s => s !== 'sr:sport:1');

module.exports = { CFG, ROOT };
