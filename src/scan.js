'use strict';
const { CFG } = require('./config');
const { API, get } = require('./api');
const { MARKETS, DESC, WEIGHT, VIRTUAL_SPORTS, virtualWeight, JUNK } = require('./constants');
const { sleep, dayStart, dayEnd } = require('./util');
const { PRESETS } = require('./presets');

const SURE_FLOOR = 0.80;

async function scan(cfg = PRESETS.football) {
  const seen = new Map();
  const isVirtual = !!cfg.virtual;
  const now = Date.now();
  const hi = cfg.windowMin ? now + cfg.windowMin * 60000 : dayEnd();
  const lo = cfg.windowMin ? now : dayStart();
  const hours = Math.max(1, Math.ceil((hi - now) / 36e5));

  for (const sport of (cfg.sports || CFG.SPORTS)) {
    for (let page = 1; page <= 30; page++) {
      const j = await get(`${API}/factsCenter/pcUpcomingEvents?sportId=${encodeURIComponent(sport)}`
        + `&marketId=${MARKETS.join(',')}&pageSize=100&pageNum=${page}`
        + `&option=1&order=0&todayGames=false&timeline=${hours}&_t=${Date.now()}`);

      const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name }))) || [];
      if (!evs.length) break;

      for (const { e, league } of evs) {
        if (seen.has(e.eventId)) continue;
        const ko = Number(e.estimateStartTime);
        if (ko < now + 30000 || ko > hi || ko < lo) continue;

        let best = null;
        for (const mid of MARKETS) {
          const m = (e.markets || []).find(x => String(x.id) === mid && x.status === 0);
          if (!m) continue;
          for (const o of (m.outcomes || [])) {
            const odd = parseFloat(o.odds);
            if (odd < (cfg.min || CFG.MIN_ODDS) || odd > (cfg.max || CFG.MAX_ODDS)) continue;
            if (o.isActive === 0 || o.isActive === '0') continue;
            const w = isVirtual ? virtualWeight(mid, o.desc, m.specifier) : WEIGHT[mid];
            if (isVirtual && w < SURE_FLOOR) continue;
            const score = (1 / odd) * w;
            if (!best || score > best.score) best = { m, o, odd, score };
          }
          if (best) break;
        }
        if (!best) continue;

        seen.set(e.eventId, {
          id: e.eventId, ko, sport, league,
          home: e.homeTeamName, away: e.awayTeamName,
          marketId: String(best.m.id), specifier: best.m.specifier || '',
          outcomeId: String(best.o.id), odds: best.odd,
          desc: DESC[String(best.m.id)] || '', score: best.score
        });
      }
      await sleep(isVirtual ? 150 : 300);
      const targetSize = (cfg.legs || CFG.LEGS_PER_CODE) * (cfg.maxCodes || CFG.MAX_CODES) * 3;
      if (seen.size >= targetSize) break;
    }
  }

  let legs = [...seen.values()].sort((a, b) => b.score - a.score);
  const perLeague = {};
  legs = legs.filter(l => {
    perLeague[l.league] = (perLeague[l.league] || 0) + 1;
    return perLeague[l.league] <= (cfg.leagueCap || CFG.LEAGUE_CAP);
  });
  return isVirtual ? legs : legs.filter(l => !JUNK.test(l.league))
    .concat(legs.filter(l => JUNK.test(l.league)));
}

module.exports = { scan };
