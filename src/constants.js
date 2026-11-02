'use strict';

const MARKETS = ['10', '11', '1', '26', '36', '18', '29', '14'];

const DESC = {
  '1': '1X2', '10': 'Double chance', '11': 'Draw no bet', '18': 'Over/Under',
  '29': 'GG/NG', '26': 'Home goals', '36': 'Away goals', '14': 'Handicap'
};

/* market safety weight — DC on a favourite is the safest shape in this band */
const WEIGHT = { '10': 1.00, '11': 0.95, '26': 0.90, '18': 0.88, '36': 0.85, '1': 0.70, '29': 0.60, '14': 0.55 };

const JUNK = /(srl|esoccer|e-football|efootball|virtual|simulated|instant|cyber)/i;

module.exports = { MARKETS, DESC, WEIGHT, JUNK };

