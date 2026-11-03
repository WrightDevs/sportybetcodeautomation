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
const { initializePayment, verifyPayment } = require('./paystack');

const API = `https://api.telegram.org/bot${CFG.TG_TOKEN}`;
const busy = new Set();
const awaitingProof = new Map(); // chatId => timestamp

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

const paywallMenu = {
  inline_keyboard: [
    ...(CFG.PAYSTACK_SECRET ? [[{ text: `💳 Pay ₦${CFG.SUB_PRICE.toLocaleString()} Online (Paystack)`, callback_data: 'pay_online' }]] : []),
    [{ text: `🏦 Bank Transfer (₦${CFG.SUB_PRICE.toLocaleString()})`, callback_data: 'pay_transfer' }],
    [{ text: 'ℹ️ Check Subscription Status', callback_data: 'sub_status' }]
  ]
};

const HELP = `<b>Welcome to SportyBet Daily Codes VIP!</b>\n\n`
  + `Select a sport below to generate fresh, ranked booking codes:\n\n`
  + `⚽ <b>Football</b> — real fixtures, full day\n`
  + `🕹 <b>eFootball</b> — in-play, leader by 3+ after 40′\n`
  + `⚡ <b>vFootball</b> — in-play & upcoming 3-min rounds\n\n`
  + `<i>Booking codes are non-staking preparation slips.</i>`;

function sendPaywall(chat) {
  const text = `🔒 <b>VIP Subscription Required</b>\n\n`
    + `Access to daily codes costs <b>₦${CFG.SUB_PRICE.toLocaleString()} / ${CFG.SUB_DAYS} days</b>.\n\n`
    + `Choose your preferred payment method below to unlock:`;
  return send(chat, text, { reply_markup: paywallMenu });
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
    + `After making the transfer, tap <b>"I Have Paid"</b> below to submit your sender name:`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: '📝 I Have Paid (Submit Proof)', callback_data: 'submit_proof' }],
      [{ text: '🔙 Back', callback_data: 'menu' }]
    ]
  };

  return send(chat, text, { reply_markup });
}

async function handlePayOnline(chat) {
  await send(chat, '⏳ Generating your secure Paystack payment link…');
  const res = await initializePayment(chat);

  if (!res.ok) {
    return send(chat, `❌ Failed to initialize Paystack: ${res.err}\n\nPlease use Bank Transfer instead:`, {
      reply_markup: {
        inline_keyboard: [[{ text: '🏦 Pay via Bank Transfer', callback_data: 'pay_transfer' }]]
      }
    });
  }

  const text = `💳 <b>Paystack Checkout</b>\n\n`
    + `Amount: <b>₦${CFG.SUB_PRICE.toLocaleString()}</b> (Valid for ${CFG.SUB_DAYS} Days)\n\n`
    + `Click <b>"Open Payment Link"</b> below to pay with Card, Bank Transfer, or USSD.\n\n`
    + `Once paid, tap <b>"Check Payment Status"</b> to unlock immediately!`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: '🌐 Open Payment Link', url: res.url }],
      [{ text: '🔄 Check Payment Status', callback_data: `verify:${res.reference}` }],
      [{ text: '🔙 Back', callback_data: 'menu' }]
    ]
  };

  return send(chat, text, { reply_markup });
}

async function handleVerifyPayment(chat, messageId, reference) {
  await send(chat, '🔍 Verifying payment with Paystack…');
  const res = await verifyPayment(reference);

  if (res.ok && res.status === 'success') {
    addSubscription(chat, res.days, { method: 'paystack', reference, amount: res.amount });
    const sub = getSubscription(chat);
    const text = `🎉 <b>Payment Confirmed!</b>\n\n`
      + `Your VIP Subscription is now <b>ACTIVE</b>!\n`
      + `Expires on: <b>${sub.expDate}</b> (${sub.daysLeft} days remaining).\n\n`
      + `Tap a sport below to generate codes:`;
    return send(chat, text, { reply_markup: sportsMenu });
  }

  return send(chat, `⚠️ <b>Payment Not Confirmed Yet</b>\n\n`
    + `${res.err || 'We have not received payment for this reference yet.'}\n\n`
    + `If you already transferred, please wait a minute and tap Verify again.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Check Again', callback_data: `verify:${reference}` }],
        [{ text: '🔙 Back', callback_data: 'menu' }]
      ]
    }
  });
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
    + `Subscribe for ₦${CFG.SUB_PRICE.toLocaleString()} / ${CFG.SUB_DAYS} days to access daily codes.`, { reply_markup: paywallMenu });
}

async function handleAdminApprove(adminChat, messageId, targetChat, days) {
  if (!isAdmin(adminChat)) return;
  addSubscription(targetChat, days, { approvedBy: adminChat, method: 'manual' });
  const sub = getSubscription(targetChat);

  await editMessage(adminChat, messageId, `✅ <b>Approved!</b>\nUser: <code>${targetChat}</code> is active for ${days} days (until ${sub.expDate}).`);
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
          } else if (data === 'pay_online') {
            await handlePayOnline(chat);
          } else if (data === 'pay_transfer') {
            await sendBankDetails(chat);
          } else if (data === 'submit_proof') {
            awaitatingProof.set(chat, Date.now());
            await send(chat, '📝 <b>Submit Payment Proof</b>\n\nPlease reply to this chat with your <b>Sender Account Name</b>, <b>Bank Name</b>, or <b>Transaction Reference</b>:');
          } else if (data.startsWith('verify:')) {
            const ref = data.slice('verify:'.length);
            await handleVerifyPayment(chat, cb.message.message_id, ref);
          } else if (data.startsWith('approve:')) {
            const [, targetChat, days] = data.split(':');
            await handleAdminApprove(chat, cb.message.message_id, targetChat, Number(days) || 7);
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
        const text = (msg.text || '').trim();

        // Handle user payment proof submission
        if (awaitingProof.has(chat) && text && !text.startsWith('/')) {
          awaitingProof.delete(chat);
          const userName = msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'none'})`.trim() : 'Anonymous';

          await send(chat, '✅ <b>Payment Proof Received!</b>\n\nYour details have been submitted to the admin for verification. You will receive an instant notification once approved.');

          // Forward to Admin
          if (CFG.ADMIN_ID) {
            const adminText = `🔔 <b>New Bank Transfer Claim!</b>\n\n`
              + `• <b>User:</b> ${userName}\n`
              + `• <b>Chat ID:</b> <code>${chat}</code>\n`
              + `• <b>Proof/Details:</b> <code>${text}</code>\n`
              + `• <b>Amount Expected:</b> ₦${CFG.SUB_PRICE.toLocaleString()}`;

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
            const lines = subs.map((s, i) => `${i + 1}. <code>${s.chatId}</code> — ${s.daysLeft} days left (${s.expDate})`);
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
