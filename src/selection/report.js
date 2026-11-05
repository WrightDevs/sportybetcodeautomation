'use strict';
// Calibration report over settled log rows (pure).
const { legPredicate } = require('./model');

const HT_MARKETS = ['60', '63', '65', '68'];

// Decide a leg result from a final event payload (factsCenter/event data). null => not settled yet.
function settleRow(row, evData) {
  if (!evData) return null;
  const ended = evData.status === 2 || evData.status === 3 || /^(end|ended|finished)$/i.test(String(evData.matchStatus || ''));
  if (!ended) return null;
  const pred = legPredicate(row);
  if (!pred) return null;
  let raw = String(evData.setScore || '');
  if (HT_MARKETS.includes(String(row.marketId))) raw = String((evData.gameScore || [])[0] || '');
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (!m) return null;
  return { won: !!pred(Number(m[1]), Number(m[2])), score: raw };
}

const pct = x => (x * 100).toFixed(1) + '%';

function bucketOf(p) {
  const lo = Math.floor(p * 20) / 20; // 5% buckets
  return `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
}

function calibrationReport(rows, { minProb = 0, minScore = 0 } = {}) {
  const settled = rows.filter(r => r.result && typeof r.result.won === 'boolean' && r.prob >= minProb && (r.score ?? 0) >= minScore);
  const group = keyFn => {
    const g = {};
    for (const r of settled) {
      const k = keyFn(r);
      g[k] = g[k] || { n: 0, wins: 0, predicted: 0 };
      g[k].n++; g[k].wins += r.result.won ? 1 : 0; g[k].predicted += r.prob;
    }
    return Object.entries(g).sort().map(([k, v]) => ({
      key: k, n: v.n, hitRate: v.wins / v.n, avgPredicted: v.predicted / v.n
    }));
  };
  const brier = settled.length
    ? settled.reduce((a, r) => a + Math.pow(r.prob - (r.result.won ? 1 : 0), 2), 0) / settled.length
    : null;
  const wins = settled.filter(r => r.result.won).length;
  return {
    settled: settled.length, pending: rows.length - settled.length,
    overallHitRate: settled.length ? wins / settled.length : null,
    avgPredicted: settled.length ? settled.reduce((a, r) => a + r.prob, 0) / settled.length : null,
    brier,
    byMarketType: group(r => r.type || `${r.marketId}/${r.outcomeId}`),
    byProbBucket: group(r => bucketOf(r.prob))
  };
}

function formatReport(rep) {
  const lines = [];
  lines.push(`Settled legs: ${rep.settled}   Pending: ${rep.pending}`);
  if (!rep.settled) { lines.push('No settled legs yet.'); return lines.join('\n'); }
  lines.push(`Hit rate: ${pct(rep.overallHitRate)}   Avg predicted: ${pct(rep.avgPredicted)}   Brier: ${rep.brier.toFixed(4)}`);
  lines.push('\nBy market type (n, hit rate, avg predicted):');
  for (const g of rep.byMarketType) lines.push(`  ${g.key.padEnd(24)} n=${String(g.n).padEnd(4)} hit ${pct(g.hitRate).padEnd(7)} pred ${pct(g.avgPredicted)}`);
  lines.push('\nBy probability bucket (calibrated = hit ~ predicted):');
  for (const g of rep.byProbBucket) lines.push(`  ${g.key.padEnd(12)} n=${String(g.n).padEnd(4)} hit ${pct(g.hitRate).padEnd(7)} pred ${pct(g.avgPredicted)}`);
  return lines.join('\n');
}

module.exports = { settleRow, calibrationReport, formatReport, bucketOf };
