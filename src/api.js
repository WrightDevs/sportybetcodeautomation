'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');

const API = `https://www.sportybet.com/api/${CFG.REGION}`;

// Full browser emulation headers (exact replica of Chrome on Windows)
const HDR = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'clientid': 'web',
  'current-country': CFG.REGION.toUpperCase(),
  'origin': `https://www.sportybet.com`,
  'platform': 'web',
  'pragma': 'no-cache',
  'priority': 'u=1, i',
  'referer': `https://www.sportybet.com/${CFG.REGION}/`,
  'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
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
