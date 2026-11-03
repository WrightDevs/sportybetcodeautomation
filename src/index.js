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
  const targetOdds = flags.odds ? Number(flags.odds) : CFG.TARGET_ODDS;
  const maxCodes = flags.codes ? Number(flags.codes) : (flags.odds ? 1 : CFG.MAX_CODES);

  console.log(`region=${CFG.REGION} band=${CFG.MIN_ODDS}-${CFG.MAX_ODDS} target=${CFG.TARGET}${targetOdds > 0 ? ` targetOdds=@${targetOdds}` : ''}`);

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

  let batches = [];
  if (flags.test) {
    batches = [legs.slice(0, 1)];
  } else if (targetOdds > 0) {
    let current = [];
    let currentOdds = 1.0;

    for (const leg of legs) {
      current.push(leg);
      currentOdds *= leg.odds;

      if (currentOdds >= targetOdds || current.length >= CFG.LEGS_PER_CODE) {
        batches.push(current);
        current = [];
        currentOdds = 1.0;
        if (batches.length >= maxCodes) break;
      }
    }

    if (batches.length === 0 && current.length > 0) {
      batches.push(current);
    }
  } else {
    const limit = maxCodes * CFG.LEGS_PER_CODE;
    const short = legs.slice(0, limit);
    for (let i = 0; i < short.length; i += CFG.LEGS_PER_CODE) {
      batches.push(short.slice(i, i + CFG.LEGS_PER_CODE));
    }
  }

  if (flags.dry) {
    batches.forEach((chunk, idx) => {
      let runOdds = 1.0;
      console.log(`\n--- Slip ${idx + 1} (${chunk.length} legs) ---`);
      for (const l of chunk) {
        runOdds *= l.odds;
        console.log(`${hhmm(l.ko)} ${l.league} | ${l.home} v ${l.away} | ${l.desc} @${l.odds} (cum: @${runOdds.toFixed(2)})`);
      }
      console.log(`Total Odds: @${runOdds.toFixed(2)}`);
    });
    return;
  }

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });

  const lines = [];
  for (let i = 0; i < batches.length; i++) {
    const chunk = batches[i];
    const n = i + 1;
    const estOdds = chunk.reduce((a, l) => a * l.odds, 1).toFixed(2);
    console.log(`  batch ${n}: ${chunk.length} legs (target: @${estOdds})`);

    const r = await mint(chunk);
    if (r.code) {
      lines.push(`${r.code}  ${chunk.length} legs  @${estOdds}${r.url ? '\n' + r.url : ''}`);
      console.log(`    CODE ${r.code}`);
    } else {
      lines.push(`batch ${n} FAILED: ${r.err}`);
      console.log(`    fail ${r.err}`);
    }

    if (i + 1 < batches.length) await sleep(CFG.GAP_MS);
  }

  fs.writeFileSync(path.join(CFG.OUT_DIR, `${day}.txt`), lines.join('\n\n') + '\n');
  await telegram(`${day} — ${lines.filter(l => !l.startsWith('batch')).length} codes\n\n` + lines.join('\n\n'));
  console.log('done');
}

module.exports = { run };
