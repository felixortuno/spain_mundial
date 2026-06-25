"use strict";

const { loadConfig } = require("./config");
const { BallDontLieFifaProvider } = require("./providers/ballDontLieFifaProvider");
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

  if (!options.oddsProvider && !config.ballDontLieApiKey && !config.oddsApiKey) {
    const error = new Error("Falta BALLDONTLIE_API_KEY u ODDS_API_KEY.");
    error.code = "MISSING_ODDS_API_KEY";
    throw error;
  }

  const ballDontLie = options.ballDontLieProvider ||
    (config.ballDontLieApiKey
      ? new BallDontLieFifaProvider({
          apiKey: config.ballDontLieApiKey,
          ...config.ballDontLie
        })
      : null);
  const fallbackFixtureProvider =
    options.fixtureFallbackProvider ||
    new FixturesIcsProvider();
  const fixtureProvider =
    options.fixtureProvider ||
    ballDontLie ||
    fallbackFixtureProvider;
  const fallbackOddsProvider =
    options.oddsFallbackProvider ||
    (config.oddsApiKey
      ? new OddsProvider({
          apiKey: config.oddsApiKey,
          ...config.odds
        })
      : null);
  const odds =
    options.oddsProvider ||
    ballDontLie ||
    fallbackOddsProvider;

  const fixturePromise = (async () => {
    let result;
    try {
      result = await fixtureProvider.getFixtures();
    } catch (error) {
      if (fixtureProvider !== ballDontLie || options.fixtureProvider) throw error;
      (options.logger || console).warn(
        "[orchestrator] balldontlie fixtures no disponible; usando Fixtur.es:",
        error.message
      );
      result = await fallbackFixtureProvider.getFixtures();
    }
    return {
      ...result,
      data: filterFixturesByDate(result.data, options.from, options.to)
    };
  })();

  const [fixtureResult, initialSportResult] = await Promise.all([
    fixturePromise,
    odds.resolveSportKey({
      sportKey: options.sportKey || config.odds.sportKey,
      titleHints: options.sportHints || config.odds.sportHints
    })
  ]);

  let sportResult = initialSportResult;
  let oddsResult;
  try {
    oddsResult = await odds.getOdds({
      sportKey: sportResult.sport.key,
      regions: options.regions || config.odds.regions,
      markets: options.markets || config.odds.markets
    });
  } catch (error) {
    if (odds !== ballDontLie || options.oddsProvider || !fallbackOddsProvider) {
      throw error;
    }
    (options.logger || console).warn(
      "[orchestrator] balldontlie odds no disponible; usando The Odds API:",
      error.message
    );
    sportResult = await fallbackOddsProvider.resolveSportKey({
      sportKey: options.sportKey || config.odds.sportKey,
      titleHints: options.sportHints || config.odds.sportHints
    });
    oddsResult = await fallbackOddsProvider.getOdds({
      sportKey: sportResult.sport.key,
      regions: options.regions || config.odds.regions,
      markets: options.markets || config.odds.markets
    });
  }

  const reconciliation = reconcileMatches(
    fixtureResult.data,
    oddsResult.data,
    {
      ...config.reconciliation,
      logger: options.logger || console
    }
  );

  const fixtureSource =
    fixtureResult.data[0]?.source ||
    fixtureResult.metadata?.provider ||
    "unknown";
  const matched = reconciliation.matches;

  return {
    generatedAt: new Date().toISOString(),
    competition: {
      oddsSport: sportResult.sport,
      fixturesSource: fixtureSource
    },
    sources: {
      fixtures: {
        provider: fixtureSource,
        request: requestSummary(fixtureResult)
      },
      oddsApi: {
        sports: requestSummary(sportResult.catalog),
        odds: requestSummary(oddsResult)
      }
    },
    matches: mergeMatches(matched),
    unmatched: reconciliation.unmatched,
    counts: {
      fixtures: fixtureResult.data.length,
      oddsApi: oddsResult.data.length,
      reconciled: matched.length,
      unmatchedFixtures: reconciliation.unmatched.fixtures.length,
      unmatchedOddsApi: reconciliation.unmatched.odds.length
    }
  };
}

module.exports = { buildUnifiedMatches };
