'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
  }
}

const E = (k, d) => process.env[k] ?? d;
const N = (k, d) => Number(E(k, d));

const CFG = {
  REGION: E('REGION', 'gh').toLowerCase(),
  MIN_ODDS: N('MIN_ODDS', 1.05),
  MAX_ODDS: N('MAX_ODDS', 1.25),
  TARGET: N('TARGET', 150),
  LEGS_PER_CODE: Math.min(50, N('LEGS_PER_CODE', 50)),
  MAX_CODES: N('MAX_CODES', 4),
  GAP_MS: N('GAP_MS', 90000),
  LEAGUE_CAP: N('LEAGUE_CAP', 6),
  USE_LLM: E('USE_LLM', 'true') === 'true',
  LLM_URL: E('LLM_URL', 'https://api.deepseek.com/v1/chat/completions'),
  LLM_MODEL: E('LLM_MODEL', 'deepseek-chat'),
  LLM_KEY: E('LLM_KEY', ''),
  TG_TOKEN: E('TG_TOKEN', ''),
  TG_CHAT: E('TG_CHAT', ''),
  OUT_DIR: path.join(ROOT, 'codes')
};

module.exports = { CFG, ROOT };

