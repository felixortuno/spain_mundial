"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLiveMatch,
  isLiveStatus,
  normalizeEvents,
  normalizeStatistics
} = require("../lib/liveMatches");

function fixture() {
  return {
    id: "99",
    commenceTime: "2026-06-11T19:00:00Z",
    home: { id: 1, name: "Spain" },
    away: { id: 2, name: "Cape Verde" },
    competition: { round: "Group Stage - 1" },
    features: {
      status: { short: "2H", long: "Second Half", elapsed: 67 },
      goals: { home: 2, away: 1 },
      score: { halftime: { home: 1, away: 1 } },
      venue: { name: "Test Stadium", city: "Madrid" },
      referee: "Test Referee"
    }
  };
}

test("reconoce solo estados realmente en juego", () => {
  assert.equal(isLiveStatus("1H"), true);
  assert.equal(isLiveStatus("HT"), true);
  assert.equal(isLiveStatus("P"), true);
  assert.equal(isLiveStatus("FT"), false);
  assert.equal(isLiveStatus("PEN"), false);
  assert.equal(isLiveStatus("NS"), false);
});

test("normaliza estadísticas por equipo y porcentajes", () => {
  const result = normalizeStatistics([
    {
      team: { id: 1 },
      statistics: [
        { type: "Ball Possession", value: "61%" },
        { type: "Shots on Goal", value: 5 },
        { type: "Total Shots", value: 11 },
        { type: "expected_goals", value: "1.72" }
      ]
    },
    {
      team: { id: 2 },
      statistics: [
        { type: "Ball Possession", value: "39%" },
        { type: "Shots on Goal", value: 2 }
      ]
    }
  ], fixture());

  assert.equal(result.home.possession, 61);
  assert.equal(result.home.expectedGoals, 1.72);
  assert.equal(result.away.shotsOnGoal, 2);
  assert.equal(result.away.totalShots, null);
});

test("ordena incidencias desde la más reciente", () => {
  const result = normalizeEvents([
    { time: { elapsed: 12 }, type: "Card", player: { name: "A" } },
    { time: { elapsed: 55, extra: 2 }, type: "Goal", player: { name: "B" } }
  ]);

  assert.equal(result[0].type, "Goal");
  assert.equal(result[0].elapsed, 55);
  assert.equal(result[0].extra, 2);
});

test("construye KPIs del partido en directo", () => {
  const match = buildLiveMatch(fixture(), [
    {
      team: { id: 1 },
      statistics: [
        { type: "Shots on Goal", value: 5 },
        { type: "Total Shots", value: 10 },
        { type: "Corner Kicks", value: 4 },
        { type: "expected_goals", value: "1.5" }
      ]
    },
    {
      team: { id: 2 },
      statistics: [
        { type: "Shots on Goal", value: 2 },
        { type: "Total Shots", value: 6 }
      ]
    }
  ]);

  assert.equal(match.home.goals, 2);
  assert.equal(match.insights.shotAccuracy.home, 50);
  assert.equal(match.insights.conversion.home, 40);
  assert.ok(match.insights.pressure.home > match.insights.pressure.away);
  assert.equal(match.insights.projectedShots90, 21.5);
});
