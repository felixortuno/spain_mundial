"use strict";

const { loadConfig } = require("./config");
const { FootballProvider } = require("./providers/footballProvider");
const { OddsProvider } = require("./providers/oddsProvider");
const { reconcileMatches } = require("./reconciler");
const { mergeMatches } = require("./merger");

function requestSummary(result) {
  return {
    cache: result.cache,
    metadata: result.metadata
  };
}

async function buildUnifiedMatches(options = {}) {
  const config = options.config || loadConfig();

  if (!options.footballProvider && !config.apiSportsKey) {
    const error = new Error(
      "Falta APISPORTS_KEY (o API_FOOTBALL_KEY por compatibilidad)."
    );
    error.code = "MISSING_APISPORTS_KEY";
    throw error;
  }
  if (!options.oddsProvider && !config.oddsApiKey) {
    const error = new Error("Falta ODDS_API_KEY.");
    error.code = "MISSING_ODDS_API_KEY";
    throw error;
  }

  const football =
    options.footballProvider ||
    new FootballProvider({
      apiKey: config.apiSportsKey,
      ...config.football
    });
  const odds =
    options.oddsProvider ||
    new OddsProvider({
      apiKey: config.oddsApiKey,
      ...config.odds
    });

  const [fixtureResult, sportResult] = await Promise.all([
    football.getFixtures({
      league: options.league || config.football.league,
      season: options.season || config.football.season,
      from: options.from,
      to: options.to
    }),
    odds.resolveSportKey({
      sportKey: options.sportKey || config.odds.sportKey,
      titleHints: options.sportHints || config.odds.sportHints
    })
  ]);

  const oddsResult = await odds.getOdds({
    sportKey: sportResult.sport.key,
    regions: options.regions || config.odds.regions,
    markets: options.markets || config.odds.markets
  });

  const reconciliation = reconcileMatches(
    fixtureResult.data,
    oddsResult.data,
    {
      ...config.reconciliation,
      logger: options.logger || console
    }
  );

  const matchedFixtures = reconciliation.matches.map((match) => match.football);
  const enrichment = await football.enrichFixtures(matchedFixtures, {
    league: options.league || config.football.league,
    season: options.season || config.football.season,
    mode: options.enrichment || config.football.enrichment,
    limit: config.football.enrichmentLimit
  });
  const enrichedById = new Map(
    enrichment.fixtures.map((fixture) => [fixture.id, fixture])
  );
  const enrichedMatches = reconciliation.matches.map((match) => ({
    ...match,
    football: enrichedById.get(match.football.id) || match.football
  }));

  return {
    generatedAt: new Date().toISOString(),
    competition: {
      apiFootballLeague: options.league || config.football.league,
      season: options.season || config.football.season,
      oddsSport: sportResult.sport
    },
    sources: {
      apiFootball: {
        fixtures: requestSummary(fixtureResult),
        enrichment: enrichment.requests.map((request) => ({
          endpoint: request.endpoint,
          fixtureId: request.fixtureId,
          cache: request.cache,
          metadata: request.metadata
        }))
      },
      oddsApi: {
        sports: requestSummary(sportResult.catalog),
        odds: requestSummary(oddsResult)
      }
    },
    matches: mergeMatches(enrichedMatches),
    unmatched: reconciliation.unmatched,
    counts: {
      apiFootball: fixtureResult.data.length,
      oddsApi: oddsResult.data.length,
      reconciled: enrichedMatches.length,
      unmatchedApiFootball: reconciliation.unmatched.football.length,
      unmatchedOddsApi: reconciliation.unmatched.odds.length
    }
  };
}

module.exports = { buildUnifiedMatches };
