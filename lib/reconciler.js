"use strict";

const DEFAULT_ALIAS_GROUPS = [
  ["Spain", "España", "Espana"],
  ["Cape Verde", "Cabo Verde"],
  ["Saudi Arabia", "Arabia Saudí", "Arabia Saudita", "KSA"],
  [
    "South Korea",
    "Korea Republic",
    "Republic of Korea",
    "Korea South",
    "Corea del Sur"
  ],
  ["North Korea", "Korea DPR", "Corea del Norte"],
  ["United States", "USA", "US", "United States of America", "Estados Unidos"],
  ["England", "Inglaterra"],
  ["Germany", "Alemania"],
  ["France", "Francia"],
  ["Netherlands", "Países Bajos", "Paises Bajos", "Holanda"],
  ["Belgium", "Bélgica", "Belgica"],
  ["Croatia", "Croacia"],
  ["Morocco", "Marruecos"],
  ["Ivory Coast", "Costa de Marfil", "Côte d'Ivoire", "Cote d Ivoire"],
  ["Japan", "Japón", "Japon"],
  ["Czechia", "Czech Republic", "República Checa", "Republica Checa"]
];

const TEAM_SUFFIXES = new Set([
  "fc",
  "cf",
  "sc",
  "afc",
  "ac",
  "cd",
  "club",
  "national team",
  "seleccion"
]);
const METHOD_PRIORITY = { exact: 3, alias: 2, fuzzy: 1 };

function normalizeBasic(value) {
  let normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  normalized = normalized
    .replace(/^republic of\s+/, "")
    .replace(/\s+republic$/, "");

  for (const suffix of TEAM_SUFFIXES) {
    if (normalized.endsWith(` ${suffix}`)) {
      normalized = normalized.slice(0, -(suffix.length + 1)).trim();
    }
  }
  return normalized;
}

function buildAliasMap(aliasGroups = DEFAULT_ALIAS_GROUPS) {
  const aliases = new Map();
  for (const group of aliasGroups) {
    const canonical = normalizeBasic(group[0]);
    for (const name of group) aliases.set(normalizeBasic(name), canonical);
  }
  return aliases;
}

function normalizeTeamName(value, aliasGroups = DEFAULT_ALIAS_GROUPS) {
  const basic = normalizeBasic(value);
  const canonical = buildAliasMap(aliasGroups).get(basic) || basic;
  return {
    original: String(value || ""),
    basic,
    canonical,
    usedAlias: canonical !== basic
  };
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] +
          (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function teamMatch(leftName, rightName, aliasGroups, fuzzyThreshold) {
  const left = normalizeTeamName(leftName, aliasGroups);
  const right = normalizeTeamName(rightName, aliasGroups);

  if (left.basic === right.basic) {
    return { matched: true, method: "exact", confidence: 1 };
  }
  if (left.canonical === right.canonical) {
    return { matched: true, method: "alias", confidence: 0.98 };
  }

  const score = similarity(left.canonical, right.canonical);
  return {
    matched: score >= fuzzyThreshold,
    method: "fuzzy",
    confidence: score
  };
}

function orientationMatch(
  football,
  odds,
  { aliasGroups, fuzzyThreshold, orientation, deltaMinutes, timeWindowMinutes }
) {
  const swapped = orientation === "swapped";
  const home = teamMatch(
    football.home.name,
    swapped ? odds.awayTeam : odds.homeTeam,
    aliasGroups,
    fuzzyThreshold
  );
  const away = teamMatch(
    football.away.name,
    swapped ? odds.homeTeam : odds.awayTeam,
    aliasGroups,
    fuzzyThreshold
  );
  if (!home.matched || !away.matched) return null;

  const methods = [home.method, away.method];
  const method = methods.includes("fuzzy")
    ? "fuzzy"
    : methods.includes("alias")
      ? "alias"
      : "exact";
  const teamConfidence = (home.confidence + away.confidence) / 2;
  const timePenalty = (deltaMinutes / Math.max(1, timeWindowMinutes)) * 0.05;

  return {
    method,
    confidence: Math.max(0, Math.min(1, teamConfidence - timePenalty)),
    timeDeltaMinutes: Math.round(deltaMinutes * 10) / 10,
    orientation
  };
}

function compareReconciliation(left, right) {
  const methodDelta =
    METHOD_PRIORITY[right.method] - METHOD_PRIORITY[left.method];
  if (methodDelta) return methodDelta;

  const orientationDelta =
    Number(left.orientation === "swapped") -
    Number(right.orientation === "swapped");
  if (orientationDelta) return orientationDelta;

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta) return confidenceDelta;
  return left.timeDeltaMinutes - right.timeDeltaMinutes;
}

function matchCandidate(
  football,
  odds,
  { aliasGroups, fuzzyThreshold, timeWindowMinutes, allowSwapped }
) {
  const footballTime = Date.parse(football.commenceTime);
  const oddsTime = Date.parse(odds.commenceTime);
  if (!Number.isFinite(footballTime) || !Number.isFinite(oddsTime)) return null;

  const deltaMinutes = Math.abs(footballTime - oddsTime) / 60000;
  if (deltaMinutes > timeWindowMinutes) return null;

  const orientations = allowSwapped ? ["same", "swapped"] : ["same"];
  const matches = orientations
    .map((orientation) =>
      orientationMatch(football, odds, {
        aliasGroups,
        fuzzyThreshold,
        orientation,
        deltaMinutes,
        timeWindowMinutes
      })
    )
    .filter(Boolean)
    .sort(compareReconciliation);

  return matches[0] || null;
}

function reconcileMatches(
  footballFixtures,
  oddsEvents,
  {
    aliasGroups = DEFAULT_ALIAS_GROUPS,
    fuzzyThreshold = 0.86,
    timeWindowMinutes = 90,
    allowSwapped = true,
    logger = console
  } = {}
) {
  const availableOdds = new Set(oddsEvents.map((event) => event.id));
  const matches = [];
  const unmatchedFootball = [];

  for (const football of footballFixtures) {
    const candidates = oddsEvents
      .filter((odds) => availableOdds.has(odds.id))
      .map((odds) => ({
        odds,
        reconciliation: matchCandidate(football, odds, {
          aliasGroups,
          fuzzyThreshold,
          timeWindowMinutes,
          allowSwapped
        })
      }))
      .filter((candidate) => candidate.reconciliation)
      .sort((left, right) => {
        return compareReconciliation(
          left.reconciliation,
          right.reconciliation
        );
      });

    if (!candidates.length) {
      unmatchedFootball.push(football);
      continue;
    }

    const winner = candidates[0];
    availableOdds.delete(winner.odds.id);
    matches.push({
      football,
      odds: winner.odds,
      reconciliation: winner.reconciliation
    });
  }

  const unmatchedOdds = oddsEvents.filter((event) => availableOdds.has(event.id));
  if (unmatchedFootball.length || unmatchedOdds.length) {
    logger.warn("[reconciler] Partidos sin casar", {
      apiFootball: unmatchedFootball.map((fixture) => ({
        id: fixture.id,
        home: fixture.home.name,
        away: fixture.away.name,
        commenceTime: fixture.commenceTime
      })),
      oddsApi: unmatchedOdds.map((event) => ({
        id: event.id,
        home: event.homeTeam,
        away: event.awayTeam,
        commenceTime: event.commenceTime
      }))
    });
  }

  return {
    matches,
    unmatched: {
      football: unmatchedFootball,
      odds: unmatchedOdds
    }
  };
}

module.exports = {
  DEFAULT_ALIAS_GROUPS,
  normalizeBasic,
  normalizeTeamName,
  levenshteinDistance,
  similarity,
  compareReconciliation,
  reconcileMatches
};
