"use strict";

const { loadConfig } = require("../lib/config");
const { BallDontLieFifaProvider } = require("../lib/providers/ballDontLieFifaProvider");
const { fetchEspnLiveMatches } = require("../lib/sources/espnLiveMatches");

const MAX_LIVE_MATCHES = 6;

async function fetchBallDontLieLiveMatches() {
  const config = loadConfig();
  if (!config.ballDontLieApiKey) return null;

  const provider = new BallDontLieFifaProvider({
    apiKey: config.ballDontLieApiKey,
    ...config.ballDontLie
  });
  return provider.getLiveMatches({ maxMatches: MAX_LIVE_MATCHES });
}

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

  let ballDontLieError = null;
  try {
    const data = await fetchBallDontLieLiveMatches();
    if (data) return response.status(200).json(data);
  } catch (error) {
    ballDontLieError = error;
    console.warn("[live-matches] balldontlie no disponible; usando ESPN:", error.message);
  }

  try {
    const data = await fetchEspnLiveMatches({ maxMatches: MAX_LIVE_MATCHES });
    return response.status(200).json({
      ...data,
      fallback: ballDontLieError
        ? {
            from: "balldontlie",
            reason: ballDontLieError.message
          }
        : undefined
    });
  } catch (error) {
    console.error("[live-matches]", error);
    response.setHeader("Cache-Control", "no-store");
    return response.status(502).json({
      error: "No se pudieron actualizar los partidos en directo."
    });
  }
};
