#!/usr/bin/env node
'use strict';
const { run } = require('../src');

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
