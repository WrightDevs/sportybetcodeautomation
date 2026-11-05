#!/usr/bin/env node
'use strict';
// Settle logged selector legs and print the calibration report.
//   node bin/settle.js                      settle pending legs, print report
//   node bin/settle.js --report             report only (no network)
//   node bin/settle.js --backtest 0.85 [60] replay settled legs with a stricter MIN prob [and min score]
const { API, get } = require('../src/api');
const { readLog, writeLog } = require('../src/selection/log');
const { settleRow, calibrationReport, formatReport } = require('../src/selection/report');
const { sleep } = require('../src/util');

(async () => {
  const args = process.argv.slice(2);
  const rows = readLog();
  if (!rows.length) { console.log('No selection log yet (data/selection-log.jsonl).'); return; }

  const bt = args.indexOf('--backtest');
  if (bt >= 0) {
    const minProb = Number(args[bt + 1]) || 0, minScore = Number(args[bt + 2]) || 0;
    console.log(`Backtest: legs with prob >= ${minProb}${minScore ? ` and score >= ${minScore}` : ''}`);
    console.log(formatReport(calibrationReport(rows, { minProb, minScore })));
    return;
  }

  if (!args.includes('--report')) {
    const cache = new Map();
    let n = 0;
    for (const r of rows) {
      if (r.result) continue;
      if (!cache.has(r.eventId)) {
        const j = await get(`${API}/factsCenter/event?eventId=${encodeURIComponent(r.eventId)}`);
        cache.set(r.eventId, j && j.data);
        await sleep(150);
      }
      const res = settleRow(r, cache.get(r.eventId));
      if (res) { r.result = { ...res, settledAt: new Date().toISOString() }; n++; }
    }
    writeLog(rows);
    console.log(`Settled ${n} legs.\n`);
  }
  console.log(formatReport(calibrationReport(rows)));
})();
