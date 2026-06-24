"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWebStats, tallyTopScorer, reconcileMatches } = require("../lib/webStats");

const SOURCES = [{ page: "P", url: "https://en.wikipedia.org/wiki/P", partidos: 2 }];

const MATCHES = [
  {
    team1: "Spain", team2: "Morocco", score: { home: 3, away: 1 },
    status: "FT", date: "2026-06-24",
    scorers: [
      { name: "Lamine Yamal", team: "Spain", goals: 2 },
      { name: "Álvaro Morata", team: "Spain", goals: 1 },
      { name: "Achraf Hakimi", team: "Morocco", goals: 1 },
    ],
  },
  {
    team1: "France", team2: "Belgium", score: { home: 0, away: 0 },
    status: "FT", date: "2026-06-23",
    scorers: [],
  },
];

test("tallyTopScorer suma goles por jugador y elige el máximo", () => {
  const top = tallyTopScorer(MATCHES);
  assert.equal(top.name, "Lamine Yamal");
  assert.equal(top.value, 2);
  assert.equal(top.team, "Spain");
});

test("buildWebStats calcula KPIs de equipo y cumple el contrato del prompt", () => {
  const out = buildWebStats({
    matches: MATCHES,
    sources: SOURCES,
    today: "2026-06-24",
    expectedTotalFixtures: 104,
  });

  assert.equal(out.status, "ok");
  // 4 goles en 2 partidos
  assert.equal(out.summary.totalGoals, 4);
  assert.equal(out.summary.playedMatches, 2);
  assert.equal(out.summary.averageGoals, 2);
  assert.equal(out.summary.draws, 1); // Francia 0-0 Bélgica
  assert.equal(out.summary.goalsToday, 4); // solo el España-Marruecos es de hoy
  assert.equal(out.summary.totalFixtures, 104);

  // Validación del prompt: averageGoals = totalGoals / playedMatches
  assert.equal(out.summary.averageGoals, out.summary.totalGoals / out.summary.playedMatches);

  assert.equal(out.leaders.bestAttack.name, "Spain");
  assert.equal(out.leaders.biggestWin.match, "Spain vs Morocco");
  assert.equal(out.leaders.topScorer.name, "Lamine Yamal");

  // topAssist y bestGoalkeeper no son rellenables por esta vía
  assert.equal(out.leaders.topAssist.value, null);
  assert.equal(out.leaders.bestGoalkeeper.rating, null);
  assert.ok(out.no_encontrados.some((x) => x.startsWith("topAssist")));
  assert.ok(out.no_encontrados.some((x) => x.startsWith("bestGoalkeeper")));

  // Cada KPI con valor debe tener su entrada en fuentes (regla del prompt)
  const kpisConFuente = out.fuentes.map((f) => f.kpi);
  assert.ok(kpisConFuente.includes("topScorer"));
  assert.ok(kpisConFuente.includes("bestAttack"));
  for (const f of out.fuentes) {
    assert.ok(f.url && f.consultado && f.confianza);
  }
});

test("reconcileMatches eleva a alta si coinciden y marca discrepancia si no", () => {
  const primary = [
    { team1: "Spain", team2: "Morocco", score: { home: 3, away: 1 }, date: "2026-06-24" },
    { team1: "France", team2: "Belgium", score: { home: 0, away: 0 }, date: "2026-06-23" },
    { team1: "Brazil", team2: "Argentina", score: { home: 2, away: 1 }, date: "2026-06-22" },
  ];
  const secondary = [
    // Confirma España-Marruecos (orientación invertida y nombre alias)
    { team1: "Marruecos", team2: "España", score: { home: 1, away: 3 }, date: "2026-06-24" },
    // Discrepa en Brasil-Argentina
    { team1: "Brazil", team2: "Argentina", score: { home: 1, away: 1 }, date: "2026-06-22" },
    // Francia-Bélgica no está en ESPN → queda "media"
  ];
  const recon = reconcileMatches(primary, secondary);

  assert.equal(primary[0].confianza, "alta"); // confirmado pese a inversión/alias
  assert.equal(primary[1].confianza, "media"); // solo una fuente
  assert.equal(primary[2].confianza, "baja"); // discrepancia
  assert.equal(recon.discrepancias.length, 1);
  assert.equal(recon.discrepancias[0].partido, "Brazil vs Argentina");
  assert.ok(Math.abs(recon.confirmedRatio - 1 / 3) < 0.01);
});

test("buildWebStats con segunda fuente sube la confianza de los KPIs cruzados", () => {
  const matches = [
    { team1: "Spain", team2: "Morocco", score: { home: 5, away: 0 }, status: "FT", date: "2026-06-24",
      scorers: [{ name: "Lamine Yamal", team: "Spain", goals: 3 }] },
    { team1: "France", team2: "Belgium", score: { home: 2, away: 1 }, status: "FT", date: "2026-06-23", scorers: [] },
  ];
  const secondary = [
    { team1: "Spain", team2: "Morocco", score: { home: 5, away: 0 }, date: "2026-06-24" },
    { team1: "France", team2: "Belgium", score: { home: 2, away: 1 }, date: "2026-06-23" },
  ];
  const out = buildWebStats({
    matches,
    sources: [{ url: "https://en.wikipedia.org/wiki/P" }],
    secondaryMatches: secondary,
    secondarySource: { name: "ESPN", url: "https://site.api.espn.com/..." },
    today: "2026-06-24",
  });

  // biggestWin (España 5-0) está cross-confirmado → alta, con 2 entradas de fuente
  const big = out.fuentes.filter((f) => f.kpi === "biggestWin");
  assert.ok(big.some((f) => f.confianza === "alta"));
  assert.ok(big.some((f) => f.url.includes("wikipedia")));
  assert.ok(big.some((f) => f.url.includes("espn")));
  // topScorer sigue siendo media (solo Wikipedia aporta goleadores)
  assert.equal(out.fuentes.find((f) => f.kpi === "topScorer").confianza, "media");
  assert.equal(out.discrepancias.length, 0);
});

test("buildWebStats devuelve sin_partidos cuando no hay finalizados", () => {
  const out = buildWebStats({ matches: [], sources: [], today: "2026-06-24" });
  assert.equal(out.status, "sin_partidos");
  assert.equal(out.summary.totalGoals, null);
  assert.equal(out.leaders.topScorer.name, null);
});
