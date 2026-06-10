"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTeamName,
  reconcileMatches,
  similarity
} = require("../lib/reconciler");

function fixture(id, home, away, commenceTime) {
  return {
    id,
    commenceTime,
    home: { name: home },
    away: { name: away }
  };
}

function odds(id, homeTeam, awayTeam, commenceTime) {
  return { id, homeTeam, awayTeam, commenceTime };
}

test("normaliza acentos y alias conocidos", () => {
  assert.equal(
    normalizeTeamName("España").canonical,
    normalizeTeamName("Spain").canonical
  );
  assert.equal(
    normalizeTeamName("Arabia Saudí").canonical,
    normalizeTeamName("Saudi Arabia").canonical
  );
  assert.equal(
    normalizeTeamName("Corea del Sur").canonical,
    normalizeTeamName("Korea Republic").canonical
  );
});

test("reconcilia por alias dentro de una ventana de 90 minutos", () => {
  const result = reconcileMatches(
    [fixture("f1", "Arabia Saudita", "España", "2026-06-15T18:00:00Z")],
    [odds("o1", "Saudi Arabia", "Espana", "2026-06-15T19:15:00Z")],
    { logger: { warn() {} } }
  );

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reconciliation.method, "alias");
  assert.equal(result.matches[0].reconciliation.orientation, "same");
  assert.equal(result.matches[0].reconciliation.timeDeltaMinutes, 75);
});

test("reconcilia una orientación local visitante invertida en sede neutral", () => {
  const result = reconcileMatches(
    [fixture("f1", "Uruguay", "España", "2026-06-27T00:00:00Z")],
    [odds("o1", "Spain", "Uruguay", "2026-06-27T00:30:00Z")],
    { logger: { warn() {} } }
  );

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reconciliation.method, "alias");
  assert.equal(result.matches[0].reconciliation.orientation, "swapped");
});

test("permite desactivar el matching con orientación invertida", () => {
  const result = reconcileMatches(
    [fixture("f1", "Uruguay", "Spain", "2026-06-27T00:00:00Z")],
    [odds("o1", "Spain", "Uruguay", "2026-06-27T00:00:00Z")],
    { allowSwapped: false, logger: { warn() {} } }
  );

  assert.equal(result.matches.length, 0);
});

test("prioriza exact sobre alias y fuzzy entre candidatos válidos", () => {
  const result = reconcileMatches(
    [fixture("f1", "Spain", "Cape Verde", "2026-06-15T16:00:00Z")],
    [
      odds("alias", "España", "Cabo Verde", "2026-06-15T16:00:00Z"),
      odds("exact", "Spain", "Cape Verde", "2026-06-15T16:30:00Z")
    ],
    { logger: { warn() {} } }
  );

  assert.equal(result.matches[0].odds.id, "exact");
  assert.equal(result.matches[0].reconciliation.method, "exact");
});

test("no casa partidos fuera de la ventana y conserva ambos unmatched", () => {
  const result = reconcileMatches(
    [fixture("f1", "Spain", "USA", "2026-06-15T18:00:00Z")],
    [odds("o1", "Spain", "United States", "2026-06-15T20:00:00Z")],
    { logger: { warn() {} } }
  );

  assert.equal(result.matches.length, 0);
  assert.equal(result.unmatched.football.length, 1);
  assert.equal(result.unmatched.odds.length, 1);
});

test("similarity permite un fallback tipográfico controlado", () => {
  assert.ok(similarity("united states", "united statse") > 0.8);
});
