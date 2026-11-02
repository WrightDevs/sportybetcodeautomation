'use strict';
const { post } = require('./api');
const { sleep } = require('./util');

const WAITS = [60000, 180000, 360000];

const toBody = legs => ({
  selections: legs.map(l => ({
    eventId: l.id,
    marketId: l.marketId,
    specifier: l.specifier,
    outcomeId: l.outcomeId
  }))
});

async function mint(legs) {
  for (let i = 0; i <= WAITS.length; i++) {
    const { status, j, raw } = await post(toBody(legs));
    const code = j?.data?.shareCode || j?.data?.bookingCode;
    if (code) return { code, url: j.data.shareURL || '' };

    const limited = status === 429 || j?.bizCode === 19411 || /rate limit/i.test(raw);
    if (limited && i < WAITS.length) { await sleep(WAITS[i]); continue; }

    if (!limited && legs.length > 8) {
      const half = Math.ceil(legs.length / 2);
      const a = await mint(legs.slice(0, half));
      if (!a.code) return a;
      await sleep(20000);
      const b = await mint(legs.slice(half));
      return b.code ? { code: a.code, extra: b.code } : a;
    }

    return { err: `${status} ${raw.slice(0, 160)}` };
  }
  return { err: 'limiter' };
}

module.exports = { mint, toBody };

