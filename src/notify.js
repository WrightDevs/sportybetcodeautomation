'use strict';
const { CFG } = require('./config');

async function telegram(text) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT) return false;

  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.TG_CHAT, text, disable_web_page_preview: true })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.log('  telegram:', JSON.stringify(j).slice(0, 200));
    return !!j.ok;
  } catch (e) {
    console.log('  telegram:', e.message);
    return false;
  }
}

module.exports = { telegram };

