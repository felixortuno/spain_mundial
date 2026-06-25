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
    mejor_precio: bestPrice,
    mercados: {
      over_under: analyseTwoWayMarket(
        oddsEvent.bookmakers || [],
        "totals",
        ["Over", "Under"],
        classifyTotals
      ),
      btts: analyseTwoWayMarket(
        oddsEvent.bookmakers || [],
        "btts",
        ["Yes", "No"],
        classifyBtts
      ),
      handicap: analyseTwoWayMarket(
        oddsEvent.bookmakers || [],
        "spreads",
        ["1", "2"],
        (outcome) => classifySpread(outcome, homeName, awayName)
      )
    }
  };
}

// ── Mercados de dos vías (Over/Under, BTTS, hándicap) ──────────────────────────
// Misma metodología que el 1X2: quita el overround por casa, promedia la prob.
// justa entre casas y guarda la mejor cuota. Soporta varias líneas (puntos).

function summariseTwoWay(perHousePrices, sides) {
  const [sa, sb] = sides;
  const por_casa = {};
  const overround_por_casa = {};
  const fairSamples = { [sa]: [], [sb]: [] };
  const bestPrice = { [sa]: null, [sb]: null };

  for (const [house, prices] of Object.entries(perHousePrices)) {
    const sum = 1 / prices[sa] + 1 / prices[sb];
    por_casa[house] = { [sa]: prices[sa], [sb]: prices[sb] };
    overround_por_casa[house] = round(sum - 1);
    fairSamples[sa].push(1 / prices[sa] / sum);
    fairSamples[sb].push(1 / prices[sb] / sum);
    for (const s of sides) {
      if (!bestPrice[s] || prices[s] > bestPrice[s].cuota) {
        bestPrice[s] = { cuota: prices[s], casa: house };
      }
    }
  }

  const prob = {};
  for (const s of sides) {
    const samples = fairSamples[s];
    prob[s] = samples.length
      ? samples.reduce((acc, value) => acc + value, 0) / samples.length
      : null;
  }
  const total = (prob[sa] || 0) + (prob[sb] || 0);
  if (total > 0) for (const s of sides) prob[s] = round(prob[s] / total);

  return {
    por_casa,
    overround_por_casa,
    prob_implicita_justa: prob,
    mejor_precio: bestPrice
  };
}

function analyseTwoWayMarket(bookmakers, marketKey, sides, classify) {
  const lines = {};
  for (const bookmaker of bookmakers) {
    const market = bookmaker.markets?.find((item) => item.key === marketKey);
    if (!market) continue;
    for (const outcome of market.outcomes || []) {
      const info = classify(outcome);
      if (!info || !sides.includes(info.side)) continue;
      const price = Number(outcome.price);
      if (!Number.isFinite(price) || price <= 1) continue;
      const lineKey = info.line == null ? "_" : String(info.line);
      lines[lineKey] ||= {};
      lines[lineKey][bookmaker.title] ||= {};
      lines[lineKey][bookmaker.title][info.side] = price;
    }
  }

  const result = [];
  for (const [lineKey, houses] of Object.entries(lines)) {
    const filtered = {};
    for (const [house, prices] of Object.entries(houses)) {
      // Solo casas que cotizan ambos lados de la misma línea.
      if (prices[sides[0]] && prices[sides[1]]) filtered[house] = prices;
    }
    if (!Object.keys(filtered).length) continue;
    result.push({
      linea: lineKey === "_" ? null : Number(lineKey),
      ...summariseTwoWay(filtered, sides)
    });
  }

  // Línea principal primero (la cotizada por más casas).
  result.sort(
    (a, b) => Object.keys(b.por_casa).length - Object.keys(a.por_casa).length
  );
  return result;
}

function classifyTotals(outcome) {
  const name = String(outcome.name || "").toLowerCase();
  const side = name.includes("over")
    ? "Over"
    : name.includes("under")
      ? "Under"
      : null;
  if (!side) return null;
  return { side, line: outcome.point == null ? null : Number(outcome.point) };
}

function classifyBtts(outcome) {
  const name = String(outcome.name || "").trim().toLowerCase();
  const side = ["yes", "si", "sí"].includes(name)
    ? "Yes"
    : name === "no"
      ? "No"
      : null;
  return side ? { side, line: null } : null;
}

function classifySpread(outcome, homeName, awayName) {
  const side = outcomeKey(outcome.name, homeName, awayName);
  if (side !== "1" && side !== "2") return null;
  // El local cubre -línea y el visitante +línea: agrupamos por valor absoluto.
  return {
    side,
    line: outcome.point == null ? null : Math.abs(Number(outcome.point))
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
      fixture: football.id,
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
