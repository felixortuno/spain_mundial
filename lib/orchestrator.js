"use strict";

const { loadConfig } = require("./config");
const { FootballProvider } = require("./providers/footballProvider");
const { FixturesIcsProvider } = require("./providers/fixturesIcsProvider");
const { OddsProvider } = require("./providers/oddsProvider");
const { reconcileMatches } = require("./reconciler");
const { mergeMatches } = require("./merger");

function requestSummary(result) {
  return {
    cache: result.cache,
    metadata: result.metadata
  };
}

function filterFixturesByDate(fixtures, from, to) {
  const fromTime = from ? Date.parse(`${from}T00:00:00Z`) : null;
  const toTime = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
  return fixtures.filter((fixture) => {
    const time = Date.parse(fixture.commenceTime);
    if (!Number.isFinite(time)) return false;
    if (Number.isFinite(fromTime) && time < fromTime) return false;
    if (Number.isFinite(toTime) && time > toTime) return false;
    return true;
  });
}

async function buildUnifiedMatches(options = {}) {
  const config = options.config || loadConfig();

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
  const fixtureFallback =
    options.fixtureFallbackProvider ||
    new FixturesIcsProvider();

  const fixturePromise = (async () => {
    if (options.footballProvider || config.apiSportsKey) {
      try {
        return await football.getFixtures({
          league: options.league || config.football.league,
          season: options.season || config.football.season,
          from: options.from,
          to: options.to
        });
      } catch (error) {
        (options.logger || console).warn(
          "[orchestrator] API-Football no disponible; usando Fixtur.es:",
          error.message
        );
      }
    }

    const result = await fixtureFallback.getFixtures();
    return {
      ...result,
      data: filterFixturesByDate(result.data, options.from, options.to)
    };
  })();

  const [fixtureResult, sportResult] = await Promise.all([
    fixturePromise,
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
  const fixtureSource =
    fixtureResult.data[0]?.source ||
    fixtureResult.metadata?.provider ||
    "unknown";
  let enrichment = { fixtures: matchedFixtures, requests: [] };
  if (fixtureSource === "api-football" && football?.enrichFixtures) {
    try {
      enrichment = await football.enrichFixtures(matchedFixtures, {
        league: options.league || config.football.league,
        season: options.season || config.football.season,
        mode: options.enrichment || config.football.enrichment,
        limit: config.football.enrichmentLimit
      });
    } catch (error) {
      (options.logger || console).warn(
        "[orchestrator] Enriquecimiento no disponible:",
        error.message
      );
    }
  }
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
      oddsSport: sportResult.sport,
      fixturesSource: fixtureSource
    },
    sources: {
      apiFootball: {
        provider: fixtureSource,
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
      fixtures: fixtureResult.data.length,
      oddsApi: oddsResult.data.length,
      reconciled: enrichedMatches.length,
      unmatchedApiFootball: reconciliation.unmatched.football.length,
      unmatchedOddsApi: reconciliation.unmatched.odds.length
    }
  };
}

module.exports = { buildUnifiedMatches };
