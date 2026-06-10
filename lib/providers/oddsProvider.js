"use strict";

const { CacheStore } = require("../cache");

function rateMetadata(headers) {
  return {
    remaining: headers.get("x-requests-remaining"),
    used: headers.get("x-requests-used"),
    last: headers.get("x-requests-last")
  };
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeOddsEvent(event) {
  return {
    source: "the-odds-api",
    id: String(event.id || ""),
    sportKey: event.sport_key || null,
    sportTitle: event.sport_title || null,
    commenceTime: event.commence_time || null,
    homeTeam: event.home_team || "TBD",
    awayTeam: event.away_team || "TBD",
    bookmakers: (event.bookmakers || []).map((bookmaker) => ({
      key: bookmaker.key,
      title: bookmaker.title,
      lastUpdate: bookmaker.last_update || null,
      markets: (bookmaker.markets || []).map((market) => ({
        key: market.key,
        lastUpdate: market.last_update || null,
        outcomes: (market.outcomes || []).map((outcome) => ({
          name: outcome.name,
          price: outcome.price,
          point: outcome.point ?? null
        }))
      }))
    }))
  };
}

class OddsProvider {
  constructor({
    apiKey,
    baseUrl,
    sportsTtlMs,
    sportsStaleTtlMs,
    oddsTtlMs,
    staleTtlMs,
    fetchImpl = fetch
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sportsTtlMs = sportsTtlMs;
    this.sportsStaleTtlMs = sportsStaleTtlMs;
    this.oddsTtlMs = oddsTtlMs;
    this.staleTtlMs = staleTtlMs;
    this.fetch = fetchImpl;
    this.cache = new CacheStore("the-odds-api");
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error("Falta ODDS_API_KEY.");
      error.code = "MISSING_ODDS_API_KEY";
      throw error;
    }
  }

  async request(path, params, { ttlMs, staleTtlMs = this.staleTtlMs } = {}) {
    this.ensureConfigured();
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(
          key,
          Array.isArray(value) ? value.join(",") : String(value)
        );
      }
    }

    const safeParams = new URLSearchParams(url.searchParams);
    safeParams.delete("apiKey");
    const cacheKey = `${this.baseUrl}${path}?${safeParams.toString()}`;

    return this.cache.getOrLoad({
      key: cacheKey,
      ttlMs,
      staleTtlMs,
      loader: async () => {
        const response = await this.fetch(url, {
          headers: { Accept: "application/json" }
        });
        const metadata = {
          provider: "the-odds-api",
          status: response.status,
          rate: rateMetadata(response.headers)
        };
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          const message =
            payload?.message || payload?.error_code || `HTTP ${response.status}`;
          const error = new Error(`The Odds API: ${message}`);
          error.status = response.status;
          error.metadata = metadata;
          throw error;
        }

        console.info("[the-odds-api] consumo", metadata.rate);
        return { data: payload, metadata };
      }
    });
  }

  listSports() {
    return this.request("/sports/", { all: "true" }, {
      ttlMs: this.sportsTtlMs,
      staleTtlMs: this.sportsStaleTtlMs
    });
  }

  async resolveSportKey({ sportKey, titleHints = [] } = {}) {
    const result = await this.listSports();
    const sports = Array.isArray(result.data) ? result.data : [];

    if (sportKey) {
      const selected = sports.find((sport) => sport.key === sportKey);
      if (!selected) {
        throw new Error(
          `ODDS_SPORT_KEY=${sportKey} no aparece en /v4/sports.`
        );
      }
      return { sport: selected, catalog: result };
    }

    const hints = titleHints.map(normalizeSearch).filter(Boolean);
    const ranked = sports
      .map((sport) => {
        const key = normalizeSearch(sport.key);
        const title = normalizeSearch(sport.title);
        const haystack = normalizeSearch(
          `${sport.key} ${sport.title} ${sport.group} ${sport.description}`
        );
        let score = 0;
        for (const hint of hints) {
          if (key === hint) score = Math.max(score, 150);
          else if (title === hint) score = Math.max(score, 130);
          else if (haystack === hint) score = Math.max(score, 100);
          else if (haystack.includes(hint)) score = Math.max(score, 80);
          else {
            const words = hint.split(" ");
            const matches = words.filter((word) => haystack.includes(word));
            score = Math.max(score, matches.length * 10);
          }
        }
        if (sport.active) score += 5;
        if (normalizeSearch(sport.group).includes("soccer")) score += 3;
        return { sport, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
      throw new Error(
        `No se encontró el Mundial en /v4/sports con: ${titleHints.join(", ")}.`
      );
    }
    return { sport: ranked[0].sport, catalog: result };
  }

  async getOdds({ sportKey, regions, markets }) {
    const result = await this.request(
      `/sports/${encodeURIComponent(sportKey)}/odds/`,
      {
        regions,
        markets,
        oddsFormat: "decimal",
        dateFormat: "iso"
      },
      { ttlMs: this.oddsTtlMs }
    );
    return {
      ...result,
      data: (Array.isArray(result.data) ? result.data : []).map(
        normalizeOddsEvent
      )
    };
  }
}

module.exports = {
  OddsProvider,
  normalizeOddsEvent,
  normalizeSearch
};
