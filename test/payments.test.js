'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Isolate every side effect: temp reference file, no real MongoDB, a random port, no writes to subscribers.json
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/test';
process.env.PAID_REFS_FILE = path.join(os.tmpdir(), `paid_refs_${process.pid}.json`);
const PORT = 3900 + Math.floor(Math.random() * 90);
process.env.WEBHOOK_PORT = String(PORT);
process.env.QUESTPAY_API_KEY = 'test-key';

const db = require('../src/db');
const saved = []; // [{ id, expiresAt }]
db.saveSubscriber = (id, expiresAt, meta) => { saved.push({ id: String(id), expiresAt, meta }); db.subCache.set(String(id), { chatId: String(id), expiresAt }); };
const subs = require('../src/subs');
const { startWebhookServer } = require('../src/webhook');

const realFetch = global.fetch;
let verifyAnswer = { success: false, data: { status: 'pending' } };
global.fetch = async (url, opts) => {
  if (String(url).includes('/v1/checkout/verify/')) {
    return { ok: true, json: async () => verifyAnswer };
  }
  return realFetch(url, opts);
};

const paidAnswer = (ref, chatId) => ({ success: true, data: { status: 'paid', reference: ref, amount: 1000,
  metadata: { chatId: String(chatId), userId: String(chatId), days: 7 } } });
const body = (ref, chatId) => JSON.stringify({ event: 'payment.received', data: { reference: ref, status: 'paid', amount: 1000, metadata: { chatId: String(chatId), days: 7 } } });
const sign = raw => crypto.createHmac('sha256', 'test-key').update(raw).digest('hex');

test('creditPaymentOnce: the same reference credits only once', async () => {
  saved.length = 0;
  const a = await subs.creditPaymentOnce('u_once', 'REF-ONCE-1', 7, { method: 't' });
  const b = await subs.creditPaymentOnce('u_once', 'REF-ONCE-1', 7, { method: 't' });
  const c = await subs.creditPaymentOnce('u_once', 'REF-ONCE-2', 7, { method: 't' });
  assert.equal(a.credited, true);
  assert.equal(b.credited, false);
  assert.equal(b.duplicate, true);
  assert.equal(c.credited, true); // a different payment still credits
  assert.equal(saved.filter(s => s.id === 'u_once').length, 2);
});

test('creditPaymentOnce: concurrent calls with one reference credit exactly once', async () => {
  saved.length = 0;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => subs.creditPaymentOnce('u_race', 'REF-RACE', 7)));
  assert.equal(rs.filter(r => r.credited).length, 1);
  assert.equal(saved.filter(s => s.id === 'u_race').length, 1);
});

test('two open checkouts for one user: one payment credits only once (haley scenario)', async () => {
  saved.length = 0;
  await db.registerCheckout('VIP-777-A', '777');   // started in Telegram, abandoned
  await db.registerCheckout('VIP-777-B', '777');   // started on the dashboard, paid
  const b = await subs.creditPaymentOnce('777', 'VIP-777-B', 7, { method: 't' });
  const a = await subs.creditPaymentOnce('777', 'VIP-777-A', 7, { method: 't' }); // provider also reports A as paid
  const a2 = await subs.creditPaymentOnce('777', 'VIP-777-A', 7, { method: 't' });
  assert.equal(b.credited, true);
  assert.equal(a.credited, false); assert.equal(a.duplicate, true); assert.equal(a.superseded, true);
  assert.equal(a2.credited, false);
  assert.equal(saved.filter(s => s.id === '777').length, 1);
});

test('a checkout created AFTER a credit still credits (genuine second payment works)', async () => {
  saved.length = 0;
  await db.registerCheckout('VIP-888-A', '888');
  assert.equal((await subs.creditPaymentOnce('888', 'VIP-888-A', 7)).credited, true);
  await db.registerCheckout('VIP-888-B', '888');
  assert.equal((await subs.creditPaymentOnce('888', 'VIP-888-B', 7)).credited, true);
  assert.equal(saved.filter(s => s.id === '888').length, 2);
});

test('checkouts of different users do not void each other; unregistered refs behave as before', async () => {
  saved.length = 0;
  await db.registerCheckout('VIP-901-A', '901');
  await db.registerCheckout('VIP-902-A', '902');
  assert.equal((await subs.creditPaymentOnce('901', 'VIP-901-A', 7)).credited, true);
  assert.equal((await subs.creditPaymentOnce('902', 'VIP-902-A', 7)).credited, true);
  assert.equal((await subs.creditPaymentOnce('903', 'LEGACY-REF', 7)).credited, true);
});

const post = (p, obj, headers = {}) => realFetch(`http://localhost:${PORT}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof obj === 'string' ? obj : JSON.stringify(obj)
}).then(async r => ({ status: r.status, json: await r.json() }));

test('webhook, generate gate and verify route', { timeout: 60000 }, async (t) => {
  let notified = 0;
  const server = startWebhookServer(async () => { notified++; });
  await new Promise(r => setTimeout(r, 400));
  t.after(() => server.close());

  await t.test('forged unsigned webhook is NOT credited when QuestPay does not confirm it', async () => {
    saved.length = 0; verifyAnswer = { success: false, data: { status: 'pending' } };
    const r = await post('/webhook/questpay', body('REF-FORGED', 'victim_1'));
    assert.equal(r.json.status, 'ignored');
    assert.equal(saved.filter(s => s.id === 'victim_1').length, 0);
    assert.equal(notified, 0);
  });

  await t.test('correctly signed webhook credits once; a retry does not credit again', async () => {
    saved.length = 0;
    const raw = body('REF-SIGNED', 'payer_1');
    const first = await post('/webhook/questpay', raw, { 'x-questpay-signature': sign(raw) });
    const retry = await post('/webhook/questpay', raw, { 'x-questpay-signature': sign(raw) });
    assert.equal(first.json.credited, true);
    assert.equal(retry.json.credited, false);
    assert.equal(saved.filter(s => s.id === 'payer_1').length, 1);
    assert.equal(notified, 1);
  });

  await t.test('unsigned webhook IS credited when QuestPay confirms it (and uses QuestPay\'s chat id)', async () => {
    saved.length = 0; verifyAnswer = paidAnswer('REF-UNSIGNED-OK', 'real_payer');
    const r = await post('/webhook/questpay', body('REF-UNSIGNED-OK', 'someone_else'));
    assert.equal(r.json.credited, true);
    assert.equal(saved.filter(s => s.id === 'real_payer').length, 1);
    assert.equal(saved.filter(s => s.id === 'someone_else').length, 0);
  });

  await t.test('repeated /api/payment/verify calls credit once and flag alreadyCredited', async () => {
    saved.length = 0; verifyAnswer = paidAnswer('REF-VERIFY', 'web_payer');
    const get = () => realFetch(`http://localhost:${PORT}/api/payment/verify/REF-VERIFY`).then(r => r.json());
    const a = await get(); const b = await get(); const c = await get();
    assert.equal(a.success, true); assert.equal(a.alreadyCredited, false);
    assert.equal(b.alreadyCredited, true); assert.equal(c.alreadyCredited, true);
    assert.equal(saved.filter(s => s.id === 'web_payer').length, 1);
  });

  await t.test('one payment reported by webhook + verify + retries grants exactly 7 days in total', async () => {
    saved.length = 0; db.subCache.delete('haley_like');
    verifyAnswer = paidAnswer('REF-ONE-WEEK', 'haley_like');
    const raw = body('REF-ONE-WEEK', 'haley_like');
    const t0 = Date.now();
    await post('/webhook/questpay', raw, { 'x-questpay-signature': sign(raw) });
    await realFetch(`http://localhost:${PORT}/api/payment/verify/REF-ONE-WEEK`).then(r => r.json());
    await post('/webhook/questpay', raw, { 'x-questpay-signature': sign(raw) });
    await realFetch(`http://localhost:${PORT}/api/payment/verify/REF-ONE-WEEK`).then(r => r.json());
    const mine = saved.filter(s => s.id === 'haley_like');
    assert.equal(mine.length, 1);
    const days = (mine[0].expiresAt - t0) / 86400000;
    assert.ok(days > 6.99 && days < 7.01, `expected 7 days, got ${days}`);
  });

  await t.test('/api/generate requires a subscription and does not run the generator', async () => {
    const r = await post('/api/generate', { sport: 'football', userId: 'not_subscribed_user' });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'subscription_required');
  });
});
