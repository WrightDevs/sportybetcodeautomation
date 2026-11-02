'use strict';
const { CFG } = require('./config');
const { API, get } = require('./api');
const { MARKETS, DESC, WEIGHT, JUNK } = require('./constants');
const { sleep, dayStart, dayEnd } = require('./util');

function scoreOutcome(odd, marketId) {
  return (1 / odd) * WEIGHT[marketId];
}

async function scan() {
  const lo = dayStart();
  const hi = dayEnd();
  const now = Date.now();
  const hours = Math.min(720, Math.max(1, Math.ceil((hi - now) / 36e5)));
  const seen = new Map();

  for (let page = 1; page <= 30; page++) {
    const j = await get(`${API}/factsCenter/pcUpcomingEvents?sportId=sr:sport:1`
      + `&marketId=${MARKETS.join(',')}&pageSize=100&pageNum=${page}`
      + `&option=1&order=0&todayGames=false&timeline=${hours}&_t=${Date.now()}`);

    const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name }))) || [];
    if (!evs.length) break;

    for (const { e, league } of evs) {
      if (seen.has(e.eventId)) continue;
      const ko = Number(e.estimateStartTime);
      if (ko < now + 60000 || ko > hi || ko < lo) continue;

      let best = null;
      for (const mid of MARKETS) {
        const m = (e.markets || []).find(x => String(x.id) === mid && x.status === 0);
        if (!m) continue;
        for (const o of (m.outcomes || [])) {
          const odd = parseFloat(o.odds);
          if (odd < CFG.MIN_ODDS || odd > CFG.MAX_ODDS) continue;
          if (o.isActive === 0 || o.isActive === '0') continue;
          const score = scoreOutcome(odd, mid);
          if (!best || score > best.score) best = { m, o, odd, score };
        }
        if (best) break;
      }
      if (!best) continue;

      seen.set(e.eventId, {
        id: e.eventId,
        ko,
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

    await sleep(300);
    if (seen.size >= CFG.TARGET * 3) break;
  }

  let legs = [...seen.values()].sort((a, b) => b.score - a.score);

  const perLeague = {};
  legs = legs.filter(l => {
    perLeague[l.league] = (perLeague[l.league] || 0) + 1;
    return perLeague[l.league] <= CFG.LEAGUE_CAP;
  });

  return legs.filter(l => !JUNK.test(l.league))
    .concat(legs.filter(l => JUNK.test(l.league)))
    .slice(0, CFG.TARGET);
}

module.exports = { scan, scoreOutcome };

