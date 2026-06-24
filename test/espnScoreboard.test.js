"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseEspnScoreboard,
  fetchEspnMatchesForDates,
} = require("../lib/sources/espnScoreboard");

const SCOREBOARD = {
  events: [
    {
      date: "2026-06-24T19:00Z",
      competitions: [{
        status: { type: { completed: true, name: "STATUS_FULL_TIME" } },
        competitors: [
          { homeAway: "home", team: { displayName: "Spain" }, score: "3" },
          { homeAway: "away", team: { displayName: "Morocco" }, score: "1" },
        ],
      }],
    },
    {
      // No finalizado → se ignora
      date: "2026-06-24T22:00Z",
      competitions: [{
        status: { type: { completed: false, name: "STATUS_IN_PROGRESS" } },
        competitors: [
          { homeAway: "home", team: { displayName: "Brazil" }, score: "0" },
          { homeAway: "away", team: { displayName: "Argentina" }, score: "0" },
        ],
      }],
    },
  ],
};

test("parseEspnScoreboard solo devuelve eventos completados", () => {
  const matches = parseEspnScoreboard(SCOREBOARD);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].team1, "Spain");
  assert.equal(matches[0].team2, "Morocco");
  assert.deepEqual(matches[0].score, { home: 3, away: 1 });
  assert.equal(matches[0].status, "FT");
  assert.equal(matches[0].date, "2026-06-24");
});

test("fetchEspnMatchesForDates consulta cada fecha con fetch inyectado", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => SCOREBOARD };
  };
  const { matches, source } = await fetchEspnMatchesForDates(
    ["2026-06-24"],
    { fetchImpl: fakeFetch, league: "fifa.world" }
  );
  assert.equal(matches.length, 1);
  assert.ok(calls[0].includes("dates=20260624"));
  assert.ok(calls[0].includes("fifa.world"));
  assert.equal(source.name, "ESPN");
});
