"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BallDontLieFifaProvider,
  americanToDecimal,
  normalizeMatch,
  normalizeOddsEvents
} = require("../lib/providers/ballDontLieFifaProvider");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function rawMatch(overrides = {}) {
  return {
    id: 9001,
    match_number: 10,
    datetime: "2026-06-15T16:00:00Z",
    status: "in_progress",
    clock_seconds: 4020,
    home_score: 2,
    away_score: 1,
    first_half_home_score: 1,
    first_half_away_score: 0,
    season: { year: 2026 },
    stage: { id: 1, name: "Group stage" },
    group: { name: "Group B" },
    stadium: { id: 20, name: "Test Stadium", city: "Madrid", country: "Spain" },
    referee: { name: "Ref Example" },
    home_team: { id: 1, name: "Spain" },
    away_team: { id: 2, name: "Cape Verde" },
    ...overrides
  };
}

test("convierte cuotas americanas a decimal", () => {
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(-200), 1.5);
  assert.equal(americanToDecimal("0"), null);
});

test("normaliza partidos balldontlie al contrato interno de fixtures", () => {
  const fixture = normalizeMatch(rawMatch());

  assert.equal(fixture.source, "balldontlie");
  assert.equal(fixture.id, "9001");
  assert.equal(fixture.home.name, "Spain");
  assert.equal(fixture.away.name, "Cape Verde");
  assert.equal(fixture.features.status.short, "2H");
  assert.equal(fixture.features.goals.home, 2);
  assert.equal(fixture.features.venue.name, "Test Stadium");
  assert.equal(fixture.competition.group, "Group B");
});

test("normaliza odds balldontlie al contrato compatible con The Odds API", () => {
  const match = normalizeMatch(rawMatch({ status: "scheduled", home_score: null, away_score: null }));
  const [event] = normalizeOddsEvents([
    {
      match_id: 9001,
      vendor: "pinnacle",
      updated_at: "2026-06-14T10:00:00Z",
      moneyline_home_odds: -120,
      moneyline_draw_odds: 240,
      moneyline_away_odds: 350,
      total_value: 2.5,
      total_over_odds: 110,
      total_under_odds: -130,
      spread_home_value: -1.5,
      spread_home_odds: 160,
      spread_away_value: 1.5,
      spread_away_odds: -180,
      markets: [{
        type: "both_teams_to_score",
        updated_at: "2026-06-14T10:01:00Z",
        outcomes: [
          { type: "yes", decimal_odds: "1.91" },
          { type: "no", decimal_odds: "1.95" }
        ]
      }]
    }
  ], [match]);

  assert.equal(event.source, "balldontlie");
  assert.equal(event.homeTeam, "Spain");
  assert.equal(event.bookmakers[0].title, "Pinnacle");
  assert.deepEqual(
    event.bookmakers[0].markets.find((market) => market.key === "h2h").outcomes,
    [
      { name: "Spain", price: 1.833, point: null },
      { name: "Draw", price: 3.4, point: null },
      { name: "Cape Verde", price: 4.5, point: null }
    ]
  );
  assert.equal(
    event.bookmakers[0].markets.find((market) => market.key === "totals").outcomes[0].point,
    2.5
  );
  assert.equal(
    event.bookmakers[0].markets.find((market) => market.key === "btts").outcomes[0].name,
    "Yes"
  );
});

test("getLiveMatches usa matches, eventos y team_match_stats de balldontlie", async () => {
  const calls = [];
  const provider = new BallDontLieFifaProvider({
    apiKey: "secret-bdl",
    baseUrl: "https://balldontlie.test",
    season: 2026,
    ttlMs: 1,
    staleTtlMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({
        path: url.pathname,
        params: url.searchParams,
        auth: options.headers.Authorization
      });

      if (url.pathname.endsWith("/matches")) {
        return jsonResponse({
          data: [
            rawMatch(),
            rawMatch({
              id: 9002,
              status: "scheduled",
              datetime: "2026-06-16T16:00:00Z",
              home_score: null,
              away_score: null
            })
          ],
          meta: { next_cursor: null }
        });
      }
      if (url.pathname.endsWith("/match_events")) {
        assert.deepEqual(url.searchParams.getAll("match_ids[]"), ["9001"]);
        return jsonResponse({
          data: [{
            id: 1,
            match_id: 9001,
            incident_type: "goal",
            incident_class: "regular",
            is_home: true,
            time_minute: 55,
            player: { name: "Player One" },
            assist_player: { name: "Assistant One" }
          }],
          meta: { next_cursor: null }
        });
      }
      if (url.pathname.endsWith("/team_match_stats")) {
        assert.deepEqual(url.searchParams.getAll("match_ids[]"), ["9001"]);
        return jsonResponse({
          data: [
            {
              match_id: 9001,
              is_home: true,
              possession_pct: 61.5,
              shots_on_target: 5,
              shots_total: 12,
              corners: 4,
              expected_goals: 1.7,
              passes_total: 500,
              passes_accurate: 425
            },
            {
              match_id: 9001,
              is_home: false,
              possession_pct: 38.5,
              shots_on_target: 2,
              shots_total: 7,
              corners: 1,
              expected_goals: 0.8,
              passes_total: 300,
              passes_accurate: 210
            }
          ],
          meta: { next_cursor: null }
        });
      }
      return jsonResponse({ data: [], meta: { next_cursor: null } });
    }
  });
  provider.cache.clear();

  const data = await provider.getLiveMatches({ maxMatches: 6 });

  assert.equal(data.source, "balldontlie");
  assert.equal(data.active, true);
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].status.short, "2H");
  assert.equal(data.matches[0].statistics.home.possession, 61.5);
  assert.equal(data.matches[0].statistics.home.passAccuracy, 85);
  assert.equal(data.matches[0].events[0].type, "Goal");
  assert.ok(data.matches[0].insights.pressure.home > data.matches[0].insights.pressure.away);
  assert.ok(calls.every((call) => call.auth === "secret-bdl"));
});
