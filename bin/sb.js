#!/usr/bin/env node
'use strict';
const { run } = require('../src');

run({
  dry: process.argv.includes('--dry'),
  test: process.argv.includes('--test'),
  ping: process.argv.includes('--ping')
}).catch(e => {
  console.error(e);
  process.exit(1);
});

