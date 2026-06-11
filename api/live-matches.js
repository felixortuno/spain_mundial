"use strict";

const { loadConfig } = require("../lib/config");
const { isLiveStatus, buildLiveMatch } = require("../lib/liveMatches");
const { FootballProvider } = require("../lib/providers/footballProvider");

const TIME_ZONE = "Europe/Madrid";
const MAX_LIVE_MATCHES = 6;

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Método no permitido." });
  }

  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=60, stale-while-revalidate=240"
  );

  if (request.method === "HEAD") return response.status(200).end();

  const config = loadConfig();
  if (!config.apiSportsKey) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({
      error: "Los datos en directo no están configurados."
    });
  }

  const provider = new FootballProvider({
    apiKey: config.apiSportsKey,
    ...config.football,
    fixturesTtlMs: config.football.liveStatsTtlMs,
    detailTtlMs: config.football.liveStatsTtlMs
  });

  try {
    const fixtureResult = await provider.getFixtures({
      league: config.football.league,
      live: "all",
      timezone: TIME_ZONE
    });
    const liveFixtures = fixtureResult.data
      .filter((fixture) => isLiveStatus(fixture.features?.status?.short))
      .slice(0, MAX_LIVE_MATCHES);

    const matches = await Promise.all(liveFixtures.map(async (fixture) => {
      const [statisticsResult, eventsResult] = await Promise.allSettled([
        provider.getStatistics(fixture.id),
        provider.getEvents(fixture.id)
      ]);
      return buildLiveMatch(
        fixture,
        statisticsResult.status === "fulfilled" ? statisticsResult.value.data : [],
        eventsResult.status === "fulfilled" ? eventsResult.value.data : []
      );
    }));

    return response.status(200).json({
      generated_at: new Date().toISOString(),
      active: matches.length > 0,
      matches
    });
  } catch (error) {
    console.error("[live-matches]", error);
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      error: "No se pudieron actualizar los partidos en directo."
    });
  }
};
