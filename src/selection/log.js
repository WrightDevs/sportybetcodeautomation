'use strict';
// JSON-lines slip/leg log for calibration. One line per leg of every generated slip.
const fs = require('fs');
const path = require('path');
const { SELECTION } = require('./config');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'selection-log.jsonl');
const file = () => SELECTION.LOG_FILE || DEFAULT_FILE;

function logSlip({ code, mode, legs, jointProb, totalOdds }, filePath = file()) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const ts = new Date().toISOString();
    const lines = legs.map(l => JSON.stringify({
      ts, code, mode, jointProb, totalOdds,
      eventId: l.eventId, home: l.home, away: l.away, league: l.league,
      stage: l.stage, minute: l.minute, scoreH: l.scoreH, scoreA: l.scoreA,
      marketId: l.marketId, specifier: l.specifier || '', outcomeId: l.outcomeId,
      type: l.type, line: l.line ?? null, odds: l.odds,
      prob: l.prob, probModel: l.probModel, probMarket: l.probMarket, score: l.score,
      result: null
    }));
    fs.appendFileSync(filePath, lines.join('\n') + '\n');
  } catch (e) {
    console.error('selection log failed:', e.message);
  }
}

function readLog(filePath = file()) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function writeLog(rows, filePath = file()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

module.exports = { logSlip, readLog, writeLog };
