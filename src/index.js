'use strict';
const fs = require('fs');
const path = require('path');
const { CFG } = require('./config');
const { sleep, lagosDay, dayStart, hhmm } = require('./util');
const { scan } = require('./scan');
const { llmRank } = require('./rank');
const { mint } = require('./mint');
const { telegram } = require('./notify');

async function run(flags = {}) {
  console.log(`region=${CFG.REGION} band=${CFG.MIN_ODDS}-${CFG.MAX_ODDS} target=${CFG.TARGET}`);

  if (flags.ping) {
    const ok = await telegram('sb-codes ping — delivery works');
    console.log(ok ? 'ping sent' : 'ping failed');
    return;
  }

  const day = lagosDay();
  let legs = await scan();
  console.log(`  ${legs.length} candidates from ${hhmm(dayStart())}`);

  if (!legs.length) {
    await telegram(`${day}: no candidates in band`);
    return;
  }

  legs = await llmRank(legs);
  const limit = flags.test ? 1 : CFG.MAX_CODES * CFG.LEGS_PER_CODE;
  const short = legs.slice(0, limit);

  if (flags.dry) {
    console.log(short.map(l => `${hhmm(l.ko)} ${l.league} | ${l.home} v ${l.away} | ${l.desc} @${l.odds}`).join('\n'));
    return;
  }

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });

  const lines = [];
  for (let i = 0; i < short.length; i += CFG.LEGS_PER_CODE) {
    const chunk = short.slice(i, i + CFG.LEGS_PER_CODE);
    const n = i / CFG.LEGS_PER_CODE + 1;
    console.log(`  batch ${n}: ${chunk.length} legs`);

    const r = await mint(chunk);
    if (r.code) {
      const combined = chunk.reduce((a, l) => a * l.odds, 1).toFixed(1);
      lines.push(`${r.code}  ${chunk.length} legs  @${combined}${r.url ? '\n' + r.url : ''}`);
      console.log(`    CODE ${r.code}`);
    } else {
      lines.push(`batch ${n} FAILED: ${r.err}`);
      console.log(`    fail ${r.err}`);
    }

    if (i + CFG.LEGS_PER_CODE < short.length) await sleep(CFG.GAP_MS);
  }

  fs.writeFileSync(path.join(CFG.OUT_DIR, `${day}.txt`), lines.join('\n\n') + '\n');
  await telegram(`${day} — ${lines.filter(l => !l.startsWith('batch')).length} codes\n\n` + lines.join('\n\n'));
  console.log('done');
}

module.exports = { run };

