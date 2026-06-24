"use strict";

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function csv(value, fallback) {
  return String(value || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFromEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function loadConfig(env = process.env) {
  return {
    apiSportsKey: env.APISPORTS_KEY || env.API_FOOTBALL_KEY || "",
    oddsApiKey: env.ODDS_API_KEY || "",
    football: {
      baseUrl:
        env.API_FOOTBALL_BASE_URL ||
        "https://v3.football.api-sports.io",
      league: env.API_FOOTBALL_LEAGUE_ID || "1",
      season: env.API_FOOTBALL_SEASON || "2026",
      fixturesTtlMs: numberFromEnv(
        env.API_FOOTBALL_FIXTURES_TTL_MS,
        6 * 60 * 60 * 1000
      ),
      detailTtlMs: numberFromEnv(
        env.API_FOOTBALL_DETAIL_TTL_MS,
        12 * 60 * 60 * 1000
      ),
      liveStatsTtlMs: numberFromEnv(
        env.API_FOOTBALL_LIVE_STATS_TTL_MS,
        5 * 60 * 1000
      ),
      staleTtlMs: numberFromEnv(
        env.API_FOOTBALL_STALE_TTL_MS,
        72 * 60 * 60 * 1000
      ),
      seasonDataEnabled: booleanFromEnv(
        env.API_FOOTBALL_SEASON_DATA_ENABLED,
        true
      ),
      enrichment: (env.FOOTBALL_ENRICHMENT || "basic").toLowerCase(),
      enrichmentLimit: numberFromEnv(env.FOOTBALL_ENRICH_LIMIT, 8)
    },
    odds: {
      baseUrl: env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4",
      sportKey: env.ODDS_SPORT_KEY || "",
      sportHints: csv(
        env.ODDS_SPORT_TITLE_HINTS,
        "FIFA World Cup,World Cup,soccer_fifa_world_cup"
      ),
      regions: csv(env.ODDS_REGIONS, "eu,uk"),
      // The Odds API cobra por mercado×región. Para activar Over/Under, BTTS y
      // hándicap (los procesa merger.js) usa:
      //   ODDS_MARKETS=h2h,totals,btts,spreads
      // Por defecto solo h2h para no disparar el consumo de cuota.
      markets: csv(env.ODDS_MARKETS, "h2h"),
      sportsTtlMs: numberFromEnv(
        env.ODDS_SPORTS_TTL_MS,
        24 * 60 * 60 * 1000
      ),
      sportsStaleTtlMs: numberFromEnv(
        env.ODDS_SPORTS_STALE_TTL_MS,
        7 * 24 * 60 * 60 * 1000
      ),
      oddsTtlMs: numberFromEnv(env.ODDS_TTL_MS, 60 * 60 * 1000),
      staleTtlMs: numberFromEnv(
        env.ODDS_STALE_TTL_MS,
        12 * 60 * 60 * 1000
      )
    },
    reconciliation: {
      timeWindowMinutes: numberFromEnv(env.MATCH_TIME_WINDOW_MINUTES, 90),
      fuzzyThreshold: numberFromEnv(env.MATCH_FUZZY_THRESHOLD, 0.86),
      allowSwapped: booleanFromEnv(env.MATCH_ALLOW_SWAPPED, true)
    }
  };
}

module.exports = { loadConfig };
