"use strict";

const UNPLAYED_STATUSES = new Set(["NS", "TBD", "PST", "CANC", "ABD"]);

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localDate(value, timeZone = "Europe/Madrid") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function scoreForFixture(fixture) {
  const home = finiteNumber(fixture.features?.goals?.home);
  const away = finiteNumber(fixture.features?.goals?.away);
  const status = fixture.features?.status?.short || "";
  if (home == null || away == null || UNPLAYED_STATUSES.has(status)) return null;
  return { home, away, status };
}

function teamRow(map, team) {
  if (!map.has(team)) {
    map.set(team, {
      name: team,
      games: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      cleanSheets: 0
    });
  }
  return map.get(team);
}

function rankRows(rows, compare) {
  return [...rows].sort((left, right) => compare(left, right) || left.name.localeCompare(right.name));
}

function matchSummary(fixture, score) {
  return {
    fixtureId: fixture.id,
    match: `${fixture.home.name} vs ${fixture.away.name}`,
    home: fixture.home.name,
    away: fixture.away.name,
    score: `${score.home}-${score.away}`,
    totalGoals: score.home + score.away,
    status: score.status,
    date: fixture.commenceTime
  };
}

function fixtureSummary(fixture) {
  return {
    fixtureId: fixture.id,
    match: `${fixture.home.name} vs ${fixture.away.name}`,
    home: fixture.home.name,
    away: fixture.away.name,
    status: fixture.features?.status?.short || "",
    date: fixture.commenceTime
  };
}

function scoreMargin(match) {
  const [home, away] = match.score.split("-").map(Number);
  return Math.abs(home - away);
}

function aggregateFixtures(fixtures, {
  today = localDate(new Date()),
  timeZone = "Europe/Madrid",
  expectedTotalFixtures = null,
  now = new Date()
} = {}) {
  const teams = new Map();
  const played = [];
  const todayPlayed = [];
  const scheduled = [];
  const todayScheduled = [];
  const nowTime = Date.parse(now);

  for (const fixture of fixtures || []) {
    const score = scoreForFixture(fixture);
    if (!score) {
      const start = Date.parse(fixture.commenceTime);
      if (Number.isFinite(start)) {
        const summary = fixtureSummary(fixture);
        scheduled.push(summary);
        if (localDate(fixture.commenceTime, timeZone) === today) {
          todayScheduled.push(summary);
        }
      }
      continue;
    }

    const home = teamRow(teams, fixture.home.name);
    const away = teamRow(teams, fixture.away.name);
    home.games += 1;
    away.games += 1;
    home.goalsFor += score.home;
    home.goalsAgainst += score.away;
    away.goalsFor += score.away;
    away.goalsAgainst += score.home;
    if (score.away === 0) home.cleanSheets += 1;
    if (score.home === 0) away.cleanSheets += 1;

    if (score.home > score.away) {
      home.wins += 1;
      away.losses += 1;
    } else if (score.away > score.home) {
      away.wins += 1;
      home.losses += 1;
    } else {
      home.draws += 1;
      away.draws += 1;
    }

    const summary = matchSummary(fixture, score);
    played.push(summary);
    if (localDate(fixture.commenceTime, timeZone) === today) todayPlayed.push(summary);
  }

  const rows = [...teams.values()].map((row) => ({
    ...row,
    goalsPerGame: row.games ? row.goalsFor / row.games : 0,
    concededPerGame: row.games ? row.goalsAgainst / row.games : 0
  }));
  const totalGoals = played.reduce((sum, match) => sum + match.totalGoals, 0);
  const draws = rows.reduce((sum, row) => sum + row.draws, 0) / 2;

  const teamGoalsPerGame = rankRows(rows, (a, b) =>
    b.goalsPerGame - a.goalsPerGame ||
    b.goalsFor - a.goalsFor ||
    b.games - a.games
  )[0] || null;
  const bestAttack = rankRows(rows, (a, b) =>
    b.goalsFor - a.goalsFor || b.goalsPerGame - a.goalsPerGame
  )[0] || null;
  const bestDefense = rankRows(rows, (a, b) =>
    a.concededPerGame - b.concededPerGame ||
    b.cleanSheets - a.cleanSheets ||
    b.games - a.games
  )[0] || null;
  const cleanSheetLeader = rankRows(
    rows.filter((row) => row.cleanSheets > 0),
    (a, b) =>
      b.cleanSheets - a.cleanSheets ||
      a.concededPerGame - b.concededPerGame ||
      b.games - a.games
  )[0] || null;
  const mostWins = rankRows(
    rows.filter((row) => row.wins > 0),
    (a, b) =>
      b.wins - a.wins ||
      b.goalsFor - a.goalsFor ||
      a.goalsAgainst - b.goalsAgainst
  )[0] || null;

  const highestScoringMatch = [...played].sort((a, b) =>
    b.totalGoals - a.totalGoals ||
    scoreMargin(a) - scoreMargin(b)
  )[0] || null;
  const bestMatchToday = [...todayPlayed].sort((a, b) =>
    b.totalGoals - a.totalGoals ||
    scoreMargin(a) - scoreMargin(b)
  )[0] || null;
  const biggestWin = [...played]
    .filter((match) => {
      const [home, away] = match.score.split("-").map(Number);
      return home !== away;
    })
    .sort((a, b) => {
      return scoreMargin(b) - scoreMargin(a) ||
        b.totalGoals - a.totalGoals;
    })[0] || null;
  const latestResult = [...played].sort((a, b) =>
    Date.parse(b.date || 0) - Date.parse(a.date || 0)
  )[0] || null;
  const nextMatchToday = [...todayScheduled]
    .filter((match) => !Number.isFinite(nowTime) || Date.parse(match.date || 0) >= nowTime)
    .sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0))[0] || null;
  const nextMatch = [...scheduled]
    .filter((match) => !Number.isFinite(nowTime) || Date.parse(match.date || 0) >= nowTime)
    .sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0))[0] || null;

  return {
    summary: {
      totalFixtures: Math.max(
        (fixtures || []).length,
        Number(expectedTotalFixtures) || 0
      ),
      publishedFixtures: (fixtures || []).length,
      playedMatches: played.length,
      totalGoals,
      averageGoals: played.length ? totalGoals / played.length : null,
      draws,
      teamsWithCleanSheets: rows.filter((row) => row.cleanSheets > 0).length,
      goalsToday: todayPlayed.reduce((sum, match) => sum + match.totalGoals, 0)
    },
    leaders: {
      teamGoalsPerGame,
      bestAttack,
      bestDefense,
      cleanSheetLeader,
      mostWins,
      highestScoringMatch,
      bestMatchToday,
      latestResult,
      nextMatchToday,
      nextMatch,
      biggestWin
    },
    todayFixtureIds: (fixtures || [])
      .filter((fixture) =>
        scoreForFixture(fixture) &&
        localDate(fixture.commenceTime, timeZone) === today
      )
      .map((fixture) => fixture.id)
  };
}

function playerLeader(items, metric) {
  for (const item of items || []) {
    for (const statistics of item.statistics || []) {
      const value = finiteNumber(
        metric === "assists" ? statistics.goals?.assists : statistics.goals?.total
      );
      if (value != null && value > 0) {
        return {
          id: item.player?.id ?? null,
          name: item.player?.name || "—",
          team: statistics.team?.name || "—",
          value,
          appearances: finiteNumber(statistics.games?.appearences) || 0
        };
      }
    }
  }
  return null;
}

function bestGoalkeeper(fixturePlayerResponses) {
  const keepers = new Map();

  for (const response of fixturePlayerResponses || []) {
    for (const teamBlock of response || []) {
      for (const item of teamBlock.players || []) {
        for (const statistics of item.statistics || []) {
          const position = String(statistics.games?.position || "").toLowerCase();
          const minutes = finiteNumber(statistics.games?.minutes) || 0;
          if (!["g", "goalkeeper"].includes(position) || minutes <= 0) continue;

          const key = item.player?.id ?? `${item.player?.name}:${teamBlock.team?.name}`;
          if (!keepers.has(key)) {
            keepers.set(key, {
              id: item.player?.id ?? null,
              name: item.player?.name || "—",
              team: teamBlock.team?.name || statistics.team?.name || "—",
              appearances: 0,
              saves: 0,
              conceded: 0,
              cleanSheets: 0,
              ratingTotal: 0,
              ratingCount: 0
            });
          }

          const keeper = keepers.get(key);
          const saves = finiteNumber(statistics.goals?.saves) || 0;
          const conceded = finiteNumber(statistics.goals?.conceded) || 0;
          const rating = finiteNumber(statistics.games?.rating);
          keeper.appearances += 1;
          keeper.saves += saves;
          keeper.conceded += conceded;
          keeper.cleanSheets += conceded === 0 ? 1 : 0;
          if (rating != null) {
            keeper.ratingTotal += rating;
            keeper.ratingCount += 1;
          }
        }
      }
    }
  }

  return [...keepers.values()]
    .map((keeper) => ({
      ...keeper,
      rating: keeper.ratingCount ? keeper.ratingTotal / keeper.ratingCount : null
    }))
    .sort((a, b) =>
      (b.rating || 0) - (a.rating || 0) ||
      b.saves - a.saves ||
      b.cleanSheets - a.cleanSheets ||
      a.conceded - b.conceded
    )[0] || null;
}

module.exports = {
  aggregateFixtures,
  bestGoalkeeper,
  localDate,
  playerLeader,
  scoreForFixture
};
