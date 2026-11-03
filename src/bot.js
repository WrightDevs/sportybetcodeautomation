'use strict';
const { CFG } = require('./config');
const { PRESETS } = require('./presets');
const { generate } = require('./run');
const { sleep } = require('./util');

const API = `https://api.telegram.org/bot${CFG.TG_TOKEN}`;
const busy = new Set();

async function call(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

const send = (chat, text, extra = {}) =>
  call('sendMessage', { chat_id: chat, text, disable_web_page_preview: true, ...extra });

const menu = {
  inline_keyboard: [[
    { text: '⚽ Football', callback_data: 'football' },
    { text: '🕹 eFootball', callback_data: 'efootball' },
    { text: '⚡ vFootball', callback_data: 'vfootball' }
  ]]
};

const HELP = 'Pick a sport. Each returns fresh booking codes you can load in the betslip.\n\n'
  + '/football — real fixtures, full day, up to 4 codes\n'
  + '/efootball — in-play, leader by 3+ after 40′\n'
  + '/vfootball — in-play, compressed clock\n\n'
  + 'Codes do not stake anything.';

async function handle(chat, key) {
  const preset = PRESETS[key];
  if (!preset) return send(chat, 'Unknown option.', { reply_markup: menu });

  if (busy.has(chat)) return send(chat, 'Still working on the previous request.');

  busy.add(chat);
  await send(chat, `${preset.icon} scanning ${preset.label}…`);

  try {
    const { lines, count } = await generate(preset);
    if (!count) {
      await send(chat, `${preset.label}: nothing qualified right now.`);
    } else {
      await send(chat, `${preset.icon} ${preset.label} — ${count} code(s)\n\n` + lines.join('\n\n'));
    }
  } catch (e) {
    await send(chat, `${preset.label} failed: ${e.message}`);
  } finally {
    busy.delete(chat);
  }
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
      const j = await r.json();

      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        const cb = u.callback_query;

        if (cb) {
          await call('answerCallbackQuery', { callback_query_id: cb.id });
          handle(cb.message.chat.id, cb.data);
          continue;
        }
        if (!msg?.text) continue;

        const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
        if (cmd === '/start' || cmd === '/menu') await send(msg.chat.id, HELP, { reply_markup: menu });
        else if (cmd === '/football') handle(msg.chat.id, 'football');
        else if (cmd === '/efootball') handle(msg.chat.id, 'efootball');
        else if (cmd === '/vfootball') handle(msg.chat.id, 'vfootball');
        else await send(msg.chat.id, HELP, { reply_markup: menu });
      }
    } catch (e) {
      console.error('poll:', e.message);
      await sleep(3000);
    }
  }
}

console.log('bot polling');
poll();
