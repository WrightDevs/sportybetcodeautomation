'use strict';
const fs = require('fs');
const path = require('path');
const { CFG } = require('./config');
const { sleep, lagosDay, hhmm } = require('./util');
const { scan } = require('./scan');
const { scanLive } = require('./live');
const { llmRank } = require('./rank');
const { mint } = require('./mint');

async function generate(preset) {
  let legs = preset.mode === 'live' ? await scanLive(preset) : await scan(preset);

  if (!legs.length && preset.fallbackUpcoming) {
    console.log('  live empty — falling back to upcoming');
    legs = await scan({ ...preset, mode: 'upcoming', windowMin: preset.fallbackUpcoming.windowMin });
  }
  if (!legs.length) return { lines: [], count: 0 };

  if (preset.llm) legs = await llmRank(legs);

  const short = legs.slice(0, preset.legs * preset.maxCodes);
  const lines = [];

  for (let i = 0; i < short.length; i += preset.legs) {
    const chunk = short.slice(i, i + preset.legs);
    console.log(`  batch ${i / preset.legs + 1}: ${chunk.length} legs`);
    const r = await mint(chunk);

    if (r.code) {
      const combined = chunk.reduce((a, l) => a * l.odds, 1).toFixed(1);
      lines.push(`${r.code}  ${chunk.length} legs  @${combined}${r.url ? '\n' + r.url : ''}`);
    } else {
      lines.push(`batch ${i / preset.legs + 1} failed: ${r.err}`);
    }
    if (i + preset.legs < short.length) await sleep(preset.gap);
  }

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
  const stamp = lagosDay() + '-' + new Date().toISOString().slice(11, 16).replace(':', '');
  fs.writeFileSync(path.join(CFG.OUT_DIR, `${stamp}.txt`), lines.join('\n\n') + '\n');

  return { lines, count: lines.filter(l => !l.startsWith('batch')).length };
}

module.exports = { generate };
