'use strict';
/**
 * Team and League Matching Utility
 * Bridges SportyBet naming conventions with 5DollarFootballAPI records.
 */

const LEAGUE_MAPPINGS = [
  {
    id: 4160026622,
    name: 'England Premier League',
    aliases: ['premier league', 'england premier league', 'epl', 'english premier league']
  },
  {
    id: 4212821298,
    name: 'Spain La Liga',
    aliases: ['la liga', 'laliga', 'spain primera division', 'primera division', 'spain la liga']
  },
  {
    id: 3405541143,
    name: 'Italy Serie A',
    aliases: ['serie a', 'italy serie a', 'italian serie a']
  },
  {
    id: 686337048,
    name: 'Germany Bundesliga I',
    aliases: ['bundesliga', 'germany bundesliga', 'bundesliga i', 'german bundesliga']
  },
  {
    id: 3614399544,
    name: 'France Ligue 1',
    aliases: ['ligue 1', 'france ligue 1', 'french ligue 1']
  }
];

const TEAM_ALIASES = {
  // English Premier League
  'manchester city': ['man city', 'mancity', 'manchester city fc'],
  'manchester united': ['man united', 'man utd', 'manutd', 'manchester utd', 'manchester united fc'],
  'tottenham hotspur': ['tottenham', 'spurs', 'tottenham hotspur fc'],
  'wolverhampton wanderers': ['wolves', 'wolverhampton'],
  'brighton & hove albion': ['brighton', 'brighton hove'],
  'nottingham forest': ['nottm forest', 'nottingham', 'nott\'m forest'],
  'west ham united': ['west ham', 'west ham utd'],
  'newcastle united': ['newcastle', 'newcastle utd'],
  'leicester city': ['leicester'],
  'ipswich town': ['ipswich'],
  'luton town': ['luton'],

  // Spanish La Liga
  'atletico madrid': ['atletico', 'atleti', 'club atletico de madrid', 'atl. madrid'],
  'athletic bilbao': ['athletic club', 'bilbao', 'ath bilbao'],
  'real betis': ['betis', 'real betis balompie'],
  'real sociedad': ['sociedad', 'r. sociedad'],
  'celta vigo': ['celta', 'rc celta de vigo', 'celta de vigo'],
  'rayo vallecano': ['rayo'],
  'espanyol': ['rcd espanyol', 'espanyol barcelona'],

  // Italian Serie A
  'inter milan': ['inter', 'internazionale', 'fc internazionale milano'],
  'ac milan': ['milan', 'a.c. milan'],
  'juventus': ['juve', 'juventus fc'],
  'as roma': ['roma'],
  'atalanta bc': ['atalanta'],
  'hellas verona': ['verona'],

  // German Bundesliga
  'bayer leverkusen': ['leverkusen', 'bayer 04 leverkusen'],
  'bayern munich': ['bayern', 'fc bayern munchen', 'bayern munchen'],
  'borussia dortmund': ['dortmund', 'bvb'],
  'rb leipzig': ['leipzig', 'rasenballsport leipzig'],
  'eintracht frankfurt': ['frankfurt', 'eintracht'],
  'vfb stuttgart': ['stuttgart'],
  'borussia monchengladbach': ['monchengladbach', 'm\'gladbach', 'gladbach'],
  'sc freiburg': ['freiburg'],
  'vfl wolfsburg': ['wolfsburg'],
  'werder bremen': ['bremen'],

  // French Ligue 1
  'paris saint-germain': ['psg', 'paris sg', 'paris saint germain'],
  'olympique marseille': ['marseille', 'om'],
  'olympique lyonnais': ['lyon', 'ol'],
  'as monaco': ['monaco'],
  'stade rennais': ['rennes'],
  'ogc nice': ['nice'],
  'lille osc': ['lille']
};

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(fc|afc|cf)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a SportyBet tournament name to a 5DollarFootballAPI league ID
 * @param {string} sportyLeagueName 
 * @returns {number|null} 5DollarFootballAPI leagueId
 */
function matchLeague(sportyLeagueName) {
  if (!sportyLeagueName) return null;
  const norm = normalizeName(sportyLeagueName);

  // Exclude non-European leagues or youth leagues that might share tokens like "Serie A" (e.g. Brazil Serie A)
  const nonTarget = ['brazil', 'ecuador', 'colombia', 'argentina', 'chile', 'mexico', 'japan', 'korea', 'usa', 'australia', 'women', 'u21', 'u20', 'u19', 'u23'];
  if (nonTarget.some(token => norm.includes(token))) {
    return null;
  }

  for (const item of LEAGUE_MAPPINGS) {
    if (norm.includes(normalizeName(item.name))) return item.id;
    for (const a of item.aliases) {
      if (norm.includes(a)) return item.id;
    }
  }
  return null;
}

/**
 * Match a SportyBet team name against a 5DollarFootballAPI standings table
 * @param {string} sportyTeamName 
 * @param {Array<Object>} standingsTable - Array of table entries with { team: { id, name }, ... }
 * @returns {Object|null} Matching table entry
 */
function matchTeamInStandings(sportyTeamName, standingsTable) {
  if (!sportyTeamName || !Array.isArray(standingsTable)) return null;

  const target = normalizeName(sportyTeamName);

  // 1. Direct match on normalized name
  for (const entry of standingsTable) {
    const apiName = normalizeName(entry.team?.name);
    if (apiName === target) return entry;
  }

  // 2. Substring or token containment
  for (const entry of standingsTable) {
    const apiName = normalizeName(entry.team?.name);
    if (apiName && (apiName.includes(target) || target.includes(apiName))) {
      return entry;
    }
  }

  // 3. Known aliases dictionary
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const normCanonical = normalizeName(canonical);
    const matchesTarget = target === normCanonical || aliases.some(a => target === normalizeName(a));

    if (matchesTarget) {
      for (const entry of standingsTable) {
        const apiName = normalizeName(entry.team?.name);
        if (apiName === normCanonical || aliases.some(a => apiName === normalizeName(a))) {
          return entry;
        }
      }
    }
  }

  return null;
}

module.exports = {
  LEAGUE_MAPPINGS,
  TEAM_ALIASES,
  normalizeName,
  normalizeTeamName: normalizeName,
  matchLeague,
  matchTeamInStandings
};
