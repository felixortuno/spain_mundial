"use strict";

const { requireAnalysisAuth } = require("../lib/analysisAuth");
const { loadConfig } = require("../lib/config");
const { FootballProvider } = require("../lib/providers/footballProvider");
const { FixturesIcsProvider } = require("../lib/providers/fixturesIcsProvider");
const {
  aggregateFixtures,
  bestGoalkeeper,
  localDate,
  playerLeader
} = require("../lib/tournamentStats");

const TIME_ZONE = "Europe/Madrid";
const MAX_DAILY_PLAYER_FIXTURES = 8;
const TOURNAMENT_FIXTURES = 104;

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Método no permitido." });
  }
  if (!requireAnalysisAuth(request, response)) return;
  if (request.method === "HEAD") {
    response.setHeader("Cache-Control", "private, no-store");
    return response.status(200).end();
  }

  const config = loadConfig();
  if (!config.apiSportsKey) {
    response.setHeader("Cache-Control", "private, no-store");
    return response.status(503).json({
      error: "Las estadísticas deportivas no están configuradas."
    });
  }

  const provider = new FootballProvider({
    apiKey: config.apiSportsKey,
    ...config.football,
    fixturesTtlMs: config.football.liveStatsTtlMs,
    detailTtlMs: config.football.liveStatsTtlMs
  });
  const league = config.football.league;
  const season = config.football.season;
  const today = localDate(new Date(), TIME_ZONE);

  let fixtures = [];
  let source = "api-football";
  let providerMessage = "";
  let playerStatsAvailable = true;

  try {
    const result = await provider.getFixtures({
      league,
      season,
      timezone: TIME_ZONE
    });
    fixtures = result.data;
    if (!fixtures.length) throw new Error("API-Football no publicó partidos.");
  } catch (error) {
    console.warn("[tournament-stats] API-Football no disponible:", error.message);
    try {
      const fallback = await new FixturesIcsProvider().getFixtures();
      fixtures = fallback.data;
      source = "fixtur.es";
      playerStatsAvailable = false;
      providerMessage =
        "Datos de partidos mediante el feed de respaldo. Las estadísticas de jugadores requieren acceso API-Football 2026.";
    } catch (fallbackError) {
      console.error("[tournament-stats] respaldo ICS no disponible:", fallbackError);
      return response.status(502).json({
        error: "No se pudieron actualizar las estadísticas del Mundial."
      });
    }
  }

  const aggregate = aggregateFixtures(fixtures, {
    today,
    timeZone: TIME_ZONE,
    expectedTotalFixtures: TOURNAMENT_FIXTURES
  });
  let scorers = [];
  let assists = [];
  let goalkeeperPayloads = [];

  if (playerStatsAvailable) {
    const [scorersResult, assistsResult] = await Promise.allSettled([
      provider.getTopScorers({ league, season }),
      provider.getTopAssists({ league, season })
    ]);
    scorers = scorersResult.status === "fulfilled" ? scorersResult.value.data : [];
    assists = assistsResult.status === "fulfilled" ? assistsResult.value.data : [];

    const fixtureIds = aggregate.todayFixtureIds.slice(
      0,
      MAX_DAILY_PLAYER_FIXTURES
    );
    const goalkeeperResults = await Promise.allSettled(
      fixtureIds.map((fixtureId) => provider.getFixturePlayers(fixtureId))
    );
    goalkeeperPayloads = goalkeeperResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.data);
  }

  response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  return response.status(200).json({
    generated_at: new Date().toISOString(),
    source,
    date: today,
    summary: aggregate.summary,
    leaders: {
      ...aggregate.leaders,
      topScorer: playerLeader(scorers, "goals"),
      topAssist: playerLeader(assists, "assists"),
      bestGoalkeeper: bestGoalkeeper(goalkeeperPayloads)
    },
    availability: {
      playerStats: playerStatsAvailable,
      message: providerMessage
    },
    notes: {
      bestMatchToday: "Partido con más goles del día; en empate, prima el marcador más ajustado.",
      bestGoalkeeper: "Mejor valoración entre los porteros que jugaron hoy.",
      goalkeeperFixturesLoaded: goalkeeperPayloads.length
    }
  });
};
