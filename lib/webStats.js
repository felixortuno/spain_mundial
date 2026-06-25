"use strict";

/**
 * Estadísticas del Mundial desde fuentes públicas: recolecta resultados de
 * Wikipedia, los corrobora con ESPN cuando es posible y produce los KPIs con
 * el contrato del prompt (summary, leaders, fuentes, no_encontrados, status).
 * Reutiliza aggregateFixtures para los KPIs de equipo y solo añade el goleador
 * por conteo directo.
 *
 * Limitaciones honestas de esta vía: las asistencias y las valoraciones de
 * portero no constan en las cajas de partido de Wikipedia → quedan en null y
 * se listan en no_encontrados.
 */

const { aggregateFixtures, localDate } = require("./tournamentStats");
const { normalizeTeamName } = require("./reconciler");
const { fetchWorldCupMatches } = require("./sources/wikipediaWorldCup");
const { fetchEspnMatchesForDates } = require("./sources/espnScoreboard");

const TOURNAMENT_FIXTURES = 104;
const CONFIRM_RATIO_ALTA = 0.6; // ≥60% de partidos confirmados → confianza alta

// ── Reconciliación entre fuentes ──────────────────────────────────────────────

function pairKey(a, b) {
  const ca = normalizeTeamName(a).canonical;
  const cb = normalizeTeamName(b).canonical;
  return [ca, cb].sort().join("|");
}

function dayDiff(d1, d2) {
  if (!d1 || !d2) return 99;
  return Math.abs((Date.parse(d1) - Date.parse(d2)) / 86400000);
}

// ¿Mismo marcador, considerando que las fuentes pueden invertir local/visitante?
function sameScore(primary, secondary) {
  const p1 = normalizeTeamName(primary.team1).canonical;
  const s1 = normalizeTeamName(secondary.team1).canonical;
  if (p1 === s1) {
    return (
      primary.score.home === secondary.score.home &&
      primary.score.away === secondary.score.away
    );
  }
  return (
    primary.score.home === secondary.score.away &&
    primary.score.away === secondary.score.home
  );
}

// Marca cada partido primario con confianza alta/baja/media cruzando con la
// fuente secundaria, y lista las discrepancias de marcador.
function reconcileMatches(primary, secondary) {
  const index = new Map();
  for (const event of secondary || []) {
    const key = pairKey(event.team1, event.team2);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(event);
  }

  const discrepancias = [];
  const confianzaByPair = new Map();
  let confirmed = 0;

  for (const match of primary) {
    const key = pairKey(match.team1, match.team2);
    const candidates = (index.get(key) || []).filter(
      (event) => dayDiff(match.date, event.date) <= 1
    );
    let confianza = "media"; // solo una fuente lo tiene
    if (candidates.length) {
      if (candidates.some((event) => sameScore(match, event))) {
        confianza = "alta"; // dos fuentes coinciden
        confirmed += 1;
      } else {
        confianza = "baja"; // discrepan
        const event = candidates[0];
        discrepancias.push({
          partido: `${match.team1} vs ${match.team2}`,
          wikipedia: `${match.score.home}-${match.score.away}`,
          espn: `${event.score.home}-${event.score.away}`,
        });
      }
    }
    match.confianza = confianza;
    confianzaByPair.set(key, confianza);
  }

  return {
    discrepancias,
    confianzaByPair,
    confirmedRatio: primary.length ? confirmed / primary.length : 0,
  };
}

function matchesToFixtures(matches) {
  return (matches || []).map((m, index) => ({
    id: `web-${index}`,
    home: { name: m.team1 },
    away: { name: m.team2 },
    commenceTime: m.date ? `${m.date}T12:00:00Z` : null,
    features: {
      goals: { home: m.score.home, away: m.score.away },
      status: { short: m.status || "FT" },
    },
  }));
}

function tallyTopScorer(matches) {
  const tally = new Map();
  for (const match of matches || []) {
    for (const scorer of match.scorers || []) {
      const existing = tally.get(scorer.name) || {
        name: scorer.name,
        team: scorer.team,
        value: 0,
      };
      existing.value += scorer.goals;
      tally.set(scorer.name, existing);
    }
  }
  const top = [...tally.values()].sort(
    (a, b) => b.value - a.value || a.name.localeCompare(b.name)
  )[0];
  return top
    ? { name: top.name, team: top.team, value: top.value, appearances: null }
    : null;
}

function emptyLeaders() {
  return {
    teamGoalsPerGame: { name: null, goalsFor: null, games: null, goalsPerGame: null },
    bestAttack: { name: null, goalsFor: null },
    bestDefense: { name: null, concededPerGame: null, cleanSheets: null },
    topScorer: { name: null, team: null, value: null, appearances: null },
    topAssist: { name: null, team: null, value: null },
    bestGoalkeeper: { name: null, team: null, rating: null, saves: null, cleanSheets: null },
    bestMatchToday: { match: null, score: null, totalGoals: null, date: null },
    highestScoringMatch: { match: null, score: null, totalGoals: null, date: null },
    biggestWin: { match: null, score: null, date: null },
  };
}

function emptySummary() {
  return {
    totalGoals: null,
    averageGoals: null,
    playedMatches: null,
    totalFixtures: null,
    goalsToday: null,
    draws: null,
    teamsWithCleanSheets: null,
  };
}

// Construye el payload del prompt a partir de partidos ya recolectados (puro).
// Si se pasa `secondaryMatches`, cruza fuentes para elevar la confianza.
function buildWebStats({
  matches,
  sources = [],
  secondaryMatches = null,
  secondarySource = null,
  today = localDate(new Date(), "Europe/Madrid"),
  timeZone = "Europe/Madrid",
  expectedTotalFixtures = TOURNAMENT_FIXTURES,
} = {}) {
  const fixtures = matchesToFixtures(matches);
  if (!fixtures.length) {
    return {
      status: "sin_partidos",
      summary: emptySummary(),
      leaders: emptyLeaders(),
      fuentes: [],
      no_encontrados: ["Sin partidos finalizados en las fuentes consultadas."],
      discrepancias: [],
    };
  }

  // Cruce con la segunda fuente (si la hay).
  const hasSecondary = Array.isArray(secondaryMatches) && secondaryMatches.length > 0;
  const recon = hasSecondary
    ? reconcileMatches(matches, secondaryMatches)
    : { discrepancias: [], confianzaByPair: new Map(), confirmedRatio: 0 };
  const globalConfianza =
    hasSecondary && recon.confirmedRatio >= CONFIRM_RATIO_ALTA ? "alta" : "media";
  const matchConfianza = (home, away) =>
    (home && away && recon.confianzaByPair.get(pairKey(home, away))) || globalConfianza;

  const aggregate = aggregateFixtures(fixtures, {
    today,
    timeZone,
    expectedTotalFixtures,
  });
  const topScorer = tallyTopScorer(matches);
  const url = sources.find((s) => s.url && !s.error)?.url || null;
  const url2 = secondarySource?.url || null;

  const fuentes = [];
  const pushFuente = (kpi, confianza) => {
    fuentes.push({ kpi, url, consultado: today, confianza });
    // Si está cross-confirmado, añade la entrada de la segunda fuente.
    if (confianza === "alta" && url2) {
      fuentes.push({ kpi, url: url2, consultado: today, confianza: "alta" });
    }
  };

  // KPIs agregados de todo el torneo → confianza global.
  for (const kpi of ["summary", "teamGoalsPerGame", "bestAttack", "bestDefense"]) {
    pushFuente(kpi, globalConfianza);
  }
  // KPIs ligados a un partido concreto → confianza de ese partido.
  const leaders = aggregate.leaders;
  pushFuente("highestScoringMatch", matchConfianza(leaders.highestScoringMatch?.home, leaders.highestScoringMatch?.away));
  pushFuente("biggestWin", matchConfianza(leaders.biggestWin?.home, leaders.biggestWin?.away));
  if (leaders.bestMatchToday) {
    pushFuente("bestMatchToday", matchConfianza(leaders.bestMatchToday.home, leaders.bestMatchToday.away));
  }

  const no_encontrados = [];
  if (topScorer) {
    // El goleador solo viene de Wikipedia → como mucho "media".
    fuentes.push({ kpi: "topScorer", url, consultado: today, confianza: "media" });
  } else {
    no_encontrados.push("topScorer: no se hallaron goleadores en las cajas de partido.");
  }
  no_encontrados.push("topAssist: las asistencias no constan en las fuentes web parseadas.");
  no_encontrados.push("bestGoalkeeper: sin valoraciones de portero en las fuentes web.");

  return {
    status: "ok",
    summary: aggregate.summary,
    leaders: {
      ...aggregate.leaders,
      topScorer: topScorer || emptyLeaders().topScorer,
      topAssist: emptyLeaders().topAssist,
      bestGoalkeeper: emptyLeaders().bestGoalkeeper,
    },
    fuentes,
    no_encontrados,
    discrepancias: recon.discrepancias,
  };
}

// Orquesta recolección (Wikipedia) + corroboración (ESPN) + construcción.
// Devuelve el payload o, si no hay nada utilizable, status "sin_partidos".
async function collectWebStats(options = {}) {
  const { matches, sources } = await fetchWorldCupMatches(
    options.fetch ? { fetchImpl: options.fetch } : {}
  );

  // Segunda fuente: ESPN para las fechas que Wikipedia ya reportó (acotado).
  let secondaryMatches = null;
  let secondarySource = null;
  const maxDates = Number(process.env.ESPN_MAX_DATES || 30);
  const dates = [...new Set(matches.map((m) => m.date).filter(Boolean))].slice(-maxDates);
  if (dates.length) {
    try {
      const espn = await fetchEspnMatchesForDates(
        dates,
        options.espnFetch ? { fetchImpl: options.espnFetch } : {}
      );
      secondaryMatches = espn.matches;
      secondarySource = espn.source;
    } catch {
      // La corroboración es opcional: sin ella, la confianza se queda en "media".
    }
  }

  return buildWebStats({
    matches,
    sources,
    secondaryMatches,
    secondarySource,
    today: options.today,
    timeZone: options.timeZone,
    expectedTotalFixtures: options.expectedTotalFixtures,
  });
}

module.exports = {
  matchesToFixtures,
  tallyTopScorer,
  reconcileMatches,
  buildWebStats,
  collectWebStats,
  emptyLeaders,
  emptySummary,
};
