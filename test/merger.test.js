"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeMatch } = require("../lib/merger");

test("calcula overround, probabilidad justa y mejor precio 1X2", () => {
  const merged = mergeMatch({
    football: {
      id: "123",
      commenceTime: "2026-06-15T18:00:00Z",
      home: { name: "Spain" },
      away: { name: "Cape Verde" },
      competition: { name: "World Cup" },
      features: { standings: null }
    },
    odds: {
      id: "odds-1",
      bookmakers: [
        {
          key: "alpha",
          title: "Alpha",
          markets: [{
            key: "h2h",
            outcomes: [
              { name: "Spain", price: 1.5 },
              { name: "Draw", price: 4 },
              { name: "Cabo Verde", price: 8 }
            ]
          }]
        },
        {
          key: "beta",
          title: "Beta",
          markets: [{
            key: "h2h",
            outcomes: [
              { name: "Spain", price: 1.55 },
              { name: "Draw", price: 3.9 },
              { name: "Cape Verde", price: 7.5 }
            ]
          }]
        }
      ]
    },
    reconciliation: {
      method: "alias",
      confidence: 0.97,
      timeDeltaMinutes: 0
    }
  });

  assert.equal(merged.fuente_ids.api_football_fixture, "123");
  assert.equal(merged.cuotas.mejor_precio["1"].casa, "Beta");
  assert.equal(merged.cuotas.mejor_precio.X.casa, "Alpha");
  assert.ok(merged.cuotas.overround_por_casa.Alpha > 0);
  const sum = Object.values(merged.cuotas.prob_implicita_justa)
    .reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
});

test("conserva el 1X2 de API-Football si Odds API invierte la orientación", () => {
  const merged = mergeMatch({
    football: {
      id: "456",
      commenceTime: "2026-06-27T00:00:00Z",
      home: { name: "Uruguay" },
      away: { name: "España" },
      competition: { name: "World Cup" },
      features: {}
    },
    odds: {
      id: "odds-swapped",
      homeTeam: "Spain",
      awayTeam: "Uruguay",
      bookmakers: [{
        key: "book",
        title: "Book",
        markets: [{
          key: "h2h",
          outcomes: [
            { name: "Spain", price: 2.1 },
            { name: "Draw", price: 3.2 },
            { name: "Uruguay", price: 3.8 }
          ]
        }]
      }]
    },
    reconciliation: {
      method: "alias",
      orientation: "swapped",
      confidence: 0.97,
      timeDeltaMinutes: 30
    }
  });

  assert.equal(merged.local, "Uruguay");
  assert.equal(
    merged.match_id_interno,
    "uruguay-spain-2026-06-27"
  );
  assert.equal(merged.cuotas.por_casa.Book["1"], 3.8);
  assert.equal(merged.cuotas.por_casa.Book["2"], 2.1);
  assert.equal(merged.reconciliacion.orientacion, "swapped");
});

test("procesa Over/Under, BTTS y hándicap si vienen en las cuotas", () => {
  const merged = mergeMatch({
    football: {
      id: "789",
      commenceTime: "2026-06-24T20:00:00Z",
      home: { name: "Spain" },
      away: { name: "Morocco" },
      competition: { name: "World Cup" },
      features: {}
    },
    odds: {
      id: "odds-mkts",
      bookmakers: [
        {
          key: "alpha", title: "Alpha",
          markets: [
            { key: "h2h", outcomes: [
              { name: "Spain", price: 1.5 }, { name: "Draw", price: 4 }, { name: "Morocco", price: 7 }
            ] },
            { key: "totals", outcomes: [
              { name: "Over", price: 1.9, point: 2.5 }, { name: "Under", price: 1.95, point: 2.5 }
            ] },
            { key: "btts", outcomes: [
              { name: "Yes", price: 1.8 }, { name: "No", price: 2.0 }
            ] },
            { key: "spreads", outcomes: [
              { name: "Spain", price: 1.85, point: -1.5 }, { name: "Morocco", price: 1.95, point: 1.5 }
            ] }
          ]
        }
      ]
    },
    reconciliation: { method: "alias", confidence: 0.97, timeDeltaMinutes: 0 }
  });

  const m = merged.cuotas.mercados;
  // Over/Under línea 2.5
  assert.equal(m.over_under[0].linea, 2.5);
  assert.equal(m.over_under[0].mejor_precio.Over.cuota, 1.9);
  const ouSum = m.over_under[0].prob_implicita_justa.Over + m.over_under[0].prob_implicita_justa.Under;
  assert.ok(Math.abs(ouSum - 1) < 0.001);
  // BTTS sin línea
  assert.equal(m.btts[0].linea, null);
  assert.equal(m.btts[0].mejor_precio.Yes.casa, "Alpha");
  // Hándicap agrupado por |punto| = 1.5, local "1" y visitante "2"
  assert.equal(m.handicap[0].linea, 1.5);
  assert.equal(m.handicap[0].por_casa.Alpha["1"], 1.85);
  assert.equal(m.handicap[0].por_casa.Alpha["2"], 1.95);
});
