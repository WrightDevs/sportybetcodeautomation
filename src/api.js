'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');

const API = `https://www.sportybet.com/api/${CFG.REGION}`;

// Full mobile WAP emulation headers (matches SportyBet mobile app & WAP)
const HDR = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-GB,en;q=0.9',
  'clientid': 'wap',
  'current-country': (CFG.REGION || 'gh').toLowerCase(),
  'origin': 'https://www.sportybet.com',
  'platform': 'wap',
  'referer': `https://www.sportybet.com/${(CFG.REGION || 'gh').toLowerCase()}/m/sport/football/today/`,
  'x-requested-with': 'XMLHttpRequest',
  'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
};

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(350 * (i + 1));
  }
  return null;
}

async function post(body) {
  const r = await fetch(`${API}/orders/share`, {
    method: 'POST',
    headers: { ...HDR, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  return { status: r.status, j, raw };
}

module.exports = { API, HDR, get, post };
