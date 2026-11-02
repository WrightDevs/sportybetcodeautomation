'use strict';

const TZ = 'Africa/Lagos';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lagosDay = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const dayStart = () => Date.parse(lagosDay() + 'T00:00:00+01:00');
const dayEnd = () => dayStart() + 86399000;
const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

module.exports = { TZ, sleep, lagosDay, dayStart, dayEnd, hhmm };

