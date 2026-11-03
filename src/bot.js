'use strict';
const { CFG } = require('./config');
const { PRESETS } = require('./presets');
const { generate } = require('./run');
const { sleep } = require('./util');
const {
  isAdmin,
  isSubscribed,
  getSubscription,
  addSubscription,
  revokeSubscription,
  listSubscribers
} = require('./subs');
const { verifyQuestPay } = require('./questpay');
const { startWebhookServer } = require('./webhook');

const API = `https://api.telegram.org/bot${CFG.TG_TOKEN}`;
const busy = new Set();
const awaitingProof = new Map(); // chatId => timestamp
const awaitingQuestPayRef = new Map(); // chatId => timestamp

async function call(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

const send = (chat, text, extra = {}) =>
  call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const editMessage = (chat, messageId, text, extra = {}) =>
  call('editMessageText', { chat_id: chat, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const sportsMenu = {
  inline_keyboard: [[
    { text: '⚽ Football', callback_data: 'football' },
    { text: '🕹 eFootball', callback_data: 'efootball' },
    { text: '⚡ vFootball', callback_data: 'vfootball' }
  ], [
    { text: 'ℹ️ My VIP Status', callback_data: 'sub_status' }
  ]]
};

function getPaywallMenu() {
  const buttons = [];
  if (CFG.QUESTPAY_LINK) {
    buttons.push([{ text: `💳 Pay ₦${CFG.SUB_PRICE.toLocaleString()} via QuestPay`, url: CFG.QUESTPAY_LINK }]);
    buttons.push([{ text: '🔄 Verify QuestPay Reference', callback_data: 'verify_questpay' }]);
  }
  buttons.push([{ text: `🏦 Bank Transfer (₦${CFG.SUB_PRICE.toLocaleString()})`, callback_data: 'pay_transfer' }]);
  buttons.push([{ text: 'ℹ️ Check Subscription Status', callback_data: 'sub_status' }]);
  return { inline_keyboard: buttons };
}

const HELP = `<b>Welcome to SportyBet Daily Codes VIP!</b>\n\n`
  + `Select a sport below to generate fresh, ranked booking codes:\n\n`
  + `⚽ <b>Football</b> — real fixtures, full day\n`
  + `🕹 <b>eFootball</b> — in-play, leader by 3+ after 40′\n`
  + `⚡ <b>vFootball</b> — in-play & upcoming 3-min rounds\n\n`
  + `<i>Booking codes are non-staking preparation slips.</i>`;

function sendPaywall(chat) {
  const text = `🔒 <b>VIP Subscription Required</b>\n\n`
    + `Access to daily codes costs <b>₦${CFG.SUB_PRICE.toLocaleString()} / ${CFG.SUB_DAYS} days</b>.\n\n`
    + `Choose your preferred payment method below:`;
  return send(chat, text, { reply_markup: getPaywallMenu() });
}

function sendBankDetails(chat) {
  const bank = CFG.BANK_NAME || 'OPay';
  const accNum = CFG.ACCOUNT_NUMBER || 'Contact Admin';
  const accName = CFG.ACCOUNT_NAME || 'VIP Sporty Codes';

  const text = `🏦 <b>Manual Bank Transfer</b>\n\n`
    + `Transfer <b>₦${CFG.SUB_PRICE.toLocaleString()}</b> for ${CFG.SUB_DAYS} days VIP access:\n\n`
    + `• <b>Bank Name:</b> <code>${bank}</code>\n`
    + `• <b>Account Number:</b> <code>${accNum}</code>\n`
    + `• <b>Account Name:</b> <code>${accName}</code>\n`
    + `• <b>Amount:</b> <b>₦${CFG.SUB_PRICE.toLocaleString()}</b>\n\n`
    + `After making the transfer, tap <b>"I Have Paid (Send Proof)"</b> below to submit your receipt screenshot or sender name:`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: '📝 I Have Paid (Send Proof)', callback_data: 'submit_proof' }],
      [{ text: '🔙 Back', callback_data: 'menu' }]
    ]
  };

  return send(chat, text, { reply_markup });
}

async function handleSport(chat, key) {
  if (!isSubscribed(chat)) {
    return sendPaywall(chat);
  }

  const preset = PRESETS[key];
  if (!preset) return send(chat, 'Unknown option.', { reply_markup: sportsMenu });

  if (busy.has(chat)) return send(chat, 'Still working on your previous request… please wait a moment.');

  busy.add(chat);
  await send(chat, `${preset.icon} scanning ${preset.label}…`);

  try {
    const { lines, count } = await generate(preset);
    if (!count) {
      await send(chat, `${preset.label}: nothing qualified right now. Check back shortly!`);
    } else {
      await send(chat, `${preset.icon} <b>${preset.label}</b> — ${count} code(s)\n\n` + lines.join('\n\n'));
    }
  } catch (e) {
    await send(chat, `${preset.label} failed: ${e.message}`);
  } finally {
    busy.delete(chat);
  }
}

function handleStatus(chat) {
  const sub = getSubscription(chat);
  if (sub.isAdmin) {
    return send(chat, '👑 <b>Admin Account</b>\nYou have permanent, unlimited VIP access.', { reply_markup: sportsMenu });
  }
  if (sub.active) {
    return send(chat, `✅ <b>VIP Status: ACTIVE</b>\n\n`
      + `• <b>Days Remaining:</b> ${sub.daysLeft} days\n`
      + `• <b>Expires On:</b> ${sub.expDate}\n\n`
      + `Tap a sport to generate codes:`, { reply_markup: sportsMenu });
  }
  return send(chat, `❌ <b>VIP Status: INACTIVE</b>\n\n`
    + `You do not have an active subscription.\n`
    + `Subscribe for ₦${CFG.SUB_PRICE.toLocaleString()} / ${CFG.SUB_DAYS} days to access daily codes.`, { reply_markup: getPaywallMenu() });
}

async function handleAdminApprove(adminChat, messageId, targetChat, days) {
  if (!isAdmin(adminChat)) return;
  addSubscription(targetChat, days, { approvedBy: adminChat, method: 'manual' });
  const sub = getSubscription(targetChat);

  await editMessage(adminChat, messageId, `✅ <b>Approved!</b>\nUser <code>${targetChat}</code> is active for ${days} days (until ${sub.expDate}).`);
  await send(targetChat, `🎉 <b>Payment Approved!</b>\n\n`
    + `Your VIP Subscription has been activated by the admin for <b>${days} days</b>!\n`
    + `Expires on: <b>${sub.expDate}</b>.\n\n`
    + `Tap below to start generating codes:`, { reply_markup: sportsMenu });
}

async function handleAdminReject(adminChat, messageId, targetChat) {
  if (!isAdmin(adminChat)) return;
  await editMessage(adminChat, messageId, `❌ <b>Rejected</b> for user <code>${targetChat}</code>.`);
  await send(targetChat, `⚠️ <b>Payment Proof Rejected</b>\n\n`
    + `The admin could not confirm your transfer. Please check your bank transaction or contact admin for assistance.`);
}

async function poll() {
  let offset = 0;
  console.log('bot polling with VIP subscription system active');

  // Start built-in zero-dependency webhook server for QuestPay
  startWebhookServer(async (chatId, reference, amount) => {
    const sub = getSubscription(chatId);
    await send(chatId, `🎉 <b>Payment Confirmed via QuestPay!</b>\n\n`
      + `Your VIP Subscription is now <b>ACTIVE</b> for ${CFG.SUB_DAYS} days!\n`
      + `Expires on: <b>${sub.expDate}</b>.\n\n`
      + `Select a sport to generate codes:`, { reply_markup: sportsMenu });

    if (CFG.ADMIN_ID) {
      await send(CFG.ADMIN_ID, `🔔 <b>QuestPay Webhook Success!</b>\n\n`
        + `• <b>User ID:</b> <code>${chatId}</code>\n`
        + `• <b>Reference:</b> <code>${reference}</code>\n`
        + `• <b>Amount:</b> ₦${(amount || CFG.SUB_PRICE).toLocaleString()}`);
    }
  });

  for (;;) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
      const j = await r.json();

      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        const cb = u.callback_query;

        // Handle button callbacks
        if (cb) {
          await call('answerCallbackQuery', { callback_query_id: cb.id });
          const chat = cb.message.chat.id;
          const data = cb.data || '';

          if (data === 'menu') {
            if (isSubscribed(chat)) await send(chat, HELP, { reply_markup: sportsMenu });
            else await sendPaywall(chat);
          } else if (data === 'sub_status') {
            handleStatus(chat);
          } else if (data === 'pay_transfer') {
            await sendBankDetails(chat);
          } else if (data === 'verify_questpay') {
            awaitingQuestPayRef.set(chat, Date.now());
            await send(chat, '🔄 <b>Verify QuestPay Payment</b>\n\nPlease reply with your <b>QuestPay Transaction Reference</b> (e.g. <code>QP_...</code> or transaction ID):');
          } else if (data === 'submit_proof') {
            awaitingProof.set(chat, Date.now());
            await send(chat, '📝 <b>Submit Payment Proof</b>\n\nPlease send your <b>payment receipt screenshot</b> or reply with your <b>Sender Account Name</b> and transaction reference:');
          } else if (data.startsWith('approve:')) {
            const [, targetChat, days] = data.split(':');
            await handleAdminApprove(chat, cb.message.message_id, targetChat, Number(days) || CFG.SUB_DAYS);
          } else if (data.startsWith('reject:')) {
            const [, targetChat] = data.split(':');
            await handleAdminReject(chat, cb.message.message_id, targetChat);
          } else if (['football', 'efootball', 'vfootball'].includes(data)) {
            await handleSport(chat, data);
          }
          continue;
        }

        if (!msg) continue;
        const chat = msg.chat.id;
        const text = (msg.text || msg.caption || '').trim();

        // Handle manual QuestPay reference verification fallback
        if (awaitingQuestPayRef.has(chat) && text && !text.startsWith('/')) {
          awaitingQuestPayRef.delete(chat);
          await send(chat, '🔍 Checking QuestPay transaction reference…');

          const res = await verifyQuestPay(text);
          if (res.ok && res.status === 'success') {
            addSubscription(chat, CFG.SUB_DAYS, { method: 'questpay_manual_verify', reference: text, amount: res.amount });
            const sub = getSubscription(chat);
            await send(chat, `🎉 <b>Payment Verified!</b>\n\nYour VIP Subscription is now <b>ACTIVE</b>!\nExpires on: <b>${sub.expDate}</b>.`, { reply_markup: sportsMenu });
            if (CFG.ADMIN_ID) {
              await send(CFG.ADMIN_ID, `✅ <b>QuestPay Auto-Verified</b>\nUser: <code>${chat}</code> | Ref: <code>${text}</code>`);
            }
          } else {
            // Forward to Admin for manual fallback verification so user isn't stuck
            const userName = msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'none'})`.trim() : 'Anonymous';
            await send(chat, '⏳ Your QuestPay reference could not be auto-verified by the API. It has been forwarded to the admin for manual approval. You will receive an instant notification once confirmed.');

            if (CFG.ADMIN_ID) {
              const adminText = `🔔 <b>QuestPay Manual Verification Request</b>\n\n`
                + `• <b>User:</b> ${userName}\n`
                + `• <b>Chat ID:</b> <code>${chat}</code>\n`
                + `• <b>QuestPay Ref:</b> <code>${text}</code>\n`
                + `• <b>Status:</b> ${res.err || 'Unverified'}`;

              const reply_markup = {
                inline_keyboard: [
                  [
                    { text: '✅ Approve (7 Days)', callback_data: `approve:${chat}:${CFG.SUB_DAYS}` },
                    { text: '❌ Reject', callback_data: `reject:${chat}` }
                  ]
                ]
              };
              await send(CFG.ADMIN_ID, adminText, { reply_markup });
            }
          }
          continue;
        }

        // Handle user payment proof submission (Text, Photo Screenshot, or Document)
        if (awaitingProof.has(chat) && !text.startsWith('/')) {
          awaitingProof.delete(chat);
          const userName = msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'none'})`.trim() : 'Anonymous';

          await send(chat, '✅ <b>Payment Proof Received!</b>\n\nYour proof has been submitted to the admin for verification. You will receive an instant notification here once approved.');

          const adminCaption = `🔔 <b>New Bank Transfer Proof!</b>\n\n`
            + `• <b>User:</b> ${userName}\n`
            + `• <b>Chat ID:</b> <code>${chat}</code>\n`
            + (text ? `• <b>Details/Note:</b> <code>${text}</code>\n` : '')
            + `• <b>Amount Expected:</b> ₦${CFG.SUB_PRICE.toLocaleString()}`;

          const reply_markup = {
            inline_keyboard: [
              [
                { text: '✅ Approve (7 Days)', callback_data: `approve:${chat}:${CFG.SUB_DAYS}` },
                { text: '❌ Reject', callback_data: `reject:${chat}` }
              ]
            ]
          };

          if (CFG.ADMIN_ID) {
            if (msg.photo && msg.photo.length > 0) {
              const bestPhoto = msg.photo[msg.photo.length - 1].file_id;
              await call('sendPhoto', {
                chat_id: CFG.ADMIN_ID,
                photo: bestPhoto,
                caption: adminCaption,
                parse_mode: 'HTML',
                reply_markup
              });
            } else if (msg.document) {
              await call('sendDocument', {
                chat_id: CFG.ADMIN_ID,
                document: msg.document.file_id,
                caption: adminCaption,
                parse_mode: 'HTML',
                reply_markup
              });
            } else {
              await send(CFG.ADMIN_ID, adminCaption, { reply_markup });
            }
          }
          continue;
        }

        if (!text) continue;
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase().replace(/@.*$/, '');

        // Standard commands
        if (cmd === '/start' || cmd === '/menu') {
          if (isSubscribed(chat)) await send(chat, HELP, { reply_markup: sportsMenu });
          else await sendPaywall(chat);
        } else if (cmd === '/status') {
          handleStatus(chat);
        } else if (cmd === '/subscribe' || cmd === '/pay') {
          sendPaywall(chat);
        } else if (['/football', '/efootball', '/vfootball'].includes(cmd)) {
          await handleSport(chat, cmd.slice(1));
        }

        // Admin management commands
        else if (cmd === '/approve' && isAdmin(chat)) {
          const target = parts[1];
          const days = Number(parts[2]) || CFG.SUB_DAYS;
          if (!target) {
            await send(chat, 'Usage: <code>/approve &lt;chat_id&gt; [days]</code>');
          } else {
            addSubscription(target, days, { approvedBy: chat, method: 'manual_cmd' });
            const sub = getSubscription(target);
            await send(chat, `✅ Approved user <code>${target}</code> for ${days} days (Expires: ${sub.expDate}).`);
            await send(target, `🎉 Your VIP Subscription has been activated by the admin for <b>${days} days</b>!\nExpires on: <b>${sub.expDate}</b>.`, { reply_markup: sportsMenu });
          }
        } else if (cmd === '/revoke' && isAdmin(chat)) {
          const target = parts[1];
          if (!target) {
            await send(chat, 'Usage: <code>/revoke &lt;chat_id&gt;</code>');
          } else {
            const ok = revokeSubscription(target);
            await send(chat, ok ? `🚫 Revoked access for <code>${target}</code>.` : `User <code>${target}</code> was not found.`);
          }
        } else if (cmd === '/users' && isAdmin(chat)) {
          const subs = listSubscribers();
          if (!subs.length) {
            await send(chat, '📋 No active paid subscribers.');
          } else {
            const lines = subs.map((s, i) => `${i + 1}. <code>${s.chatId}</code> (${s.name}) — ${s.daysLeft} days left (${s.expDate})`);
            await send(chat, `📋 <b>Active Subscribers (${subs.length})</b>:\n\n` + lines.join('\n'));
          }
        } else {
          if (isSubscribed(chat)) await send(chat, HELP, { reply_markup: sportsMenu });
          else await sendPaywall(chat);
        }
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await sleep(3000);
    }
  }
}

poll();
