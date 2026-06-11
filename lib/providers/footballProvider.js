"use strict";

const { CacheStore } = require("../cache");

function hasApiErrors(errors) {
  if (Array.isArray(errors)) return errors.length > 0;
  return Boolean(errors && Object.keys(errors).length);
}

function rateMetadata(headers) {
  return {
    dailyLimit: headers.get("x-ratelimit-requests-limit"),
    dailyRemaining: headers.get("x-ratelimit-requests-remaining"),
    minuteLimit: headers.get("x-ratelimit-limit"),
    minuteRemaining: headers.get("x-ratelimit-remaining")
  };
}

function fixtureFeatures(item) {
  return {
    status: {
      short: item.fixture?.status?.short || null,
      long: item.fixture?.status?.long || null,
      elapsed: item.fixture?.status?.elapsed ?? null
    },
    goals: item.goals || { home: null, away: null },
    score: item.score || null,
    round: item.league?.round || null,
    referee: item.fixture?.referee || null,
    venue: item.fixture?.venue || null,
    prediction: null,
    standings: null,
    form: { home: null, away: null },
    statistics: null,
    lineups: null,
    injuries: null,
    enrichmentErrors: []
  };
}

function normalizeFixture(item) {
  return {
    source: "api-football",
    id: String(item.fixture?.id ?? ""),
    commenceTime: item.fixture?.date || null,
    timestamp: item.fixture?.timestamp ?? null,
    home: {
      id: item.teams?.home?.id ?? null,
      name: item.teams?.home?.name || "TBD"
    },
    away: {
      id: item.teams?.away?.id ?? null,
      name: item.teams?.away?.name || "TBD"
    },
    competition: {
      id: item.league?.id ?? null,
      name: item.league?.name || null,
      country: item.league?.country || null,
      season: item.league?.season ?? null,
      round: item.league?.round || null
    },
    features: fixtureFeatures(item)
  };
}

function normalizeStandings(payload) {
  const league = payload?.[0]?.league;
  const groups = Array.isArray(league?.standings) ? league.standings : [];
  const byTeamId = new Map();

  for (const group of groups) {
    for (const row of group || []) {
      if (row?.team?.id != null) byTeamId.set(row.team.id, row);
    }
  }
  return byTeamId;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      () => run()
    )
  );
  return results;
}

class FootballProvider {
  constructor({
    apiKey,
    baseUrl,
    fixturesTtlMs,
    detailTtlMs,
    staleTtlMs,
    fetchImpl = fetch
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fixturesTtlMs = fixturesTtlMs;
    this.detailTtlMs = detailTtlMs;
    this.staleTtlMs = staleTtlMs;
    this.fetch = fetchImpl;
    this.cache = new CacheStore("api-football");
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error(
        "Falta APISPORTS_KEY (o API_FOOTBALL_KEY por compatibilidad)."
      );
      error.code = "MISSING_APISPORTS_KEY";
      throw error;
    }
  }

  async request(path, params, { ttlMs = this.detailTtlMs } = {}) {
    this.ensureConfigured();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const cacheKey = `${this.baseUrl}${path}?${url.searchParams.toString()}`;

    return this.cache.getOrLoad({
      key: cacheKey,
      ttlMs,
      staleTtlMs: this.staleTtlMs,
      loader: async () => {
        const response = await this.fetch(url, {
          headers: {
            Accept: "application/json",
            "x-apisports-key": this.apiKey
          }
        });
        const metadata = {
          provider: "api-football",
          status: response.status,
          rate: rateMetadata(response.headers)
        };
        const payload = await response.json().catch(() => ({}));

        if (!response.ok || hasApiErrors(payload.errors)) {
          const detail = hasApiErrors(payload.errors)
            ? JSON.stringify(payload.errors)
            : `HTTP ${response.status}`;
          const error = new Error(`API-Football: ${detail}`);
          error.status = response.status;
          error.metadata = metadata;
          throw error;
        }

        console.info("[api-football] consumo", metadata.rate);
        return { data: payload.response || [], metadata };
      }
    });
  }

  async getFixtures({ league, season, team, from, to, live, timezone = "UTC" } = {}) {
    const result = await this.request(
      "/fixtures",
      { league, season, team, from, to, live, timezone },
      { ttlMs: this.fixturesTtlMs }
    );
    return { ...result, data: result.data.map(normalizeFixture) };
  }

  getPrediction(fixtureId) {
    return this.request("/predictions", { fixture: fixtureId });
  }

  getStatistics(fixtureId) {
    return this.request("/fixtures/statistics", { fixture: fixtureId });
  }

  getEvents(fixtureId) {
    return this.request("/fixtures/events", { fixture: fixtureId });
  }

  getLineups(fixtureId) {
    return this.request("/fixtures/lineups", { fixture: fixtureId });
  }

  getInjuries(fixtureId) {
    return this.request("/injuries", { fixture: fixtureId });
  }

  getFixturePlayers(fixtureId) {
    return this.request("/fixtures/players", { fixture: fixtureId });
  }

  getTopScorers({ league, season }) {
    return this.request("/players/topscorers", { league, season });
  }

  getTopAssists({ league, season }) {
    return this.request("/players/topassists", { league, season });
  }

  getStandings({ league, season }) {
    return this.request("/standings", { league, season });
  }

  async enrichFixtures(fixtures, { league, season, mode = "basic", limit = 8 }) {
    if (mode === "none" || fixtures.length === 0) {
      return { fixtures, requests: [] };
    }

    const requests = [];
    let standings = new Map();
    try {
      const result = await this.getStandings({ league, season });
      standings = normalizeStandings(result.data);
      requests.push({ endpoint: "standings", ...result });
    } catch (error) {
      console.warn("[api-football] standings no disponible:", error.message);
    }

    const enriched = fixtures.map((fixture) => ({
      ...fixture,
      features: {
        ...fixture.features,
        standings: {
          home: standings.get(fixture.home.id) || null,
          away: standings.get(fixture.away.id) || null
        },
        form: {
          home: standings.get(fixture.home.id)?.form || null,
          away: standings.get(fixture.away.id)?.form || null
        }
      }
    }));

    if (mode !== "full") return { fixtures: enriched, requests };

    const selected = enriched.slice(0, Math.max(0, limit));
    await mapWithConcurrency(selected, 2, async (fixture) => {
      const calls = [
        ["prediction", () => this.getPrediction(fixture.id)],
        ["statistics", () => this.getStatistics(fixture.id)],
        ["lineups", () => this.getLineups(fixture.id)],
        ["injuries", () => this.getInjuries(fixture.id)]
      ];

      for (const [feature, load] of calls) {
        try {
          const result = await load();
          fixture.features[feature] =
            feature === "prediction" ? result.data[0] || null : result.data;
          requests.push({ endpoint: feature, fixtureId: fixture.id, ...result });
        } catch (error) {
          fixture.features.enrichmentErrors.push({
            feature,
            message: error.message
          });
          console.warn(
            `[api-football] ${feature} no disponible para ${fixture.id}:`,
            error.message
          );
        }
      }
      return fixture;
    });

    return { fixtures: enriched, requests };
  }
}

module.exports = {
  FootballProvider,
  normalizeFixture,
  normalizeStandings
};
