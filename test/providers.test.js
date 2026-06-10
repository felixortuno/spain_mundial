"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FootballProvider } = require("../lib/providers/footballProvider");
const { OddsProvider } = require("../lib/providers/oddsProvider");

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("FootballProvider autentica por cabecera y normaliza fixtures", async () => {
  let captured;
  const provider = new FootballProvider({
    apiKey: "secret-football",
    baseUrl: "https://football.test",
    fixturesTtlMs: 1000,
    detailTtlMs: 1000,
    staleTtlMs: 10000,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse({
        errors: [],
        response: [{
          fixture: { id: 7, date: "2026-06-15T16:00:00Z" },
          league: { id: 1, name: "World Cup", season: 2026 },
          teams: {
            home: { id: 10, name: "Spain" },
            away: { id: 20, name: "Cape Verde" }
          }
        }]
      }, { "x-ratelimit-requests-remaining": "99" });
    }
  });

  const result = await provider.getFixtures({ league: 1, season: 2026 });

  assert.equal(captured.options.headers["x-apisports-key"], "secret-football");
  assert.match(captured.url, /\/fixtures\?/);
  assert.equal(result.data[0].home.name, "Spain");
  assert.equal(result.metadata.rate.dailyRemaining, "99");
});

test("OddsProvider autentica por query, resuelve sport_key y normaliza cuotas", async () => {
  const urls = [];
  const provider = new OddsProvider({
    apiKey: "secret-odds",
    baseUrl: "https://odds.test/v4",
    sportsTtlMs: 1000,
    sportsStaleTtlMs: 10000,
    oddsTtlMs: 1000,
    staleTtlMs: 10000,
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (url.pathname.endsWith("/sports/")) {
        return jsonResponse([
          {
            key: "soccer_fifa_world_cup_women",
            group: "Soccer",
            title: "FIFA Women's World Cup",
            active: true
          },
          {
            key: "soccer_fifa_world_cup",
            group: "Soccer",
            title: "FIFA World Cup",
            active: false
          }
        ]);
      }
      return jsonResponse([{
        id: "event-1",
        sport_key: "soccer_fifa_world_cup",
        commence_time: "2026-06-15T16:00:00Z",
        home_team: "Spain",
        away_team: "Cape Verde",
        bookmakers: []
      }], { "x-requests-remaining": "498" });
    }
  });

  const resolved = await provider.resolveSportKey({
    titleHints: ["World Cup", "soccer_fifa_world_cup"]
  });
  const result = await provider.getOdds({
    sportKey: resolved.sport.key,
    regions: ["eu", "uk"],
    markets: ["h2h"]
  });

  assert.equal(resolved.sport.key, "soccer_fifa_world_cup");
  assert.equal(result.data[0].id, "event-1");
  assert.ok(urls.every((url) => url.includes("apiKey=secret-odds")));
  assert.match(urls[1], /regions=eu%2Cuk/);
  assert.match(urls[1], /markets=h2h/);
  assert.equal(result.metadata.rate.remaining, "498");
});
