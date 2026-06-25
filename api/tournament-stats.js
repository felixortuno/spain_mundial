"use strict";

const { requireAnalysisAuth } = require("../lib/analysisAuth");
const { loadConfig } = require("../lib/config");
const { BallDontLieFifaProvider } = require("../lib/providers/ballDontLieFifaProvider");
const { FixturesIcsProvider } = require("../lib/providers/fixturesIcsProvider");
const {
  aggregateFixtures,
  bestGoalkeeper,
  localDate,
  playerLeader
} = require("../lib/tournamentStats");
const { collectWebStats } = require("../lib/webStats");

const TIME_ZONE = "Europe/Madrid";
const TOURNAMENT_FIXTURES = 104;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function teamNamesById(fixtures) {
  const names = new Map();
  for (const fixture of fixtures || []) {
    if (fixture.home?.id != null) names.set(String(fixture.home.id), fixture.home.name);
    if (fixture.away?.id != null) names.set(String(fixture.away.id), fixture.away.name);
  }
  return names;
}

function rosterLeader(rows, metric, namesByTeamId) {
  const leader = [...(rows || [])]
    .map((row) => ({
      id: row.player?.id ?? null,
      name: row.player?.name || "—",
      team: namesByTeamId.get(String(row.team_id)) || row.team?.name || "—",
      value: finiteNumber(row[metric]) || 0,
      appearances: finiteNumber(row.appearances) || 0
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) =>
      b.value - a.value ||
      b.appearances - a.appearances ||
      a.name.localeCompare(b.name)
    )[0];
  return leader || null;
}

async function collectBallDontLieStats(config) {
  if (!config.ballDontLieApiKey) return null;

  const provider = new BallDontLieFifaProvider({
    apiKey: config.ballDontLieApiKey,
    ...config.ballDontLie
  });
  const fixturesResult = await provider.getFixtures();
  const rostersResult = await provider.getRosters().catch((error) => {
    console.warn("[tournament-stats] rosters balldontlie no disponibles:", error.message);
    return null;
  });

  return {
    fixtures: fixturesResult.data,
    rosters: rostersResult?.data || []
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Método no permitido." });
  }
  if (!await requireAnalysisAuth(request, response)) return;
  if (request.method === "HEAD") {
    response.setHeader("Cache-Control", "private, no-store");
    return response.status(200).end();
  }

  const today = localDate(new Date(), TIME_ZONE);
  const config = loadConfig();

  let fixtures = [];
  let source = "web";
  let providerMessage = "";
  let playerRows = [];

  if (config.ballDontLieApiKey) {
    try {
      const balldontlie = await collectBallDontLieStats(config);
      if (balldontlie?.fixtures?.length) {
        fixtures = balldontlie.fixtures;
        playerRows = balldontlie.rosters;
        source = "balldontlie";
        providerMessage = playerRows.length
          ? "Datos de partidos y líderes de jugadores desde balldontlie."
          : "Datos de partidos desde balldontlie. Los líderes de jugadores no están disponibles con la respuesta actual.";
      }
    } catch (ballDontLieError) {
      console.warn("[tournament-stats] balldontlie no disponible:", ballDontLieError.message);
    }
  }

  if (!fixtures.length) {
    try {
      const web = await collectWebStats({
        today,
        timeZone: TIME_ZONE,
        expectedTotalFixtures: TOURNAMENT_FIXTURES
      });
      if (web.status === "ok") {
        response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
        return response.status(200).json({
          generated_at: new Date().toISOString(),
          source: "web",
          timezone: TIME_ZONE,
          date: today,
          summary: web.summary,
          leaders: web.leaders,
          fuentes: web.fuentes,
          no_encontrados: web.no_encontrados,
          discrepancias: web.discrepancias,
          availability: {
            playerStats: false,
            message:
              "Datos recolectados de fuentes públicas (Wikipedia + ESPN). " +
              "topAssist y bestGoalkeeper no están disponibles por esta vía."
          },
          notes: {
            bestMatchToday: "Partido con más goles del día; en empate, prima el marcador más ajustado.",
            confianza: "alta = marcador confirmado por Wikipedia y ESPN; media = una sola fuente; baja = discrepancia (ver discrepancias)."
          }
        });
      }
    } catch (webError) {
      console.warn("[tournament-stats] fallback web no disponible:", webError.message);
    }
  }

  if (!fixtures.length) {
    try {
      const fallback = await new FixturesIcsProvider().getFixtures();
      fixtures = fallback.data;
      source = "fixtur.es";
      providerMessage =
        "Datos de partidos mediante el feed de respaldo. Las estadísticas de jugadores no están disponibles por esta vía.";
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
  const namesByTeamId = teamNamesById(fixtures);

  response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  return response.status(200).json({
    generated_at: new Date().toISOString(),
    source,
    date: today,
    summary: aggregate.summary,
    leaders: {
      ...aggregate.leaders,
      topScorer: playerRows.length
        ? rosterLeader(playerRows, "goals", namesByTeamId)
        : playerLeader([], "goals"),
      topAssist: playerRows.length
        ? rosterLeader(playerRows, "assists", namesByTeamId)
        : playerLeader([], "assists"),
      bestGoalkeeper: bestGoalkeeper([])
    },
    availability: {
      playerStats: playerRows.length > 0,
      message: providerMessage
    },
    notes: {
      bestMatchToday: "Partido con más goles del día; en empate, prima el marcador más ajustado.",
      bestGoalkeeper: "Mejor valoración entre los porteros que jugaron hoy.",
      goalkeeperFixturesLoaded: 0
    }
  });
};
