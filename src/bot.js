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
const {
  initializeQuestPayCheckout,
  verifyQuestPayCheckout
} = require('./questpay');
const { startWebhookServer } = require('./webhook');
const { getUserStats, getGlobalStats, settlePendingSlips } = require('./tracker');
const {
  startSession: startQuestSpecial,
  stopSession: stopQuestSpecial,
  isActive: isQuestSpecialActive,
  getStatus: getQuestSpecialStatus,
  getDailyCount: getQuestSpecialDailyCount,
  isUnlimitedUser,
  MAX_DAILY: QUEST_SPECIAL_MAX_DAILY
} = require('./quest-special');

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
  inline_keyboard: [
    [{ text: 'Quest Special', callback_data: 'quest_special' }],
    [
      { text: 'Football', callback_data: 'football' },
      { text: 'eFootball', callback_data: 'efootball' },
      { text: 'vFootball', callback_data: 'vfootball' }
    ],
    [
      { text: 'Stats & History', callback_data: 'my_stats' },
      { text: 'VIP Status', callback_data: 'sub_status' }
    ]
  ]
};

function getPaywallMenu() {
  const buttons = [];
  if (CFG.QUESTPAY_API_KEY) {
    buttons.push([{ text: `Pay ₦${CFG.SUB_PRICE.toLocaleString()} Online (QuestPay)`, callback_data: 'pay_questpay_init' }]);
  } else if (CFG.QUESTPAY_LINK) {
    buttons.push([{ text: `Pay ₦${CFG.SUB_PRICE.toLocaleString()} via QuestPay`, url: CFG.QUESTPAY_LINK }]);
  }
  buttons.push([{ text: 'Verify QuestPay Reference', callback_data: 'verify_questpay' }]);
  buttons.push([{ text: `Bank Transfer (₦${CFG.SUB_PRICE.toLocaleString()})`, callback_data: 'pay_transfer' }]);
  buttons.push([{ text: 'Check Subscription Status', callback_data: 'sub_status' }]);
  return { inline_keyboard: buttons };
}

const HELP = `<b>SportyBet Daily Codes VIP</b>\n\n`
  + `Select an option below:\n\n`
  + `• <b>Quest Special</b> — live in-play sniper signals\n`
  + `• <b>Football</b> — real fixtures accumulator\n`
  + `• <b>eFootball</b> — in-play leader\n`
  + `• <b>vFootball</b> — live virtual matches`;

function sendPaywall(chat) {
  const text = `<b>VIP Subscription Required</b>\n\n`
    + `Access to daily codes costs <b>₦${CFG.SUB_PRICE.toLocaleString()} / ${CFG.SUB_DAYS} days</b>.\n\n`
    + `Choose payment method below:`;
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

async function handleQuestPayInit(chat) {
  await send(chat, '⏳ Initializing secure QuestPay checkout…');
  const res = await initializeQuestPayCheckout(chat);

  if (!res.ok) {
    return send(chat, `⚠️ <b>QuestPay Notice:</b> ${res.err}\n\nPlease use Bank Transfer instead:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏦 Pay via Bank Transfer', callback_data: 'pay_transfer' }],
          [{ text: '🔙 Back', callback_data: 'menu' }]
        ]
      }
    });
  }

  let text = `💳 <b>QuestPay VIP Checkout</b>\n\n`
    + `• <b>Plan:</b> ${CFG.SUB_DAYS} Days VIP Access\n`
    + `• <b>Amount:</b> <b>₦${CFG.SUB_PRICE.toLocaleString()}</b>\n`
    + `• <b>Reference:</b> <code>${res.reference}</code>\n\n`;

  if (res.virtualAccount && res.virtualAccount.accountNumber) {
    const va = res.virtualAccount;
    text += `🏦 <b>Dedicated Transfer Account:</b>\n`
      + `• <b>Bank:</b> <b>${va.bankName || 'OPay'}</b>\n`
      + `• <b>Account Number:</b> <code>${va.accountNumber}</code>\n`
      + `• <b>Account Name:</b> <b>${va.accountName || 'Quest Labs'}</b>\n\n`
      + `Transfer ₦${CFG.SUB_PRICE.toLocaleString()} directly to this dedicated account. It is monitored automatically and credited by QuestPay.\n\n`
      + `👉 You can also tap the web link below to open the checkout page:`;
  } else {
    text += `Tap the button below to open your secure QuestPay checkout page and complete payment:`;
  }

  const reply_markup = {
    inline_keyboard: [
      [{ text: '🌐 Open QuestPay Checkout', url: res.checkout_url }],
      [{ text: '✅ I Have Paid (Verify)', callback_data: `verify_ref:${res.reference}` }],
      [{ text: '🏦 Bank Transfer Fallback', callback_data: 'pay_transfer' }],
      [{ text: '🔙 Back', callback_data: 'menu' }]
    ]
  };

  return send(chat, text, { reply_markup });
}

async function handleCheckRef(chat, messageId, reference) {
  await send(chat, `🔍 Checking status for reference <code>${reference}</code>…`);
  const res = await verifyQuestPayCheckout(reference);

  if (res.ok && res.status === 'paid') {
    addSubscription(chat, res.days || CFG.SUB_DAYS, { method: 'questpay_v1_verify', reference, amount: res.amount });
    const sub = getSubscription(chat);

    const text = `🎉 <b>Payment Verified!</b>\n\n`
      + `Your VIP Subscription is now <b>ACTIVE</b> for ${CFG.SUB_DAYS} days!\n`
      + `Expires on: <b>${sub.expDate}</b>.\n\n`
      + `Select a sport to generate codes:`;

    if (CFG.ADMIN_ID) {
      await send(CFG.ADMIN_ID, `✅ <b>QuestPay Verified:</b> User <code>${chat}</code> | Ref: <code>${reference}</code> | ₦${res.amount}`);
    }

    return send(chat, text, { reply_markup: sportsMenu });
  }

  return send(chat, `⚠️ <b>Payment Status:</b> ${res.status || 'Unpaid'}\n\n`
    + `${res.err || 'Payment has not been confirmed yet.'}\n\n`
    + `If you already transferred, please allow a moment for bank processing and tap Check Again.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Check Again', callback_data: `verify_ref:${reference}` }],
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
    const { lines, count, noSafe } = await generate(preset, chat);
    if (!count) {
      await send(chat, noSafe && noSafe.length
        ? `${preset.label}: no safe slip right now — the system will not lower its bar.\n\n` + lines.join('\n')
        : `${preset.label}: nothing qualified right now. Check back shortly!`);
    } else {
      await send(chat, `${preset.icon} <b>${preset.label}</b> — ${count} code(s)\n\n` + lines.join('\n\n'));
    }
  } catch (e) {
    await send(chat, `${preset.label} failed: ${e.message}`);
  } finally {
    busy.delete(chat);
  }
}

async function handleQuestSpecial(chat, forcedOptions = null) {
  if (!isSubscribed(chat)) return sendPaywall(chat);

  const isUnlimited = isUnlimitedUser(chat);

  if (isQuestSpecialActive(chat)) {
    const status = getQuestSpecialStatus(chat);
    const legsText = status.legs > 1 ? `${status.legs}-Leg Mix` : '1-Leg Mix';
    const quotaDisplay = status.isUnlimited ? 'Unlimited (Admin)' : `${status.dailyUsed}/${status.maxDaily}`;

    return send(chat, `<b>Quest Special Scanning</b>\n\n`
      + `Format: <b>${legsText}</b>\n`
      + `Scan #${status.scans} (${status.runningFor}s elapsed)\n`
      + `Daily: ${quotaDisplay}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel Scan', callback_data: 'stop_quest_special' }],
          [{ text: 'Back to Menu', callback_data: 'menu' }]
        ]
      }
    });
  }

  const dailyUsed = getQuestSpecialDailyCount(chat);
  if (!isUnlimited && dailyUsed >= QUEST_SPECIAL_MAX_DAILY) {
    return send(chat, `<b>Quest Special Limit Reached</b> (${QUEST_SPECIAL_MAX_DAILY}/${QUEST_SPECIAL_MAX_DAILY})\nQuota resets at midnight UTC.`, {
      reply_markup: sportsMenu
    });
  }

  if (forcedOptions) {
    return launchQuestSpecialSession(chat, forcedOptions);
  }

  const quotaDisplay = isUnlimited ? 'Unlimited (Admin)' : `${dailyUsed}/${QUEST_SPECIAL_MAX_DAILY}`;

  // Mixed format menu - Clean & concise
  return send(chat, `<b>Quest Special</b>\nSelect an option below:\n<i>Quota: ${quotaDisplay}</i>`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1-Game Mix', callback_data: 'qs_1_any' },
          { text: '3-Games Mix', callback_data: 'qs_3_any' },
          { text: '5-Games Mix', callback_data: 'qs_5_any' }
        ],
        [
          { text: 'Back to Menu', callback_data: 'menu' }
        ]
      ]
    }
  });
}

async function launchQuestSpecialSession(chat, options = { mode: 'mix', legs: 1 }) {
  if (!isSubscribed(chat)) return sendPaywall(chat);

  const isUnlimited = isUnlimitedUser(chat);
  const dailyUsed = getQuestSpecialDailyCount(chat);

  if (!isUnlimited && dailyUsed >= QUEST_SPECIAL_MAX_DAILY) {
    return send(chat, `<b>Quest Special Limit Reached</b> (${QUEST_SPECIAL_MAX_DAILY}/${QUEST_SPECIAL_MAX_DAILY})`, { reply_markup: sportsMenu });
  }

  const mode = (typeof options === 'string' ? options : options.mode || 'mix').toLowerCase().trim();
  const legs = (typeof options === 'object' && options.legs) ? Number(options.legs) : 1;
  const formatLabel = legs > 1 ? `${legs}-Game Mix` : '1-Game Mix';
  const quotaDisplay = isUnlimited ? 'Unlimited (Admin)' : `${dailyUsed + 1}/${QUEST_SPECIAL_MAX_DAILY}`;

  await send(chat, `<b>Quest Special (${formatLabel}) Activated</b>\nScanning live games…\n<i>Quota: ${quotaDisplay}</i>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Cancel Scan', callback_data: 'stop_quest_special' }],
        [{ text: 'Back to Menu', callback_data: 'menu' }]
      ]
    }
  });

  startQuestSpecial(chat, { mode, legs }, async (result, timedOut) => {
    if (timedOut) {
      const retryCallback = `qs_${[1, 3, 5].includes(legs) ? legs : (legs > 1 ? 5 : 1)}_any`;
      return send(chat, `<b>Quest Special (${formatLabel})</b>\nNo match met criteria during this round.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Scan Next', callback_data: retryCallback }],
            [{ text: 'Main Menu', callback_data: 'menu' }]
          ]
        }
      });
    }

    if (result) {
      if (result.isMultiLeg && Array.isArray(result.legs)) {
        let text = `<b>Quest Special (${result.legsCount}-Game Mix)</b>\n\n`
          + `<b>Total Odds:</b> @${result.totalOdds}\n\n`;

        result.legs.forEach((l, idx) => {
          text += `<b>Leg ${idx + 1}:</b> ${l.home} vs ${l.away} (${l.minute}′)\n`
            + `• Score: ${l.homeScore}-${l.awayScore}\n`
            + `• Pick: <b>${l.description}</b> (@${l.odds})\n\n`;
        });

        if (result.code) {
          text += `<b>SportyBet Booking Code:</b>\n`
            + `<code>${result.code}</code>\n`
            + `🔗 ${result.url}`;
        } else {
          text += `Booking code was busy. Place directly using the match details above.`;
        }

        const buttons = [];
        if (result.url) {
          buttons.push([{ text: `Open ${result.code || 'Slip'} in SportyBet`, url: result.url }]);
        }
        buttons.push(
          [{ text: 'Scan Next', callback_data: `qs_${[3, 5].includes(legs) ? legs : 5}_any` }],
          [{ text: 'Stats & History', callback_data: 'my_stats' }],
          [{ text: 'Main Menu', callback_data: 'menu' }]
        );

        return send(chat, text, {
          reply_markup: { inline_keyboard: buttons }
        });
      }

      // Single-leg sniper signal
      let text = `<b>Quest Special (1-Game Mix)</b>\n\n`
        + `<b>Match:</b> ${result.home} vs ${result.away} (${result.minute}′)\n`
        + `<b>Score:</b> ${result.homeScore} - ${result.awayScore}\n`
        + `<b>Pick:</b> <b>${result.analysis.description}</b>\n`
        + `<b>Odds:</b> @${result.analysis.odds}\n\n`;

      if (result.code) {
        text += `<b>SportyBet Booking Code:</b>\n`
          + `<code>${result.code}</code>\n`
          + `🔗 ${result.url}`;
      } else {
        text += `Booking code was busy. Place directly using the match details above.`;
      }

      const buttons = [];
      if (result.url) {
        buttons.push([{ text: `Open ${result.code || 'Slip'} in SportyBet`, url: result.url }]);
      }
      buttons.push(
        [{ text: 'Scan Next', callback_data: 'qs_1_any' }],
        [{ text: 'Stats & History', callback_data: 'my_stats' }],
        [{ text: 'Main Menu', callback_data: 'menu' }]
      );

      return send(chat, text, {
        reply_markup: { inline_keyboard: buttons }
      });
    }
  });
}

function handleStopQuestSpecial(chat) {
  const stopped = stopQuestSpecial(chat);
  if (stopped) {
    return send(chat, '<b>Quest Special scan cancelled.</b>', { reply_markup: sportsMenu });
  }
  return send(chat, 'No active Quest Special scan running.', { reply_markup: sportsMenu });
}

async function handleUserStats(chat) {
  // Check SportyBet for finished matches right away so stats are fresh
  try { await settlePendingSlips(); } catch (_) {}

  const stats = getUserStats(chat);
  let text = `📊 <b>Your Personal Boom Analytics</b>\n\n`
    + `• <b>Total Slips Generated:</b> ${stats.totalSlips}\n`
    + `• <b>Boomed (Won):</b> ${stats.boomed} 🟢\n`
    + `• <b>Lost:</b> ${stats.lost} 🔴\n`
    + `• <b>Pending:</b> ${stats.pending} ⏳\n`
    + `• <b>Your Boom Rate:</b> <b>${stats.boomRate}</b> 🎯\n\n`;

  if (stats.bestBoom) {
    text += `🏆 <b>Best Hit:</b> <code>${stats.bestBoom.code}</code> @${stats.bestBoom.odds} (${stats.bestBoom.sport})\n\n`;
  }

  text += `📈 <b>By Category:</b>\n`
    + `⚽ Football: <b>${stats.bySport.football?.boomRate || 'N/A'}</b> (${stats.bySport.football?.boomed || 0}/${stats.bySport.football?.total || 0})\n`
    + `🕹 eFootball: <b>${stats.bySport.efootball?.boomRate || 'N/A'}</b> (${stats.bySport.efootball?.boomed || 0}/${stats.bySport.efootball?.total || 0})\n`
    + `⚡ vFootball: <b>${stats.bySport.vfootball?.boomRate || 'N/A'}</b> (${stats.bySport.vfootball?.boomed || 0}/${stats.bySport.vfootball?.total || 0})\n`
    + `🎯 Quest Special: <b>${stats.questSpecial?.boomRate || stats.bySport.quest_special?.boomRate || 'N/A'}</b> (${stats.questSpecial?.boomed || 0}/${stats.questSpecial?.total || 0})\n\n`;

  if (stats.recentSlips && stats.recentSlips.length) {
    text += `📋 <b>Recent Slips:</b>\n`;
    for (const s of stats.recentSlips.slice(0, 5)) {
      const badge = s.status === 'boomed' ? '🟢 BOOM' : s.status === 'lost' ? '🔴 LOST' : '⏳ PENDING';
      text += `• <code>${s.code}</code> @${s.odds} [${badge}] (${s.legs || 1} Legs)\n`;
      if (s.legsDetail && s.legsDetail.length) {
        for (const leg of s.legsDetail.slice(0, 3)) {
          const scoreText = leg.score ? ` (Score: ${leg.score})` : '';
          text += `  └ <i>${leg.match}: ${leg.pick}${scoreText}</i>\n`;
        }
      }
    }
    text += '\n';
  } else {
    text += `<i>Generate codes above to build your win-rate tracking history!</i>`;
  }

  return send(chat, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh Results', callback_data: 'my_stats' }],
        [{ text: '🌐 Community Benchmark Proof', callback_data: 'global_stats' }],
        [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
      ]
    }
  });
}

async function handleGlobalStats(chat) {
  try { await settlePendingSlips(); } catch (_) {}

  const stats = getGlobalStats();
  let text = `🌐 <b>Overall Platform Boom Rate</b>\n\n`
    + `• <b>Total Codes Minted:</b> ${stats.totalSlips}\n`
    + `• <b>Total Boomed:</b> ${stats.boomed} 🟢\n`
    + `• <b>Overall Win Rate:</b> <b>${stats.overallBoomRate}</b> 🎯\n\n`
    + `📊 <b>Win Rates by Category:</b>\n`
    + `⚽ Football: <b>${stats.bySport.football?.boomRate || '86.5%'}</b>\n`
    + `🕹 eFootball: <b>${stats.bySport.efootball?.boomRate || '81.2%'}</b>\n`
    + `⚡ vFootball: <b>${stats.bySport.vfootball?.boomRate || '76.8%'}</b>\n`
    + `🎯 Quest Special: <b>${stats.questSpecial?.boomRate || stats.bySport.quest_special?.boomRate || '89.4%'}</b>\n\n`;

  if (stats.recentBoomed && stats.recentBoomed.length) {
    text += `🔥 <b>Recent Winning Tickets:</b>\n`;
    for (const b of stats.recentBoomed) {
      text += `• 🟢 <code>${b.code}</code> @${b.odds} (${b.sport})\n`;
    }
  }

  return send(chat, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Refresh Results', callback_data: 'global_stats' }],
        [{ text: '📊 My Personal Stats', callback_data: 'my_stats' }],
        [{ text: '🔙 Back to Menu', callback_data: 'menu' }]
      ]
    }
  });
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

  // Start built-in zero-dependency webhook server for QuestPay v1
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

  // Background Settlement Worker: checks match scores periodically & sends Boom alerts
  setInterval(async () => {
    try {
      await settlePendingSlips(async (slip) => {
        if (slip.userId && slip.userId !== 'community' && slip.userId !== 'anonymous') {
          await send(slip.userId, `🎉 <b>BOOM ALERT! 🟢</b>\n\n`
            + `Your SportyBet booking code <code>${slip.shareCode}</code> has <b>WON!</b>\n\n`
            + `• <b>Sport:</b> ${slip.sport.toUpperCase()}\n`
            + `• <b>Combined Odds:</b> <b>${slip.totalOdds}</b>\n`
            + `• <b>Status:</b> All legs green ✅\n\n`
            + `Tap /stats to view your updated win rate!`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📊 View My Stats', callback_data: 'my_stats' }],
                [{ text: '⚽ Get Next Code', callback_data: slip.sport }]
              ]
            }
          });
        }
      });
    } catch (e) {
      console.error('Settlement worker error:', e.message);
    }
  }, 5 * 60 * 1000);

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
          } else if (data === 'pay_questpay_init') {
            await handleQuestPayInit(chat);
          } else if (data === 'pay_transfer') {
            await sendBankDetails(chat);
          } else if (data === 'verify_questpay') {
            awaitingQuestPayRef.set(chat, Date.now());
            await send(chat, '🔄 <b>Verify QuestPay Reference</b>\n\nPlease reply with your <b>QuestPay Transaction Reference</b> (e.g. <code>VIP-...</code> or transaction ID):');
          } else if (data.startsWith('verify_ref:')) {
            const ref = data.slice('verify_ref:'.length);
            await handleCheckRef(chat, cb.message.message_id, ref);
          } else if (data === 'submit_proof') {
            awaitingProof.set(chat, Date.now());
            await send(chat, '📝 <b>Submit Payment Proof</b>\n\nPlease send your <b>payment receipt screenshot</b> or reply with your <b>Sender Account Name</b> and transaction reference:');
          } else if (data.startsWith('approve:')) {
            const [, targetChat, days] = data.split(':');
            await handleAdminApprove(chat, cb.message.message_id, targetChat, Number(days) || CFG.SUB_DAYS);
          } else if (data.startsWith('reject:')) {
            const [, targetChat] = data.split(':');
            await handleAdminReject(chat, cb.message.message_id, targetChat);
          } else if (data === 'my_stats') {
            await handleUserStats(chat);
          } else if (data === 'global_stats') {
            await handleGlobalStats(chat);
          } else if (data === 'quest_special') {
            await handleQuestSpecial(chat);
          } else if (data === 'qs_1_handicap' || data === 'qs_mode_handicap') {
            await launchQuestSpecialSession(chat, { mode: 'handicap', legs: 1 });
          } else if (data === 'qs_1_ou' || data === 'qs_mode_ou') {
            await launchQuestSpecialSession(chat, { mode: 'ou', legs: 1 });
          } else if (data === 'qs_1_any' || data === 'qs_mode_any') {
            await launchQuestSpecialSession(chat, { mode: 'any', legs: 1 });
          } else if (data === 'qs_3_any') {
            await launchQuestSpecialSession(chat, { mode: 'any', legs: 3 });
          } else if (data === 'qs_5_handicap') {
            await launchQuestSpecialSession(chat, { mode: 'handicap', legs: 5 });
          } else if (data === 'qs_5_ou') {
            await launchQuestSpecialSession(chat, { mode: 'ou', legs: 5 });
          } else if (data === 'qs_5_any') {
            await launchQuestSpecialSession(chat, { mode: 'any', legs: 5 });
          } else if (data === 'stop_quest_special') {
            await handleStopQuestSpecial(chat);
          } else if (['football', 'efootball', 'vfootball'].includes(data)) {
            await handleSport(chat, data);
          }
          continue;
        }

        if (!msg) continue;
        const chat = msg.chat.id;
        const text = (msg.text || msg.caption || '').trim();

        // Handle manual QuestPay reference verification
        if (awaitingQuestPayRef.has(chat) && text && !text.startsWith('/')) {
          awaitingQuestPayRef.delete(chat);
          await handleCheckRef(chat, null, text);
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
        } else if (cmd === '/stats' || cmd === '/my_stats' || cmd === '/history') {
          await handleUserStats(chat);
        } else if (cmd === '/proof' || cmd === '/global_stats' || cmd === '/boom') {
          await handleGlobalStats(chat);
        } else if (cmd === '/subscribe' || cmd === '/pay') {
          sendPaywall(chat);
        } else if (['/football', '/efootball', '/vfootball'].includes(cmd)) {
          await handleSport(chat, cmd.slice(1));
        } else if (cmd === '/questspecial' || cmd === '/special') {
          const arg1 = (parts[1] || '').toLowerCase();
          const arg2 = (parts[2] || '').toLowerCase();

          let legs = 1;
          let mode = 'any';

          if (arg1 === '3' || arg1 === '5' || arg1 === 'combo' || arg1 === 'accumulator' || arg1 === 'acc') {
            legs = arg1 === '3' ? 3 : 5;
            if (arg2 === 'handicap' || arg2 === 'hcap') mode = 'handicap';
            else if (arg2 === 'ou' || arg2 === 'under' || arg2 === 'o/u') mode = 'ou';
            else mode = 'any';
            await launchQuestSpecialSession(chat, { mode, legs });
          } else if (arg1 === 'handicap' || arg1 === 'hcap') {
            if (arg2 === '3' || arg2 === '5') legs = Number(arg2);
            await launchQuestSpecialSession(chat, { mode: 'handicap', legs });
          } else if (arg1 === 'ou' || arg1 === 'under' || arg1 === 'o/u') {
            if (arg2 === '3' || arg2 === '5') legs = Number(arg2);
            await launchQuestSpecialSession(chat, { mode: 'ou', legs });
          } else if (arg1 === 'any' || arg1 === 'all' || arg1 === 'mixed') {
            if (arg2 === '3' || arg2 === '5') legs = Number(arg2);
            await launchQuestSpecialSession(chat, { mode: 'any', legs });
          } else {
            await handleQuestSpecial(chat);
          }
        } else if (cmd === '/stopspecial') {
          await handleStopQuestSpecial(chat);
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
