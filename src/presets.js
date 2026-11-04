'use strict';

const PRESETS = {
  football: {
    key: 'football',
    label: 'Football', icon: '⚽',
    sports: ['sr:sport:1'],
    mode: 'upcoming', windowMin: 0,
    min: 1.05, max: 1.25,
    legs: 50, maxCodes: 4, gap: 90000,
    llm: true, leagueCap: 6, virtual: false
  },
  efootball: {
    key: 'efootball',
    label: 'eFootball', icon: '🕹',
    sports: ['sr:sport:137'],
    mode: 'live',
    min: 1.01, max: 1.30,
    legs: 10, maxCodes: 1, gap: 20000,
    llm: false, leagueCap: 40, virtual: true,
    rule: { early: 40, mid: 70, late: 80, margin: 3 },
    fallbackUpcoming: { windowMin: 20 }
  },
  vfootball: {
    key: 'vfootball',
    label: 'vFootball', icon: '⚡',
    sports: ['sr:sport:202120001'],
    mode: 'live',
    min: 1.01, max: 1.30,
    legs: 8, maxCodes: 1, gap: 15000,
    llm: false, leagueCap: 40, virtual: true,
    /* compressed clock — the threshold has to arrive sooner */
    rule: { early: 55, mid: 75, late: 85, margin: 2 },
    fallbackUpcoming: { windowMin: 20 }
  }
};

module.exports = { PRESETS };
