"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _internals } = require("../api/picks");
const {
  bandOf,
  isTodayRemaining,
  matchWindow,
  buildLegs,
  legsForWindow,
  detectOddsErrors,
  buildCombos,
  buildSupercuota,
} = _internals;

// Construye un partido con cuotas por casa para los tres resultados.
function match(local, visitante, fechaUtc, porCasa, fair) {
  return {
    local,
    visitante,
    fecha_utc: fechaUtc,
    cuotas: {
      por_casa: porCasa,
      prob_implicita_justa: fair,
      mejor_precio: {},
      overround_por_casa: {},
    },
  };
}

test("bandOf clasifica por banda y devuelve null en los huecos", () => {
  assert.equal(bandOf(0.30), "baja_prob_30");
  assert.equal(bandOf(0.55), "media_prob_55");
  assert.equal(bandOf(0.75), "alta_prob_75");
  assert.equal(bandOf(0.42), null); // hueco entre baja y media
  assert.equal(bandOf(0.90), null); // favorito extremo, fuera de bandas
});

test("isTodayRemaining solo acepta partidos de hoy aún no empezados", () => {
  const now = new Date("2026-06-24T18:00:00Z");
  assert.equal(isTodayRemaining("2026-06-24T20:00:00Z", now), true);
  assert.equal(isTodayRemaining("2026-06-24T16:00:00Z", now), false); // ya empezó
  assert.equal(isTodayRemaining("2026-06-25T20:00:00Z", now), false); // otro día
  assert.equal(isTodayRemaining(null, now), false);
});

test("buildLegs usa solo casas apostables y la mejor cuota de esas", () => {
  const m = match(
    "España",
    "Marruecos",
    "2026-06-24T20:00:00Z",
    {
      Winamax: { "1": 1.50, X: 4.20, "2": 7.00 },
      Bet365: { "1": 1.46, X: 4.10, "2": 7.50 },
      Pinnacle: { "1": 1.55, X: 4.30, "2": 7.20 }, // no apostable: se ignora
    },
    { "1": 0.69, X: 0.22, "2": 0.09 }
  );
  const legs = buildLegs([m]);
  const local = legs.find((l) => l.key === "1");
  assert.equal(local.mejor_cuota, 1.50); // Winamax, no Pinnacle (1.55)
  assert.equal(local.casa, "Winamax");
  assert.equal("Pinnacle" in local.byHouse, false);
});

test("detectOddsErrors detecta discrepancia, value vs fair y surebet", () => {
  // Cuotas infladas para forzar una surebet (suma de inversas < 1).
  const m = match(
    "Brasil",
    "México",
    "2026-06-24T22:00:00Z",
    {
      Winamax: { "1": 3.50, X: 4.00, "2": 3.60 },
      Bet365: { "1": 3.80, X: 4.10, "2": 3.70 },
    },
    { "1": 0.34, X: 0.25, "2": 0.31 }
  );
  const { discrepancias_casas, value_vs_fair, surebets } = detectOddsErrors([m]);

  // Discrepancia en "Gana Brasil": 3.80 (Bet365) vs 3.50 (Winamax) ≈ 8.6%.
  const disc = discrepancias_casas.find((d) => d.mercado.includes("Brasil"));
  assert.ok(disc);
  assert.equal(disc.casa_cara, "Bet365");
  assert.equal(disc.casa_barata, "Winamax");
  assert.ok(disc.diferencia_pct >= 5);

  // Value vs fair: alguna pata con edge >= umbral.
  assert.ok(value_vs_fair.length >= 1);
  assert.ok(value_vs_fair[0].edge_pp >= 2);

  // 1/3.80 + 1/4.10 + 1/3.70 = 0.263+0.244+0.270 = 0.777 < 1 => surebet.
  assert.equal(surebets.length, 1);
  assert.ok(surebets[0].beneficio_pct > 0);
  const repartoSum = surebets[0].reparto.reduce((a, r) => a + r.stake_pct, 0);
  assert.ok(Math.abs(repartoSum - 100) < 0.5);
});

test("buildLegs incluye Over/Under, BTTS y hándicap además del 1X2", () => {
  const m = {
    local: "España",
    visitante: "Marruecos",
    fecha_utc: "2026-06-24T20:00:00Z",
    cuotas: {
      por_casa: { Bet365: { "1": 1.46, X: 4.10, "2": 7.50 } },
      prob_implicita_justa: { "1": 0.69, X: 0.22, "2": 0.09 },
      mejor_precio: {},
      overround_por_casa: {},
      mercados: {
        over_under: [{
          linea: 2.5,
          por_casa: { Bet365: { Over: 1.90, Under: 1.95 }, Winamax: { Over: 1.92, Under: 1.93 } },
          prob_implicita_justa: { Over: 0.50, Under: 0.50 },
        }],
        btts: [{
          linea: null,
          por_casa: { Bet365: { Yes: 1.80, No: 2.00 } },
          prob_implicita_justa: { Yes: 0.53, No: 0.47 },
        }],
        handicap: [{
          linea: 1.5,
          por_casa: { Bet365: { "1": 1.85, "2": 1.95 } },
          prob_implicita_justa: { "1": 0.51, "2": 0.49 },
        }],
      },
    },
  };
  const legs = buildLegs([m]);
  const mercados = legs.map((l) => l.mercado);
  assert.ok(mercados.some((x) => x.startsWith("1X2")));
  assert.ok(mercados.some((x) => x.startsWith("Over/Under 2.5")));
  assert.ok(mercados.some((x) => x.startsWith("Ambos marcan")));
  assert.ok(mercados.some((x) => x.startsWith("Hándicap asiático")));

  // En Over la mejor cuota apostable es Winamax (1.92 > 1.90 de Bet365).
  const over = legs.find((l) => l.mercado.includes("Más de 2.5"));
  assert.equal(over.casa, "Winamax");
  assert.equal(over.mejor_cuota, 1.92);
});

test("matchWindow clasifica franjas en Europe/Madrid e ignora ya iniciados", () => {
  const now = new Date("2026-06-24T18:00:00Z"); // 20:00 en Madrid (CEST)
  assert.equal(matchWindow("2026-06-24T20:00:00Z", now), "hoy"); // 22:00 hoy
  assert.equal(matchWindow("2026-06-24T16:00:00Z", now), null); // ya empezó
  assert.equal(matchWindow("2026-06-25T00:00:00Z", now), "madrugada"); // 02:00 de mañana
  assert.equal(matchWindow("2026-06-25T03:30:00Z", now), "madrugada"); // 05:30 de mañana
  assert.equal(matchWindow("2026-06-25T04:30:00Z", now), null); // 06:30, fuera de 00–06
  assert.equal(matchWindow("2026-06-25T18:00:00Z", now), null); // mañana por la tarde
});

// Fábrica de patas con valor (edge = fairProb - 1/odd ≥ umbral).
function leg(partido, franja, banda, fairProb, odd, house = "Bet365") {
  return {
    partido, franja, banda, fairProb, hora_es: "22:00",
    mercado: `1X2 — ${partido}`,
    byHouse: { [house]: odd }, mejor_cuota: odd,
  };
}

test("buildSupercuota cruza franjas y genera versiones segura/premium", () => {
  const hoyLegs = [
    leg("Spain", "hoy", "alta_prob_75", 0.75, 1.40),
    leg("Italy", "hoy", "alta_prob_75", 0.74, 1.42),
    leg("England", "hoy", "alta_prob_75", 0.73, 1.44),
    leg("Brazil", "hoy", "baja_prob_30", 0.30, 3.60),
  ];
  const madrugadaLegs = [
    leg("France", "madrugada", "alta_prob_75", 0.72, 1.45),
    leg("Argentina", "madrugada", "alta_prob_75", 0.71, 1.46),
  ];

  const sc = buildSupercuota(hoyLegs, madrugadaLegs);
  assert.equal(sc.disponible, true);
  assert.equal(sc.casa, "Bet365");
  assert.equal(sc.cruza_franjas, true); // al menos una de hoy y una de madrugada
  assert.equal(sc.selecciones.length, 5); // tope de selecciones
  // La segura quita la pata más arriesgada → una menos
  assert.equal(sc.version_segura.selecciones.length, 4);
  assert.ok(sc.version_segura.cuota_total < sc.cuota_total);
  // La premium añade la banda baja con valor → una más
  assert.equal(sc.version_premium.selecciones.length, 6);
  assert.ok(sc.version_premium.cuota_total > sc.cuota_total);
});

test("buildSupercuota no se construye si falta valor en una franja", () => {
  const hoyLegs = [leg("Spain", "hoy", "alta_prob_75", 0.75, 1.40)];
  const sc = buildSupercuota(hoyLegs, []); // sin madrugada
  assert.equal(sc.disponible, false);
  assert.match(sc.mensaje, /madrugada/);
});

test("buildCombos arma combis jugables en una sola casa y avisa si faltan datos", () => {
  const matches = [
    match("España", "Marruecos", "2026-06-24T20:00:00Z",
      { Bet365: { "1": 1.46, X: 4.10, "2": 7.50 } },
      { "1": 0.76, X: 0.16, "2": 0.08 }),
    match("Inglaterra", "Senegal", "2026-06-24T22:00:00Z",
      { Bet365: { "1": 1.40, X: 4.50, "2": 8.00 } },
      { "1": 0.74, X: 0.17, "2": 0.09 }),
  ];
  const combos = buildCombos(matches);
  const segura = combos.find((c) => c.tipo === "combi_segura");
  assert.equal(segura.disponible, true);
  assert.equal(segura.casa, "Bet365");
  assert.equal(segura.selecciones.length, 2);
  // cuota combinada = 1.46 * 1.40 = 2.044
  assert.ok(Math.abs(segura.cuota_combinada - 2.04) < 0.01);

  // Sin patas de banda media/baja => esas combis no están disponibles.
  const valor = combos.find((c) => c.tipo === "combi_valor");
  assert.equal(valor.disponible, false);
});
