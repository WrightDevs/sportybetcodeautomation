'use strict';
const { CFG } = require('./config');
const { API, get } = require('./api');
const { MARKETS, DESC, WEIGHT, VIRTUAL_SPORTS, virtualWeight, JUNK } = require('./constants');
const { sleep, dayStart, dayEnd } = require('./util');

const SURE_FLOOR = 0.80;

async function scanSport(sport, seen) {
  const isVirtual = VIRTUAL_SPORTS.has(sport);
  const now = Date.now();
  const lo = isVirtual ? now : dayStart();
  const hi = isVirtual ? now + CFG.VIRTUAL_WINDOW_MIN * 60000 : dayEnd();
  const hours = Math.max(1, Math.ceil((hi - now) / 36e5));

  for (let page = 1; page <= 30; page++) {
    const j = await get(`${API}/factsCenter/pcUpcomingEvents?sportId=${encodeURIComponent(sport)}`
      + `&marketId=${MARKETS.join(',')}&pageSize=100&pageNum=${page}`
      + `&option=1&order=0&todayGames=false&timeline=${hours}&_t=${Date.now()}`);

    const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name }))) || [];
    if (!evs.length) break;

    for (const { e, league } of evs) {
      if (seen.has(e.eventId)) continue;
      const ko = Number(e.estimateStartTime);
      if (ko < now + 45000 || ko > hi || ko < lo) continue;

      let best = null;
      for (const mid of MARKETS) {
        const m = (e.markets || []).find(x => String(x.id) === mid && x.status === 0);
        if (!m) continue;
        for (const o of (m.outcomes || [])) {
          const odd = parseFloat(o.odds);
          if (odd < CFG.MIN_ODDS || odd > CFG.MAX_ODDS) continue;
          if (o.isActive === 0 || o.isActive === '0') continue;

          const w = isVirtual ? virtualWeight(mid, o.desc, m.specifier) : WEIGHT[mid];
          if (isVirtual && CFG.SURE_ONLY && w < SURE_FLOOR) continue;

          const score = (1 / odd) * w;
          if (!best || score > best.score) best = { m, o, odd, score, sport };
        }
        if (best) break;
      }
      if (!best) continue;

      seen.set(e.eventId, {
        id: e.eventId,
        ko,
        sport,
        league,
        home: e.homeTeamName,
        away: e.awayTeamName,
        marketId: String(best.m.id),
        specifier: best.m.specifier || '',
        outcomeId: String(best.o.id),
        odds: best.odd,
        desc: DESC[String(best.m.id)] || '',
        score: best.score
      });
    }

    await sleep(isVirtual ? 150 : 300);
    if (seen.size >= CFG.TARGET * 3) break;
  }
}

async function scan() {
  const seen = new Map();
  for (const sport of CFG.SPORTS) {
    const before = seen.size;
    await scanSport(sport, seen);
    console.log(`  ${sport}: +${seen.size - before}`);
  }

  let legs = [...seen.values()].sort((a, b) => b.score - a.score);

  const perLeague = {};
  legs = legs.filter(l => {
    const cap = VIRTUAL_SPORTS.has(l.sport) ? CFG.VIRTUAL_LEAGUE_CAP : CFG.LEAGUE_CAP;
    perLeague[l.league] = (perLeague[l.league] || 0) + 1;
    return perLeague[l.league] <= cap;
  });

  if (CFG.VIRTUAL) return legs.slice(0, CFG.TARGET);

  return legs.filter(l => !JUNK.test(l.league))
    .concat(legs.filter(l => JUNK.test(l.league)))
    .slice(0, CFG.TARGET);
}

module.exports = { scan };
