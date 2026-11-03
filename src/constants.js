'use strict';

const MARKETS = ['10', '11', '1', '26', '36', '18', '29', '14'];

const DESC = {
  '1': '1X2', '10': 'Double chance', '11': 'Draw no bet', '18': 'Over/Under',
  '29': 'GG/NG', '26': 'Home goals', '36': 'Away goals', '14': 'Handicap'
};

/* real-football safety weight — DC on a favourite is the safest shape in this band */
const WEIGHT = { '10': 1.00, '11': 0.95, '26': 0.90, '18': 0.88, '36': 0.85, '1': 0.70, '29': 0.60, '14': 0.55 };

const VIRTUAL_SPORTS = new Set(['sr:sport:137', 'sr:sport:202120001']);

const totalOf = spec => parseFloat((/total=([\d.]+)/.exec(spec || '') || [])[1] || 0);

/* virtual weight — Over 0.5 is near-certain in a 3-minute match; 1X2 is not */
function virtualWeight(marketId, outcomeDesc, specifier) {
  const total = totalOf(specifier);
  const isOver = String(outcomeDesc || '').startsWith('Over');
  const isUnder = String(outcomeDesc || '').startsWith('Under');

  if (marketId === '18') {
    if (isOver && total <= 0.5) return 1.00;
    if (isUnder && total >= 5.5) return 0.95;
    if (isUnder && total >= 4.5) return 0.88;
    if (isOver && total <= 1.5) return 0.82;
    return 0.60;
  }
  if (marketId === '10') return 0.97;
  if (marketId === '26' || marketId === '36') return 0.80;
  if (marketId === '1') return 0.55;
  if (marketId === '29') return 0.50;
  return 0.45;
}

const JUNK = /(srl|esoccer|e-football|efootball|virtual|simulated|instant|cyber)/i;

module.exports = { MARKETS, DESC, WEIGHT, VIRTUAL_SPORTS, virtualWeight, JUNK };
