"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildUnifiedMatches } = require("../lib/orchestrator");

const metadata = {
  cache: { status: "miss", storedAt: "2026-06-10T12:00:00Z" },
  metadata: { provider: "mock", rate: { remaining: "99" } }
};

test("orquesta catálogo, fixtures, cuotas, reconciliación y merge", async () => {
  const footballProvider = {
    async getFixtures() {
      return {
        ...metadata,
        data: [{
          source: "api-football",
          id: "123",
          commenceTime: "2026-06-15T16:00:00Z",
          home: { id: 1, name: "Spain" },
          away: { id: 2, name: "Cape Verde" },
          competition: { id: 1, name: "World Cup", season: 2026 },
          features: { form: { home: null, away: null } }
        }]
      };
    },
    async enrichFixtures(fixtures) {
      return {
        fixtures: fixtures.map((fixture) => ({
          ...fixture,
          features: {
            ...fixture.features,
            form: { home: "WWDWW", away: "LDWWL" }
          }
        })),
        requests: []
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
    football: {
      league: "1",
      season: "2026",
      enrichment: "basic",
      enrichmentLimit: 8
    },
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
    footballProvider,
    oddsProvider,
    logger: { warn() {} }
  });

  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.matches[0].match_id_interno, "spain-cape-verde-2026-06-15");
  assert.equal(result.matches[0].fuente_ids.odds_api_event, "abc");
  assert.equal(result.matches[0].features.form.home, "WWDWW");
  assert.equal(result.matches[0].reconciliacion.metodo, "alias");
  assert.equal(result.matches[0].reconciliacion.orientacion, "same");
});

test("usa el feed ICS si API-Football rechaza la temporada", async () => {
  const footballProvider = {
    async getFixtures() {
      throw new Error("Free plans do not have access to this season.");
    },
    async enrichFixtures() {
      throw new Error("No debería enriquecer fixtures del fallback.");
    }
  };
  const fixtureFallbackProvider = {
    async getFixtures() {
      return {
        cache: { status: "miss" },
        metadata: { provider: "fixtur.es", status: 200 },
        data: [{
          source: "fixtur.es",
          id: "ics-1",
          commenceTime: "2026-06-15T16:00:00Z",
          home: { id: null, name: "Spain" },
          away: { id: null, name: "Cape Verde" },
          competition: { id: 1, name: "FIFA World Cup", season: 2026 },
          features: { status: { short: "NS" }, goals: { home: null, away: null } }
        }]
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
    apiSportsKey: "free-plan",
    football: {
      league: "1",
      season: "2026",
      enrichment: "basic",
      enrichmentLimit: 8
    },
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
    footballProvider,
    fixtureFallbackProvider,
    oddsProvider,
    logger: { warn() {} }
  });

  assert.equal(result.competition.fixturesSource, "fixtur.es");
  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.matches[0].features.status.short, "NS");
});

test("omite API-Football si los datos de temporada están desactivados", async () => {
  let footballCalls = 0;
  const footballProvider = {
    async getFixtures() {
      footballCalls += 1;
      throw new Error("No debería consultar la temporada.");
    }
  };
  const fixtureFallbackProvider = {
    async getFixtures() {
      return {
        cache: { status: "miss" },
        metadata: { provider: "fixtur.es", status: 200 },
        data: []
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
      return { ...metadata, data: [] };
    }
  };
  const config = {
    apiSportsKey: "free-plan",
    football: {
      league: "1",
      season: "2026",
      seasonDataEnabled: false,
      enrichment: "none",
      enrichmentLimit: 0
    },
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
    footballProvider,
    fixtureFallbackProvider,
    oddsProvider,
    logger: { warn() {} }
  });

  assert.equal(footballCalls, 0);
  assert.equal(result.competition.fixturesSource, "fixtur.es");
});
