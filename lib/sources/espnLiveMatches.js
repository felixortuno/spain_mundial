"use strict";

const { emptyStats, matchInsights } = require("../liveMatches");

const DEFAULT_LEAGUE = "fifa.world";
const DEFAULT_USER_AGENT =
  "spain-mundial/1.0 (Mundial 2026 live fallback; +https://github.com/)";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function defaultDateWindow(now = new Date()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const middayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12
  );
  return [-1, 0, 1].map((offset) =>
    yyyymmdd(new Date(middayUtc + offset * dayMs))
  );
}

function parseDisplayClock(value) {
  const match = String(value || "").match(/(\d+)(?:'\+(\d+))?/);
  if (!match) return { elapsed: null, extra: null };
  return {
    elapsed: finiteNumber(match[1]),
    extra: finiteNumber(match[2])
  };
}

function statusFromEspn(status = {}) {
  const type = status.type || {};
  const name = String(type.name || "").toUpperCase();
  const description = type.description || type.detail || type.shortDetail || "";
  const clock = parseDisplayClock(status.displayClock || type.detail);
  const period = finiteNumber(status.period);

  let short = "LIVE";
  if (name.includes("HALF")) short = "HT";
  else if (name.includes("SUSP")) short = "SUSP";
  else if (name.includes("INTERRUPT") || name.includes("DELAY")) short = "INT";
  else if (name.includes("PENAL")) short = "P";
  else if (period != null && period <= 1) short = "1H";
  else if (period != null && period === 2) short = "2H";
  else if (period != null && period > 2) short = "ET";

  return {
    short,
    long: description || "En juego",
    elapsed: clock.elapsed
  };
}

function isLiveEvent(event) {
  const status = event.status || event.competitions?.[0]?.status || {};
  const type = status.type || {};
  const state = String(type.state || "").toLowerCase();
  const name = String(type.name || "").toUpperCase();

  if (type.completed) return false;
  return (
    state === "in" ||
    name.includes("IN_PROGRESS") ||
    name.includes("HALF") ||
    name.includes("PENAL") ||
    name.includes("EXTRA_TIME")
  );
}

function teamName(competitor) {
  return (
    competitor?.team?.displayName ||
    competitor?.team?.name ||
    competitor?.team?.shortDisplayName ||
    "TBD"
  );
}

function statValue(statistics, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const item = (statistics || []).find((stat) =>
    wanted.has(String(stat.name || stat.label || "").toLowerCase())
  );
  return finiteNumber(item?.value ?? item?.displayValue);
}

function normalizeEspnStats(statistics) {
  const stats = {
    ...emptyStats(),
    shotsOnGoal: statValue(statistics, ["shotsOnTarget", "shotsOnGoal"]),
    totalShots: statValue(statistics, ["totalShots"]),
    fouls: statValue(statistics, ["foulsCommitted", "fouls"]),
    corners: statValue(statistics, ["wonCorners", "cornerKicks"]),
    offsides: statValue(statistics, ["offsides"]),
    possession: statValue(statistics, ["possessionPct", "possession"]),
    yellowCards: statValue(statistics, ["yellowCards"]),
    redCards: statValue(statistics, ["redCards"]),
    goalkeeperSaves: statValue(statistics, ["saves", "goalkeeperSaves"]),
    totalPasses: statValue(statistics, ["totalPasses"]),
    passesAccurate: statValue(statistics, ["accuratePasses", "passesAccurate"]),
    passAccuracy: statValue(statistics, ["passPct", "passAccuracy"]),
    expectedGoals: statValue(statistics, ["expectedGoals", "xG"])
  };

  return stats;
}

function eventType(detail = {}) {
  const text = String(detail.type?.text || detail.type || "").toLowerCase();
  if (text.includes("goal")) {
    return {
      type: "Goal",
      detail: text.includes("own") ? "Own Goal" : "Normal Goal"
    };
  }
  if (text.includes("red") || detail.redCard) {
    return { type: "Card", detail: "Red Card" };
  }
  if (text.includes("yellow") || detail.yellowCard) {
    return { type: "Card", detail: "Yellow Card" };
  }
  if (text.includes("sub")) {
    return { type: "subst", detail: "Substitution" };
  }
  return { type: detail.type?.text || detail.type || "Action", detail: null };
}

function normalizeEspnEvents(details = [], teamsById = new Map()) {
  return details
    .map((detail, index) => {
      const clock = parseDisplayClock(detail.clock?.displayValue);
      const teamId = detail.team?.id != null ? String(detail.team.id) : null;
      const typed = eventType(detail);
      const athletes = detail.athletesInvolved || detail.participants || [];

      return {
        id: `${detail.id || ""}-${detail.sequenceNumber || ""}-${index}`,
        elapsed: clock.elapsed,
        extra: clock.extra,
        teamId,
        team: teamId ? teamsById.get(teamId) || null : null,
        player: athletes[0]?.displayName || athletes[0]?.athlete?.displayName || null,
        assist: athletes[1]?.displayName || athletes[1]?.athlete?.displayName || null,
        type: typed.type,
        detail: typed.detail,
        comments: detail.text || detail.shortText || null
      };
    })
    .filter((event) =>
      event.elapsed != null ||
      ["Goal", "Card", "subst"].includes(event.type)
    )
    .sort((a, b) =>
      (b.elapsed || 0) - (a.elapsed || 0) ||
      (b.extra || 0) - (a.extra || 0)
    );
}

function competitorsBySide(competition = {}) {
  const competitors = competition.competitors || [];
  return {
    home:
      competitors.find((competitor) => competitor.homeAway === "home") ||
      competitors[0],
    away:
      competitors.find((competitor) => competitor.homeAway === "away") ||
      competitors[1]
  };
}

function mergeSummary(event, summary = {}) {
  if (!summary || !summary.header) return event;
  const competition = event.competitions?.[0] || {};
  const headerCompetition = summary.header.competitions?.[0] || {};
  return {
    ...event,
    competitions: [
      {
        ...competition,
        ...headerCompetition,
        competitors: competition.competitors || headerCompetition.competitors,
        details:
          competition.details ||
          headerCompetition.details ||
          summary.keyEvents ||
          []
      }
    ],
    boxscore: summary.boxscore
  };
}

function statsFromSummaryBoxscore(boxscore, home, away) {
  const teams = boxscore?.teams || [];
  const bySide = new Map();
  for (const team of teams) {
    bySide.set(team.homeAway, team.statistics || []);
  }

  return {
    home: normalizeEspnStats(bySide.get("home") || home?.statistics || []),
    away: normalizeEspnStats(bySide.get("away") || away?.statistics || [])
  };
}

function buildEspnLiveMatch(event, { league = DEFAULT_LEAGUE } = {}) {
  const competition = event.competitions?.[0] || {};
  const { home, away } = competitorsBySide(competition);
  if (!home || !away) return null;

  const homeId = home.id != null ? String(home.id) : null;
  const awayId = away.id != null ? String(away.id) : null;
  const teamsById = new Map([
    [homeId, teamName(home)],
    [awayId, teamName(away)]
  ]);
  const statistics = statsFromSummaryBoxscore(event.boxscore, home, away);
  const status = statusFromEspn(competition.status || event.status || {});
  const fixture = {
    features: {
      goals: {
        home: finiteNumber(home.score),
        away: finiteNumber(away.score)
      },
      status
    }
  };

  return {
    id: String(event.id || competition.id || ""),
    source: "espn",
    start: event.date || competition.date || competition.startDate || null,
    competition: {
      id: event.league?.id || null,
      name: event.league?.name || "FIFA World Cup",
      country: null,
      season: event.season?.year || null,
      round: competition.altGameNote || event.season?.slug || league
    },
    status,
    venue: competition.venue
      ? {
          name: competition.venue.fullName || competition.venue.name || null,
          city: competition.venue.address?.city || null
        }
      : null,
    referee: null,
    score: null,
    home: {
      id: homeId,
      name: teamName(home),
      goals: finiteNumber(home.score)
    },
    away: {
      id: awayId,
      name: teamName(away),
      goals: finiteNumber(away.score)
    },
    statistics,
    insights: matchInsights(statistics, fixture),
    events: normalizeEspnEvents(competition.details || [], teamsById)
  };
}

async function fetchJson(url, { fetchImpl, userAgent }) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent
    }
  });
  if (!response.ok) {
    const error = new Error(`ESPN ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchEspnLiveMatches({
  league = process.env.ESPN_WORLDCUP_LEAGUE || DEFAULT_LEAGUE,
  dates = defaultDateWindow(),
  userAgent = process.env.ESPN_USER_AGENT || DEFAULT_USER_AGENT,
  fetchImpl = fetch,
  maxMatches = 6
} = {}) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}`;
  const scoreboards = await Promise.all(
    dates.map((date) =>
      fetchJson(`${base}/scoreboard?dates=${date}`, { fetchImpl, userAgent })
        .catch(() => ({ events: [] }))
    )
  );
  const liveEvents = scoreboards
    .flatMap((scoreboard) => scoreboard.events || [])
    .filter(isLiveEvent)
    .slice(0, maxMatches);

  const enriched = await Promise.all(
    liveEvents.map(async (event) => {
      try {
        const summary = await fetchJson(
          `${base}/summary?event=${encodeURIComponent(event.id)}`,
          { fetchImpl, userAgent }
        );
        return mergeSummary(event, summary);
      } catch {
        return event;
      }
    })
  );

  return {
    generated_at: new Date().toISOString(),
    active: enriched.length > 0,
    source: "espn",
    matches: enriched
      .map((event) => buildEspnLiveMatch(event, { league }))
      .filter(Boolean)
  };
}

module.exports = {
  buildEspnLiveMatch,
  defaultDateWindow,
  fetchEspnLiveMatches,
  isLiveEvent,
  normalizeEspnEvents,
  normalizeEspnStats,
  parseDisplayClock,
  statusFromEspn
};
