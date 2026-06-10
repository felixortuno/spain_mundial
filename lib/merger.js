"use strict";

const { normalizeTeamName } = require("./reconciler");

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function outcomeKey(name, homeName, awayName) {
  const normalized = normalizeTeamName(name).canonical;
  if (normalized === normalizeTeamName(homeName).canonical) return "1";
  if (normalized === normalizeTeamName(awayName).canonical) return "2";
  if (["draw", "empate", "tie"].includes(normalized)) return "X";
  return null;
}

function analyseBookmakers(oddsEvent, homeName, awayName) {
  const perBookmaker = {};
  const overroundByBookmaker = {};
  const fairSamples = { "1": [], X: [], "2": [] };
  const bestPrice = { "1": null, X: null, "2": null };

  for (const bookmaker of oddsEvent.bookmakers || []) {
    const market = bookmaker.markets?.find((item) => item.key === "h2h");
    if (!market) continue;

    const prices = {};
    for (const outcome of market.outcomes || []) {
      const key = outcomeKey(outcome.name, homeName, awayName);
      const price = Number(outcome.price);
      if (key && Number.isFinite(price) && price > 1) prices[key] = price;
    }
    if (!prices["1"] || !prices.X || !prices["2"]) continue;

    const implied = {
      "1": 1 / prices["1"],
      X: 1 / prices.X,
      "2": 1 / prices["2"]
    };
    const sum = implied["1"] + implied.X + implied["2"];
    const fair = {
      "1": implied["1"] / sum,
      X: implied.X / sum,
      "2": implied["2"] / sum
    };

    perBookmaker[bookmaker.title] = {
      key: bookmaker.key,
      actualizado: bookmaker.lastUpdate,
      "1": prices["1"],
      X: prices.X,
      "2": prices["2"]
    };
    overroundByBookmaker[bookmaker.title] = round(sum - 1);

    for (const key of ["1", "X", "2"]) {
      fairSamples[key].push(fair[key]);
      if (!bestPrice[key] || prices[key] > bestPrice[key].cuota) {
        bestPrice[key] = {
          cuota: prices[key],
          casa: bookmaker.title,
          key: bookmaker.key
        };
      }
    }
  }

  const fairProbability = {};
  for (const key of ["1", "X", "2"]) {
    const samples = fairSamples[key];
    fairProbability[key] = samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : null;
  }
  const total = Object.values(fairProbability).reduce(
    (sum, value) => sum + (value || 0),
    0
  );
  if (total > 0) {
    for (const key of ["1", "X", "2"]) {
      fairProbability[key] = round(fairProbability[key] / total);
    }
  }

  return {
    por_casa: perBookmaker,
    overround_por_casa: overroundByBookmaker,
    prob_implicita_justa: fairProbability,
    mejor_precio: bestPrice
  };
}

function internalMatchId(football) {
  const date = String(football.commenceTime || "").slice(0, 10);
  const home = normalizeTeamName(football.home.name).canonical;
  const away = normalizeTeamName(football.away.name).canonical;
  const slug = `${home}-${away}-${date}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `match-${football.id}`;
}

function mergeMatch({ football, odds, reconciliation }) {
  return {
    match_id_interno: internalMatchId(football),
    fecha_utc: football.commenceTime,
    local: football.home.name,
    visitante: football.away.name,
    fuente_ids: {
      api_football_fixture: football.id,
      odds_api_event: odds.id
    },
    competicion: football.competition,
    features: football.features,
    cuotas: analyseBookmakers(
      odds,
      football.home.name,
      football.away.name
    ),
    reconciliacion: {
      metodo: reconciliation.method === "exact" ? "exacto" : reconciliation.method,
      orientacion: reconciliation.orientation,
      confianza: round(reconciliation.confidence),
      diferencia_horaria_minutos: reconciliation.timeDeltaMinutes
    }
  };
}

function mergeMatches(matches) {
  return matches.map(mergeMatch);
}

module.exports = {
  analyseBookmakers,
  mergeMatch,
  mergeMatches,
  outcomeKey
};
