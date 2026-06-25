"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildUnifiedMatches } = require("../lib/orchestrator");

const metadata = {
  cache: { status: "miss", storedAt: "2026-06-10T12:00:00Z" },
  metadata: { provider: "mock", rate: { remaining: "99" } }
};

test("orquesta fixtures ICS, catálogo, cuotas, reconciliación y merge", async () => {
  const fixtureProvider = {
    async getFixtures() {
      return {
        ...metadata,
        data: [{
          source: "fixtur.es",
          id: "123",
          commenceTime: "2026-06-15T16:00:00Z",
          home: { id: 1, name: "Spain" },
          away: { id: 2, name: "Cape Verde" },
          competition: { id: 1, name: "World Cup", season: 2026 },
          features: { form: { home: null, away: null } }
        }]
      };
    }
  };
  const oddsProvider = {
    async resolveSportKey() {
      return {
        sport: {
          key: "soccer_fifa_world_cup",
          title: "FIFA World Cup",
          active: true
        },
        catalog: { ...metadata, data: [] }
      };
    },
    async getOdds() {
      return {
        ...metadata,
        data: [{
          source: "the-odds-api",
          id: "abc",
          commenceTime: "2026-06-15T16:30:00Z",
          homeTeam: "Spain",
          awayTeam: "Cabo Verde",
          bookmakers: [{
            key: "book",
            title: "Book",
            markets: [{
              key: "h2h",
              outcomes: [
                { name: "Spain", price: 1.5 },
                { name: "Draw", price: 4 },
                { name: "Cabo Verde", price: 8 }
              ]
            }]
          }]
        }]
      };
    }
  };
  const config = {
    odds: {
      sportKey: "",
      sportHints: ["World Cup"],
      regions: ["eu", "uk"],
      markets: ["h2h"]
    },
    reconciliation: {
      timeWindowMinutes: 90,
      fuzzyThreshold: 0.86
    }
  };

  const result = await buildUnifiedMatches({
    config,
    fixtureProvider,
    oddsProvider,
    logger: { warn() {} }
  });

  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.matches[0].match_id_interno, "spain-cape-verde-2026-06-15");
  assert.equal(result.matches[0].fuente_ids.odds_api_event, "abc");
  assert.equal(result.matches[0].fuente_ids.fixture, "123");
  assert.equal(result.matches[0].features.form.home, null);
  assert.equal(result.matches[0].reconciliacion.metodo, "alias");
  assert.equal(result.matches[0].reconciliacion.orientacion, "same");
  assert.equal(result.competition.fixturesSource, "fixtur.es");
});

test("filtra fixtures ICS por fecha antes de reconciliar", async () => {
  const fixtureProvider = {
    async getFixtures() {
      return {
        cache: { status: "miss" },
        metadata: { provider: "fixtur.es", status: 200 },
        data: [
          {
            source: "fixtur.es",
            id: "inside",
            commenceTime: "2026-06-15T16:00:00Z",
            home: { id: null, name: "Spain" },
            away: { id: null, name: "Cape Verde" },
            competition: { id: 1, name: "FIFA World Cup", season: 2026 },
            features: { status: { short: "NS" }, goals: { home: null, away: null } }
          },
          {
            source: "fixtur.es",
            id: "outside",
            commenceTime: "2026-06-18T16:00:00Z",
            home: { id: null, name: "France" },
            away: { id: null, name: "Brazil" },
            competition: { id: 1, name: "FIFA World Cup", season: 2026 },
            features: { status: { short: "NS" }, goals: { home: null, away: null } }
          }
        ]
      };
    }
  };
  const oddsProvider = {
    async resolveSportKey() {
      return {
        sport: { key: "soccer_fifa_world_cup", title: "FIFA World Cup" },
        catalog: { ...metadata, data: [] }
      };
    },
    async getOdds() {
      return {
        ...metadata,
        data: [{
          source: "the-odds-api",
          id: "odds-1",
          commenceTime: "2026-06-15T16:00:00Z",
          homeTeam: "Spain",
          awayTeam: "Cape Verde",
          bookmakers: []
        }]
      };
    }
  };
  const config = {
    odds: {
      sportKey: "",
      sportHints: ["World Cup"],
      regions: ["eu"],
      markets: ["h2h"]
    },
    reconciliation: {
      timeWindowMinutes: 90,
      fuzzyThreshold: 0.86
    }
  };

  const result = await buildUnifiedMatches({
    config,
    fixtureProvider,
    oddsProvider,
    from: "2026-06-15",
    to: "2026-06-15",
    logger: { warn() {} }
  });

  assert.equal(result.counts.fixtures, 1);
  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.competition.fixturesSource, "fixtur.es");
});

test("usa balldontlie como primario y cae a proveedores de respaldo si falla", async () => {
  const warnings = [];
  const ballDontLieProvider = {
    async getFixtures() {
      throw new Error("GOAT tier required");
    },
    async resolveSportKey() {
      return {
        sport: { key: "balldontlie_fifa_worldcup", title: "FIFA World Cup" },
        catalog: { ...metadata, data: [] }
      };
    },
    async getOdds() {
      throw new Error("odds tier required");
    }
  };
  const fixtureFallbackProvider = {
    async getFixtures() {
      return {
        cache: { status: "miss" },
        metadata: { provider: "fixtur.es", status: 200 },
        data: [{
          source: "fixtur.es",
          id: "fallback-fixture",
          commenceTime: "2026-06-15T16:00:00Z",
          home: { id: null, name: "Spain" },
          away: { id: null, name: "Cape Verde" },
          competition: { id: 1, name: "FIFA World Cup", season: 2026 },
          features: { status: { short: "NS" }, goals: { home: null, away: null } }
        }]
      };
    }
  };
  const oddsFallbackProvider = {
    async resolveSportKey() {
      return {
        sport: { key: "soccer_fifa_world_cup", title: "FIFA World Cup" },
        catalog: { ...metadata, data: [] }
      };
    },
    async getOdds() {
      return {
        ...metadata,
        data: [{
          source: "the-odds-api",
          id: "fallback-odds",
          commenceTime: "2026-06-15T16:00:00Z",
          homeTeam: "Spain",
          awayTeam: "Cape Verde",
          bookmakers: []
        }]
      };
    }
  };
  const config = {
    ballDontLieApiKey: "secret-bdl",
    ballDontLie: {},
    oddsApiKey: "secret-odds",
    odds: {
      sportKey: "",
      sportHints: ["World Cup"],
      regions: ["eu"],
      markets: ["h2h"]
    },
    reconciliation: {
      timeWindowMinutes: 90,
      fuzzyThreshold: 0.86
    }
  };

  const result = await buildUnifiedMatches({
    config,
    ballDontLieProvider,
    fixtureFallbackProvider,
    oddsFallbackProvider,
    logger: { warn: (...args) => warnings.push(args.join(" ")) }
  });

  assert.equal(result.competition.fixturesSource, "fixtur.es");
  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.matches[0].fuente_ids.fixture, "fallback-fixture");
  assert.equal(result.matches[0].fuente_ids.odds_api_event, "fallback-odds");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /balldontlie fixtures/);
  assert.match(warnings[1], /balldontlie odds/);
});
