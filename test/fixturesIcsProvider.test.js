"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fixturesFromIcs,
  parseSummary
} = require("../lib/providers/fixturesIcsProvider");

test("interpreta partidos pendientes y resultados del feed ICS", () => {
  assert.deepEqual(parseSummary("Mexico - South Africa"), {
    home: "Mexico",
    away: "South Africa",
    homeGoals: null,
    awayGoals: null,
    played: false
  });
  assert.deepEqual(parseSummary("Mexico 2 - 1 South Africa"), {
    home: "Mexico",
    away: "South Africa",
    homeGoals: 2,
    awayGoals: 1,
    played: true
  });
});

test("normaliza eventos ICS al formato del agregador", () => {
  const fixtures = fixturesFromIcs([
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:match-1",
    "DTSTART:20260611T190000Z",
    "LOCATION:Estadio",
    "SUMMARY:Mexico 2 - 1 South Africa",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n"));

  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].features.status.short, "FT");
  assert.deepEqual(fixtures[0].features.goals, { home: 2, away: 1 });
});
