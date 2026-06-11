"use strict";

const LIVE_STATUSES = new Set([
  "1H",
  "HT",
  "2H",
  "ET",
  "BT",
  "P",
  "SUSP",
  "INT",
  "LIVE"
]);

const STAT_KEYS = new Map([
  ["shots on goal", "shotsOnGoal"],
  ["shots off goal", "shotsOffGoal"],
  ["total shots", "totalShots"],
  ["blocked shots", "blockedShots"],
  ["shots insidebox", "shotsInsideBox"],
  ["shots outsidebox", "shotsOutsideBox"],
  ["fouls", "fouls"],
  ["corner kicks", "corners"],
  ["offsides", "offsides"],
  ["ball possession", "possession"],
  ["yellow cards", "yellowCards"],
  ["red cards", "redCards"],
  ["goalkeeper saves", "goalkeeperSaves"],
  ["total passes", "totalPasses"],
  ["passes accurate", "passesAccurate"],
  ["passes %", "passAccuracy"],
  ["expected_goals", "expectedGoals"],
  ["goals prevented", "goalsPrevented"]
]);

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function isLiveStatus(status) {
  return LIVE_STATUSES.has(String(status || "").toUpperCase());
}

function emptyStats() {
  return {
    shotsOnGoal: null,
    shotsOffGoal: null,
    totalShots: null,
    blockedShots: null,
    shotsInsideBox: null,
    shotsOutsideBox: null,
    fouls: null,
    corners: null,
    offsides: null,
    possession: null,
    yellowCards: null,
    redCards: null,
    goalkeeperSaves: null,
    totalPasses: null,
    passesAccurate: null,
    passAccuracy: null,
    expectedGoals: null,
    goalsPrevented: null
  };
}

function normalizeStatistics(payload, fixture) {
  const byTeamId = new Map();

  for (const teamBlock of payload || []) {
    const stats = emptyStats();
    for (const item of teamBlock.statistics || []) {
      const key = STAT_KEYS.get(String(item.type || "").toLowerCase());
      if (key) stats[key] = finiteNumber(item.value);
    }
    byTeamId.set(teamBlock.team?.id, stats);
  }

  return {
    home: byTeamId.get(fixture.home.id) || emptyStats(),
    away: byTeamId.get(fixture.away.id) || emptyStats()
  };
}

function normalizeEvents(payload) {
  return (payload || [])
    .map((event, index) => ({
      id: [
        event.time?.elapsed ?? "",
        event.time?.extra ?? "",
        event.team?.id ?? "",
        event.player?.id ?? "",
        event.type || "",
        index
      ].join("-"),
      elapsed: finiteNumber(event.time?.elapsed),
      extra: finiteNumber(event.time?.extra),
      teamId: event.team?.id ?? null,
      team: event.team?.name || null,
      player: event.player?.name || null,
      assist: event.assist?.name || null,
      type: event.type || null,
      detail: event.detail || null,
      comments: event.comments || null
    }))
    .sort((a, b) =>
      (b.elapsed || 0) - (a.elapsed || 0) ||
      (b.extra || 0) - (a.extra || 0)
    );
}

function zero(value) {
  return Number.isFinite(value) ? value : 0;
}

function pressureIndex(stats) {
  return Number((
    zero(stats.shotsOnGoal) * 3 +
    zero(stats.totalShots) +
    zero(stats.corners) * 0.75 +
    zero(stats.expectedGoals) * 4
  ).toFixed(1));
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function matchInsights(stats, fixture) {
  const homePressure = pressureIndex(stats.home);
  const awayPressure = pressureIndex(stats.away);
  const elapsed = zero(fixture.features?.status?.elapsed);
  const totalShots = zero(stats.home.totalShots) + zero(stats.away.totalShots);

  return {
    pressure: {
      home: homePressure,
      away: awayPressure
    },
    shotAccuracy: {
      home: percentage(stats.home.shotsOnGoal, stats.home.totalShots),
      away: percentage(stats.away.shotsOnGoal, stats.away.totalShots)
    },
    conversion: {
      home: percentage(fixture.features?.goals?.home, stats.home.shotsOnGoal),
      away: percentage(fixture.features?.goals?.away, stats.away.shotsOnGoal)
    },
    projectedShots90: elapsed > 0
      ? Number(((totalShots / elapsed) * 90).toFixed(1))
      : null,
    cards: {
      home: zero(stats.home.yellowCards) + zero(stats.home.redCards),
      away: zero(stats.away.yellowCards) + zero(stats.away.redCards)
    }
  };
}

function buildLiveMatch(fixture, statisticsPayload = [], eventsPayload = []) {
  const statistics = normalizeStatistics(statisticsPayload, fixture);
  return {
    id: fixture.id,
    start: fixture.commenceTime,
    competition: fixture.competition,
    status: fixture.features?.status || {},
    venue: fixture.features?.venue || null,
    referee: fixture.features?.referee || null,
    score: fixture.features?.score || null,
    home: {
      ...fixture.home,
      goals: fixture.features?.goals?.home ?? null
    },
    away: {
      ...fixture.away,
      goals: fixture.features?.goals?.away ?? null
    },
    statistics,
    insights: matchInsights(statistics, fixture),
    events: normalizeEvents(eventsPayload)
  };
}

module.exports = {
  LIVE_STATUSES,
  buildLiveMatch,
  emptyStats,
  finiteNumber,
  isLiveStatus,
  matchInsights,
  normalizeEvents,
  normalizeStatistics,
  pressureIndex
};
