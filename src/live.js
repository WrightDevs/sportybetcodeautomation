'use strict';
const { CFG } = require('./config');
const { API, get } = require('./api');
const { sleep } = require('./util');

const clockOf = ev => {
  for (const k of ['matchClock', 'elapsed', 'minute', 'matchTime', 'periodTime', 'time']) {
    const v = ev[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  const m = /(\d{1,3})/.exec(String(ev.matchStatus || ''));
  return m ? Number(m[1]) : null;
};

const scoreOf = ev => [
  Number(ev.homeTeamScore ?? ev.homeScore ?? ev.home?.score ?? NaN),
  Number(ev.awayTeamScore ?? ev.awayScore ?? ev.away?.score ?? NaN)
];

function qualifies(minute, margin, rule) {
  if (!Number.isFinite(minute) || minute > 89) return false;
  if (minute >= rule.late && margin >= 1) return true;
  if (minute >= rule.mid && margin >= 2) return true;
  if (minute >= rule.early && margin >= rule.margin) return true;
  return false;
}

async function scanLive(cfg) {
  const out = [];
  const rule = cfg.rule;

  for (const sport of cfg.sports) {
    for (let page = 1; page <= 6; page++) {
      const j = await get(`${API}/factsCenter/${CFG.LIVE_ENDPOINT}`
        + `?sportId=${encodeURIComponent(sport)}&marketId=1,10&pageSize=50&pageNum=${page}`
        + `&option=1&order=0&_t=${Date.now()}`);

      const evs = j?.data?.tournaments?.flatMap(t => (t.events || []).map(e => ({ e, league: t.name })))
        || (Array.isArray(j?.data) ? j.data.map(e => ({ e, league: e.sport?.tournament?.name || '' })) : []);
      if (!evs.length) break;

      for (const { e, league } of evs) {
        const [h, a] = scoreOf(e);
        const minute = clockOf(e);
        if (!Number.isFinite(h) || !Number.isFinite(a) || h === a) continue;
        if (!qualifies(minute, Math.abs(h - a), rule)) continue;

        const leader = h > a ? 'home' : 'away';
        const want = leader === 'home' ? 'Home' : 'Away';
        let leg = null;

        for (const mid of ['1', '10']) {
          const m = (e.markets || []).find(x => String(x.id) === mid && x.status === 0);
          if (!m) continue;
          for (const o of (m.outcomes || [])) {
            if (o.isActive === 0 || o.isActive === '0') continue;
            const odd = parseFloat(o.odds);
            if (odd < cfg.min || odd > cfg.max) continue;
            if (mid === '1' && o.desc !== want) continue;
            if (mid === '10' && o.desc !== (leader === 'home' ? '1X' : 'X2')) continue;
            leg = { m, o, odd, mid };
            break;
          }
          if (leg) break;
        }
        if (!leg) continue;

        out.push({
          id: e.eventId, ko: Date.now(), sport, league,
          home: e.homeTeamName, away: e.awayTeamName,
          marketId: leg.mid, specifier: leg.m.specifier || '',
          outcomeId: String(leg.o.id), odds: leg.odd,
          desc: `${want} ${leg.mid === '1' ? '1X2' : 'DC'} ${h}-${a} ${minute}'`,
          score: Math.abs(h - a) * 0.1 + minute / 100
        });
      }
      await sleep(200);
    }
  }

  return out.sort((x, y) => y.score - x.score).slice(0, cfg.legs * cfg.maxCodes * 3);
}

module.exports = { scanLive, qualifies, clockOf, scoreOf };

