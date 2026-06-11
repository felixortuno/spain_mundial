"use strict";

const { requireAdmin } = require("../lib/adminAuth");
const { buildUnifiedMatches } = require("../lib/orchestrator");

function queryValue(request, key) {
  if (request.query?.[key] != null) return request.query[key];
  const url = new URL(request.url || "/", "https://local.invalid");
  return url.searchParams.get(key);
}

function publicError(error) {
  const configurationErrors = new Set([
    "MISSING_APISPORTS_KEY",
    "MISSING_ODDS_API_KEY"
  ]);
  return {
    status: configurationErrors.has(error.code) ? 503 : 502,
    body: {
      error: "No se pudieron construir los partidos unificados.",
      detail: error.message
    }
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Método no permitido" });
  }

  if (!requireAdmin(request, response)) return;

  if (request.method === "HEAD") {
    return response.status(200).end();
  }

  try {
    const data = await buildUnifiedMatches({
      league: queryValue(request, "league") || undefined,
      season: queryValue(request, "season") || undefined,
      from: queryValue(request, "from") || undefined,
      to: queryValue(request, "to") || undefined,
      sportKey: queryValue(request, "sportKey") || undefined,
      enrichment: queryValue(request, "enrichment") || undefined
    });
    response.setHeader("Cache-Control", "private, no-store");
    return response.status(200).json(data);
  } catch (error) {
    console.error("[unified-matches]", error);
    response.setHeader("Cache-Control", "no-store");
    const result = publicError(error);
    return response.status(result.status).json(result.body);
  }
};
