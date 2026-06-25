"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateFixtures,
  bestGoalkeeper,
  playerLeader
} = require("../lib/tournamentStats");

function fixture(id, date, home, away, homeGoals, awayGoals, status = "FT") {
  return {
    id: String(id),
    commenceTime: date,
    home: { name: home },
    away: { name: away },
    features: {
      status: { short: status },
      goals: { home: homeGoals, away: awayGoals }
    }
  };
}

test("mantiene los líderes vacíos antes del primer partido", () => {
  const result = aggregateFixtures([
    fixture(1, "2026-06-12T18:00:00Z", "España", "Marruecos", null, null, "NS")
  ], {
    today: "2026-06-11",
    expectedTotalFixtures: 104,
    now: new Date("2026-06-11T10:00:00Z")
  });

  assert.equal(result.summary.totalFixtures, 104);
  assert.equal(result.summary.publishedFixtures, 1);
  assert.equal(result.summary.playedMatches, 0);
  assert.equal(result.summary.totalGoals, 0);
  assert.equal(result.summary.averageGoals, null);
  assert.equal(result.leaders.teamGoalsPerGame, null);
  assert.equal(result.leaders.bestMatchToday, null);
  assert.equal(result.leaders.nextMatch.match, "España vs Marruecos");
});

test("calcula rankings de equipos y partidos con resultados", () => {
  const result = aggregateFixtures([
    fixture(1, "2026-06-11T12:00:00Z", "España", "Marruecos", 3, 1),
    fixture(2, "2026-06-11T18:00:00Z", "Francia", "Bélgica", 2, 2),
    fixture(3, "2026-06-12T18:00:00Z", "España", "Alemania", 1, 0)
  ], { today: "2026-06-11", timeZone: "Europe/Madrid" });

  assert.equal(result.summary.playedMatches, 3);
  assert.equal(result.summary.totalGoals, 9);
  assert.equal(result.summary.averageGoals, 3);
  assert.equal(result.leaders.teamGoalsPerGame.name, "España");
  assert.equal(result.leaders.bestAttack.name, "España");
  assert.equal(result.leaders.bestDefense.name, "España");
  assert.equal(result.leaders.cleanSheetLeader.name, "España");
  assert.equal(result.leaders.mostWins.name, "España");
  assert.equal(result.leaders.latestResult.match, "España vs Alemania");
  assert.equal(result.leaders.bestMatchToday.match, "Francia vs Bélgica");
  assert.equal(result.leaders.biggestWin.match, "España vs Marruecos");
  assert.deepEqual(result.todayFixtureIds, ["1", "2"]);
});

test("extrae goleador, asistente y mejor portero", () => {
  const players = [{
    player: { id: 7, name: "Delantero" },
    statistics: [{
      team: { name: "España" },
      games: { appearences: 3 },
      goals: { total: 4, assists: 2 }
    }]
  }];
  const keepers = [[{
    team: { name: "España" },
    players: [{
      player: { id: 1, name: "Portero A" },
      statistics: [{
        games: { position: "G", minutes: 90, rating: "8.1" },
        goals: { saves: 5, conceded: 0 }
      }]
    }]
  }, {
    team: { name: "Marruecos" },
    players: [{
      player: { id: 2, name: "Portero B" },
      statistics: [{
        games: { position: "G", minutes: 90, rating: "7.4" },
        goals: { saves: 7, conceded: 2 }
      }]
    }]
  }]];

  assert.equal(playerLeader(players, "goals").value, 4);
  assert.equal(playerLeader(players, "assists").value, 2);
  assert.equal(bestGoalkeeper(keepers).name, "Portero A");
  assert.equal(bestGoalkeeper(keepers).cleanSheets, 1);
});
