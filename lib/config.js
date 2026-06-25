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
    ballDontLieApiKey: env.BALLDONTLIE_API_KEY || env.BDL_API_KEY || "",
    ballDontLie: {
      baseUrl: env.BALLDONTLIE_BASE_URL || "https://api.balldontlie.io",
      season: numberFromEnv(env.BALLDONTLIE_SEASON, 2026),
      ttlMs: numberFromEnv(env.BALLDONTLIE_TTL_MS, 5 * 60 * 1000),
      staleTtlMs: numberFromEnv(env.BALLDONTLIE_STALE_TTL_MS, 60 * 60 * 1000)
    },
    oddsApiKey: env.ODDS_API_KEY || "",
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
