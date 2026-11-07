#!/usr/bin/env node
'use strict';
/**
 * Inspect or correct one user's subscription (all linked ids: _id, email, username, telegramId).
 *
 *   node bin/fix-sub.js haley                      show the user's records
 *   node bin/fix-sub.js haley --subtract 7         remove 7 days from the current expiry (undo a double credit)
 *   node bin/fix-sub.js haley --set-days 7         set expiry to exactly 7 days from now
 *
 * Nothing is changed unless --apply is added.
 */
const { getSubscriber, saveSubscriber, findUser, closeDb } = require('../src/db');

const args = process.argv.slice(2);
const who = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));
const flag = n => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : null; };
const apply = args.includes('--apply');
const DAY = 86400000;

(async () => {
  if (!who) { console.error('usage: node bin/fix-sub.js <username|email|telegramId|_id> [--subtract N | --set-days N] [--apply]'); process.exit(1); }
  const user = await findUser(who);
  if (!user) { console.error(`No user found for "${who}"`); process.exit(1); }

  const ids = [
    user.telegramId && String(user.telegramId),
    user._id && String(user._id),
    user.email && String(user.email).toLowerCase(),
    user.username && String(user.username).toLowerCase()
  ].filter(Boolean);
  const sub = await getSubscriber(ids[0]) || (await Promise.all(ids.map(getSubscriber))).find(Boolean);
  console.log('user ids :', ids.join(' | '));
  if (!sub) { console.log('no active subscription found'); return; }
  const left = (Number(sub.expiresAt) - Date.now()) / DAY;
  console.log(`expires  : ${new Date(Number(sub.expiresAt)).toISOString()} (${left.toFixed(2)} days left)`);
  console.log('meta     :', JSON.stringify({ reference: sub.reference, method: sub.method, amount: sub.amount, paidAt: sub.paidAt }));

  let target = null;
  const sub7 = flag('--subtract'), set7 = flag('--set-days');
  if (sub7 != null) target = Number(sub.expiresAt) - sub7 * DAY;
  if (set7 != null) target = Date.now() + set7 * DAY;
  if (target == null) return;
  console.log(`new expiry: ${new Date(target).toISOString()} (${((target - Date.now()) / DAY).toFixed(2)} days left)`);
  if (!apply) { console.log('dry run - add --apply to save'); return; }
  // saveSubscriber mirrors the value to every linked id and the user document
  await saveSubscriber(ids[0], target, { method: 'manual_fix', fixedAt: Date.now() });
  console.log('saved.');
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  try { if (typeof closeDb === 'function') await closeDb(); } catch (_) {}
  process.exit(process.exitCode || 0);
});
