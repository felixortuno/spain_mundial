"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEspnLiveMatch,
  fetchEspnLiveMatches,
  isLiveEvent,
  normalizeEspnStats,
  parseDisplayClock,
  statusFromEspn
} = require("../lib/sources/espnLiveMatches");

function liveEvent() {
  return {
    id: "760999",
    date: "2026-06-25T20:00Z",
    season: { year: 2026, slug: "group-stage" },
    competitions: [{
      id: "760999",
      altGameNote: "FIFA World Cup, Group E",
      status: {
        displayClock: "67'",
        period: 2,
        type: {
          name: "STATUS_IN_PROGRESS",
          state: "in",
          completed: false,
          description: "In Progress"
        }
      },
      venue: {
        fullName: "Test Stadium",
        address: { city: "Madrid" }
      },
      competitors: [
        {
          id: "1",
          homeAway: "home",
          score: "2",
          team: { displayName: "Spain" },
          statistics: [
            { name: "possessionPct", displayValue: "61.2" },
            { name: "shotsOnTarget", displayValue: "5" },
            { name: "totalShots", displayValue: "11" },
            { name: "wonCorners", displayValue: "4" }
          ]
        },
        {
          id: "2",
          homeAway: "away",
          score: "1",
          team: { displayName: "Cape Verde" },
          statistics: [
            { name: "possessionPct", displayValue: "38.8" },
            { name: "shotsOnTarget", displayValue: "2" },
            { name: "totalShots", displayValue: "6" }
          ]
        }
      ],
      details: [
        {
          type: { text: "Goal" },
          clock: { displayValue: "55'" },
          team: { id: "1" },
          athletesInvolved: [{ displayName: "Player One" }]
        },
        {
          type: { text: "Yellow Card" },
          clock: { displayValue: "62'" },
          team: { id: "2" },
          athletesInvolved: [{ displayName: "Player Two" }]
        }
      ]
    }]
  };
}

test("parsea relojes ESPN con añadido", () => {
  assert.deepEqual(parseDisplayClock("90'+6'"), { elapsed: 90, extra: 6 });
  assert.deepEqual(parseDisplayClock("67'"), { elapsed: 67, extra: null });
});

test("detecta y traduce estados ESPN en directo", () => {
  const event = liveEvent();
  assert.equal(isLiveEvent(event), true);
  assert.deepEqual(
    statusFromEspn(event.competitions[0].status),
    { short: "2H", long: "In Progress", elapsed: 67 }
  );
});

test("normaliza estadísticas ESPN a las métricas del directo", () => {
  const stats = normalizeEspnStats([
    { name: "possessionPct", displayValue: "54.4" },
    { name: "shotsOnTarget", displayValue: "5" },
    { name: "totalShots", displayValue: "14" },
    { name: "wonCorners", displayValue: "5" },
    { name: "saves", displayValue: "2" }
  ]);

  assert.equal(stats.possession, 54.4);
  assert.equal(stats.shotsOnGoal, 5);
  assert.equal(stats.totalShots, 14);
  assert.equal(stats.corners, 5);
  assert.equal(stats.goalkeeperSaves, 2);
});

test("construye un partido en directo desde ESPN", () => {
  const match = buildEspnLiveMatch(liveEvent());

  assert.equal(match.source, "espn");
  assert.equal(match.home.name, "Spain");
  assert.equal(match.home.goals, 2);
  assert.equal(match.away.goals, 1);
  assert.equal(match.status.short, "2H");
  assert.equal(match.venue.name, "Test Stadium");
  assert.equal(match.statistics.home.possession, 61.2);
  assert.equal(match.events[0].type, "Card");
  assert.equal(match.events[1].type, "Goal");
  assert.ok(match.insights.pressure.home > match.insights.pressure.away);
});

test("fetchEspnLiveMatches consulta marcador y detalle solo para eventos live", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes("/summary?event=760999")) {
      return {
        ok: true,
        json: async () => ({})
      };
    }
    return {
      ok: true,
      json: async () => ({
        events: [
          liveEvent(),
          {
            id: "finished",
            status: { type: { state: "post", completed: true } },
            competitions: []
          }
        ]
      })
    };
  };

  const data = await fetchEspnLiveMatches({
    dates: ["20260625"],
    fetchImpl: fakeFetch
  });

  assert.equal(data.source, "espn");
  assert.equal(data.active, true);
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].id, "760999");
  assert.equal(calls.filter((url) => url.includes("/scoreboard")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/summary")).length, 1);
});
