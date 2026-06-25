"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OddsProvider } = require("../lib/providers/oddsProvider");

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

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
