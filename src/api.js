'use strict';
const { CFG } = require('./config');
const { sleep } = require('./util');

const API = `https://www.sportybet.com/api/${CFG.REGION}`;
const HDR = {
  accept: 'application/json',
  'current-country': CFG.REGION.toUpperCase(),
  platform: 'web',
  clientid: 'web'
};

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400 * (i + 1));
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

