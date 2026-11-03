#!/usr/bin/env node
'use strict';

if (process.argv.includes('--virtual')) {
  process.env.SPORTS = 'sr:sport:202120001,sr:sport:137';
  process.env.SURE_ONLY ??= 'true';
  process.env.VIRTUAL_WINDOW_MIN ??= '25';
  process.env.LEGS_PER_CODE ??= '25';
  process.env.MAX_CODES ??= '2';
}

const getArg = (flag) => {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')) {
    return process.argv[idx + 1];
  }
  const prefix = `${flag}=`;
  const match = process.argv.find(a => a.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  return null;
};

const { run } = require('../src');

run({
  dry: process.argv.includes('--dry'),
  test: process.argv.includes('--test'),
  ping: process.argv.includes('--ping'),
  odds: getArg('--odds'),
  codes: getArg('--codes')
}).catch(e => {
  console.error(e);
  process.exit(1);
});
