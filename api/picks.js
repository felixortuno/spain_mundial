/**
 * GET /api/picks — picks del modelo de análisis de cuotas.
 *
 * TRES NIVELES DE CALIDAD (degradación automática):
 *
 *  1. MODELO ML  — si PICKS_JSON está en env vars (JSON generado por predict.py).
 *                  Máxima precisión: LightGBM calibrado + calibración isotónica.
 *
 *  2. MERCADO    — si API_FOOTBALL_KEY + ODDS_API_KEY están disponibles.
 *                  Usa probabilidades de Pinnacle (fair odds quitando margen)
 *                  como señal del modelo. Sin Python, corre en Node.
 *
 *  3. DEMO       — datos sintéticos con partidos reales del Mundial 2026.
 *
 * Flujo de producción con modelo Python:
 *   python ml/predict.py --live --api-football-key ... --odds-api-key ...
 *   vercel env add PICKS_JSON          # pega el JSON generado
 *   vercel --prod
 *
 * NOTA DE SEGURIDAD: este endpoint no contiene secretos del modelo.
 * La lógica ML vive en el backend Python; aquí solo se distribuye el JSON.
 */

"use strict";

const { requireAnalysisAuth } = require("../lib/analysisAuth");

// ── Configuración ──────────────────────────────────────────────────────────────
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "0.02");
const KELLY_FRACTION = parseFloat(process.env.KELLY_FRACTION || "0.25");
const BANKROLL = parseFloat(process.env.BANKROLL || "1000");

// Casas apostables (Winamax/Bet365). Pinnacle se usa solo como referencia
// de probabilidad justa, nunca como casa para recomendar.
const APOSTABLE_HOUSES = (process.env.APOSTABLE_HOUSES || "Winamax,Bet365")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Diferencia mínima entre la casa cara y la barata para marcar discrepancia.
const DISCREPANCIA_MIN = parseFloat(process.env.DISCREPANCIA_MIN || "0.05"); // 5%

const BANDS = {
  baja_prob_30:  [0.22, 0.38],
  media_prob_55: [0.47, 0.63],
  alta_prob_75:  [0.67, 0.83],
};

const DISCLAIMER =
  "⚠ Estimaciones estadísticas, no garantías. Solo mayores de 18 años. " +
  "No es consejo financiero. Juega con responsabilidad — www.jugarbien.es";

// ── Demo data ──────────────────────────────────────────────────────────────────
const DEMO_PICKS = {
  generated_at: "2026-06-10T20:00:00Z",
  source: "demo",
  disclaimer: DISCLAIMER,
  picks: [
    {
      banda: "alta_prob_75",
      partido: "España vs Marruecos",
      fecha: "2026-06-14",
      mercado: "1X2 — Gana España",
      mejor_cuota: 1.46, casa: "Pinnacle",
      prob_modelo: 0.76, prob_implicita_justa: 0.69,
      edge_pp: 7.0, ev: 0.11,
      kelly_frac: 0.046, stake_kelly_eur: 46.0, stake_plano_eur: 10.0,
      banda_confianza: [0.72, 0.80], tiene_valor: true,
    },
    {
      banda: "media_prob_55",
      partido: "Francia vs Bélgica",
      fecha: "2026-06-16",
      mercado: "1X2 — Gana Francia",
      mejor_cuota: 2.10, casa: "Pinnacle",
      prob_modelo: 0.55, prob_implicita_justa: 0.49,
      edge_pp: 6.0, ev: 0.10,
      kelly_frac: 0.033, stake_kelly_eur: 33.0, stake_plano_eur: 10.0,
      banda_confianza: [0.51, 0.59], tiene_valor: true,
    },
    {
      banda: "baja_prob_30",
      partido: "Brasil vs México",
      fecha: "2026-06-15",
      mercado: "1X2 — Empate",
      mejor_cuota: 3.80, casa: "Bet365",
      prob_modelo: 0.31, prob_implicita_justa: 0.26,
      edge_pp: 5.0, ev: 0.086,
      kelly_frac: 0.018, stake_kelly_eur: 18.0, stake_plano_eur: 10.0,
      banda_confianza: [0.27, 0.35], tiene_valor: true,
    },
  ],
  combinadas: [
    {
      tipo: "combi_segura", disponible: true, casa: "Bet365",
      cuota_combinada: 2.04, prob_conjunta: 0.5624, ev: 0.149,
      stake_sugerido_eur: 15, correlacion_advertencia: null,
      selecciones: [
        { partido: "España vs Marruecos", mercado: "1X2 — Gana España", cuota: 1.46, prob: 0.76 },
        { partido: "Inglaterra vs Senegal", mercado: "1X2 — Gana Inglaterra", cuota: 1.40, prob: 0.74 },
      ],
    },
    {
      tipo: "combi_valor", disponible: true, casa: "Winamax",
      cuota_combinada: 4.62, prob_conjunta: 0.286, ev: 0.321,
      stake_sugerido_eur: 8, correlacion_advertencia: null,
      selecciones: [
        { partido: "Francia vs Bélgica", mercado: "1X2 — Gana Francia", cuota: 2.10, prob: 0.55 },
        { partido: "Brasil vs México", mercado: "1X2 — Gana Brasil", cuota: 2.20, prob: 0.52 },
      ],
    },
    {
      tipo: "combi_riesgo", disponible: true, casa: "Bet365",
      cuota_combinada: 11.04, prob_conjunta: 0.1254, ev: 0.384,
      stake_sugerido_eur: 5, correlacion_advertencia: null,
      selecciones: [
        { partido: "España vs Marruecos", mercado: "1X2 — Gana España", cuota: 1.46, prob: 0.76 },
        { partido: "Francia vs Bélgica", mercado: "1X2 — Gana Francia", cuota: 2.10, prob: 0.55 },
        { partido: "Portugal vs Uruguay", mercado: "1X2 — Empate", cuota: 3.60, prob: 0.30 },
      ],
    },
  ],
  errores_cuota: {
    discrepancias_casas: [
      {
        partido: "Brasil vs México", mercado: "1X2 — Empate",
        casa_cara: "Bet365", cuota_cara: 3.80,
        casa_barata: "Winamax", cuota_barata: 3.50, diferencia_pct: 8.6,
      },
    ],
    value_vs_fair: [
      {
        partido: "España vs Marruecos", mercado: "1X2 — Gana España",
        casa: "Winamax", mejor_cuota: 1.50, prob_justa: 0.69,
        edge_pp: 2.3, ev: 0.035,
      },
    ],
    surebets: [],
  },
  analitica_mercado: {
    overround_por_casa: {
      Bet365: 0.051, Winamax: 0.047, Pinnacle: 0.023,
    },
    mejor_casa_precio: "Winamax",
    nota: "Overround = margen de la casa sobre 1.0. Más bajo = cuotas más justas. " +
      "Pinnacle se muestra solo como referencia de cuota justa, no es apostable aquí.",
  },
};

// ── Helpers matemáticos ────────────────────────────────────────────────────────

function kellyFrac(prob, odd, fraction) {
  if (!odd || odd <= 1) return 0;
  const b = odd - 1;
  const k = (b * prob - (1 - prob)) / b;
  return Math.max(0, fraction * k);
}

function ev(prob, odd) {
  if (!odd || odd <= 1) return null;
  return round4(prob * (odd - 1) - (1 - prob));
}

function wilsonCI(prob, n = 500) {
  const z = 1.96;
  const denom = 1 + z ** 2 / n;
  const center = (prob + z ** 2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((prob * (1 - prob)) / n + z ** 2 / (4 * n ** 2))) / denom;
  return [
    Math.round(Math.max(0, center - margin) * 1000) / 1000,
    Math.round(Math.min(1, center + margin) * 1000) / 1000,
  ];
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// Banda de probabilidad a la que pertenece una prob (o null si cae en un hueco).
function bandOf(prob) {
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    if (prob >= lo && prob < hi) return name;
  }
  return null;
}

// ── Zona horaria Europe/Madrid y franjas (hoy / madrugada) ────────────────────

const REF_TZ = "Europe/Madrid";

// Componentes de fecha y hora de un instante en Europe/Madrid.
function madridParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: REF_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  let hora = Number(p.hour);
  if (hora === 24) hora = 0; // algunos entornos devuelven "24" a medianoche
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora, minuto: Number(p.minute) };
}

// Hora de inicio en horario español, "HH:MM".
function madridHora(fechaUtc) {
  const p = madridParts(fechaUtc);
  return p ? `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}` : null;
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Franja del partido en Europe/Madrid: "hoy" | "madrugada" | null.
// hoy = empieza hoy y aún no ha comenzado. madrugada = mañana 00:00–06:00.
function matchWindow(fechaUtc, now = new Date()) {
  if (!fechaUtc) return null;
  const start = new Date(fechaUtc);
  if (Number.isNaN(start.getTime()) || start <= now) return null; // inválido o ya empezó
  const sp = madridParts(start);
  const np = madridParts(now);
  if (!sp || !np) return null;
  if (sp.fecha === np.fecha) return "hoy";
  if (sp.fecha === addDays(np.fecha, 1) && sp.hora < 6) return "madrugada";
  return null;
}

// ¿El partido empieza hoy (Europe/Madrid) y aún no ha comenzado?
function isTodayRemaining(fechaUtc, now = new Date()) {
  return matchWindow(fechaUtc, now) === "hoy";
}

// Filtra un objeto casa->cuota a solo las casas apostables (Winamax/Bet365).
// Si ninguna está presente, devuelve todas para no perder la señal de valor.
function filterBettable(byHouse) {
  const filtered = {};
  for (const [house, odd] of Object.entries(byHouse)) {
    if (APOSTABLE_HOUSES.some((h) => h.toLowerCase() === house.toLowerCase())) {
      filtered[house] = odd;
    }
  }
  return Object.keys(filtered).length ? filtered : { ...byHouse };
}

// Mejor cuota apostable para un resultado, con la casa que la paga.
function bettableBest(byHouse) {
  let best = null;
  for (const [house, odd] of Object.entries(byHouse)) {
    if (Number.isFinite(odd) && odd > 1 && (!best || odd > best.cuota)) {
      best = { casa: house, cuota: odd };
    }
  }
  return best;
}

// Construye "patas": un resultado 1X2 por partido con la cuota de cada casa
// apostable, su prob. justa y la banda. Base común para picks/errores/combis.
function buildLegs(matches) {
  const legs = [];
  for (const match of matches) {
    const { local, visitante, fecha_utc, cuotas } = match;
    if (!cuotas) continue;
    const fairProbs = cuotas.prob_implicita_justa || {};
    const porCasa = cuotas.por_casa || {};
    const date = String(fecha_utc || "").slice(0, 10);
    const horaEs = madridHora(fecha_utc);
    const partido = `${local} vs ${visitante}`;
    const outcomes = [
      { key: "1", label: `Gana ${local}` },
      { key: "X", label: "Empate" },
      { key: "2", label: `Gana ${visitante}` },
    ];
    for (const { key, label } of outcomes) {
      const fairProb = fairProbs[key];
      if (!fairProb) continue;
      const byHouseAll = {};
      for (const [house, prices] of Object.entries(porCasa)) {
        const odd = Number(prices[key]);
        if (Number.isFinite(odd) && odd > 1) byHouseAll[house] = odd;
      }
      const byHouse = filterBettable(byHouseAll);
      const best = bettableBest(byHouse);
      legs.push({
        partido,
        fecha: date,
        hora_es: horaEs,
        mercado: `1X2 — ${label}`,
        key,
        fairProb: round4(fairProb),
        banda: bandOf(fairProb),
        byHouse, // solo casas apostables
        mejor_cuota: best ? round2(best.cuota) : null,
        casa: best ? best.casa : "—",
      });
    }

    // Mercados adicionales: línea principal de cada uno (la más cubierta).
    const mercados = cuotas.mercados || {};
    const ou = (mercados.over_under || [])[0];
    if (ou && ou.linea != null) {
      legs.push(...twoWayLegs(partido, date, horaEs, ou, {
        Over: `Over/Under ${ou.linea} — Más de ${ou.linea} goles`,
        Under: `Over/Under ${ou.linea} — Menos de ${ou.linea} goles`,
      }));
    }
    const btts = (mercados.btts || [])[0];
    if (btts) {
      legs.push(...twoWayLegs(partido, date, horaEs, btts, {
        Yes: "Ambos marcan — Sí",
        No: "Ambos marcan — No",
      }));
    }
    const hcp = (mercados.handicap || [])[0];
    if (hcp && hcp.linea != null) {
      legs.push(...twoWayLegs(partido, date, horaEs, hcp, {
        "1": `Hándicap asiático — ${local} -${hcp.linea}`,
        "2": `Hándicap asiático — ${visitante} +${hcp.linea}`,
      }));
    }
  }
  return legs;
}

// Anota la franja (hoy/madrugada) en las patas de un conjunto de partidos.
function legsForWindow(matches, franja) {
  const legs = buildLegs(matches);
  for (const leg of legs) leg.franja = franja;
  return legs;
}

// Convierte un mercado de dos vías (Over/Under, BTTS, hándicap) en patas,
// usando solo casas apostables y la mejor cuota de esas.
function twoWayLegs(partido, fecha, horaEs, market, labels) {
  const out = [];
  const fair = market.prob_implicita_justa || {};
  const porCasa = market.por_casa || {};
  for (const side of Object.keys(labels)) {
    const fairProb = fair[side];
    if (!fairProb) continue;
    const byHouseAll = {};
    for (const [house, prices] of Object.entries(porCasa)) {
      const odd = Number(prices[side]);
      if (Number.isFinite(odd) && odd > 1) byHouseAll[house] = odd;
    }
    const byHouse = filterBettable(byHouseAll);
    const best = bettableBest(byHouse);
    out.push({
      partido,
      fecha,
      hora_es: horaEs,
      mercado: labels[side],
      key: side,
      fairProb: round4(fairProb),
      banda: bandOf(fairProb),
      byHouse,
      mejor_cuota: best ? round2(best.cuota) : null,
      casa: best ? best.casa : "—",
    });
  }
  return out;
}

// ── Errores de cuota: discrepancias entre casas, value vs fair y surebets ──────

function detectOddsErrors(matches) {
  const discrepancias_casas = [];
  const value_vs_fair = [];
  const surebets = [];

  const legs = buildLegs(matches);
  const porPartido = {};
  for (const leg of legs) {
    (porPartido[leg.partido] ||= []).push(leg);
  }

  for (const leg of legs) {
    const houses = Object.entries(leg.byHouse);

    // 1) Discrepancia entre casas (casa cara vs casa barata).
    if (houses.length >= 2) {
      let max = null;
      let min = null;
      for (const [casa, cuota] of houses) {
        if (!max || cuota > max.cuota) max = { casa, cuota };
        if (!min || cuota < min.cuota) min = { casa, cuota };
      }
      const dif = (max.cuota - min.cuota) / min.cuota;
      if (dif >= DISCREPANCIA_MIN) {
        discrepancias_casas.push({
          partido: leg.partido,
          mercado: leg.mercado,
          casa_cara: max.casa,
          cuota_cara: round2(max.cuota),
          casa_barata: min.casa,
          cuota_barata: round2(min.cuota),
          diferencia_pct: round1(dif * 100),
        });
      }
    }

    // 2) Value vs fair: la mejor cuota apostable bate la prob. justa (Pinnacle).
    if (leg.mejor_cuota) {
      const edge = round4(leg.fairProb - 1 / leg.mejor_cuota);
      if (edge >= EDGE_THRESHOLD) {
        value_vs_fair.push({
          partido: leg.partido,
          mercado: leg.mercado,
          casa: leg.casa,
          mejor_cuota: round2(leg.mejor_cuota),
          prob_justa: leg.fairProb,
          edge_pp: round4(edge * 100),
          ev: ev(leg.fairProb, leg.mejor_cuota),
        });
      }
    }
  }

  // 3) Surebet por partido: suma de inversas de las mejores cuotas < 1.
  for (const [partido, ls] of Object.entries(porPartido)) {
    if (ls.length !== 3 || ls.some((l) => !l.mejor_cuota)) continue;
    const invSum = ls.reduce((acc, l) => acc + 1 / l.mejor_cuota, 0);
    if (invSum < 1) {
      surebets.push({
        partido,
        beneficio_pct: round2((1 / invSum - 1) * 100),
        reparto: ls.map((l) => ({
          mercado: l.mercado,
          casa: l.casa,
          cuota: round2(l.mejor_cuota),
          stake_pct: round1((1 / l.mejor_cuota / invSum) * 100),
        })),
      });
    }
  }

  value_vs_fair.sort((a, b) => b.edge_pp - a.edge_pp);
  return { discrepancias_casas, value_vs_fair, surebets };
}

// ── Combinadas: jugables en una sola casa (no se mezclan apps) ─────────────────

// Mejor casa que cubre TODAS las patas, con la cuota combinada (producto).
function combinedOddByHouse(legs) {
  const houses = new Set();
  legs.forEach((l) => Object.keys(l.byHouse).forEach((h) => houses.add(h)));
  let best = null;
  for (const house of houses) {
    if (!legs.every((l) => l.byHouse[house])) continue;
    const cuota = legs.reduce((acc, l) => acc * l.byHouse[house], 1);
    if (!best || cuota > best.cuota) best = { casa: house, cuota: round2(cuota) };
  }
  return best;
}

// Selecciona n patas de partidos DISTINTOS (1X2 del mismo partido es excluyente).
function pickDistinctMatches(legs, n) {
  const out = [];
  const used = new Set();
  for (const leg of legs) {
    if (used.has(leg.partido)) continue;
    out.push(leg);
    used.add(leg.partido);
    if (out.length === n) break;
  }
  return out.length === n ? out : null;
}

// Intenta de max a min patas, devolviendo la mayor combinación posible.
function pickRange(legs, min, max) {
  for (let n = max; n >= min; n--) {
    const sel = pickDistinctMatches(legs, n);
    if (sel) return sel;
  }
  return null;
}

function makeCombo(tipo, legs, stake) {
  if (!legs) {
    return {
      tipo,
      disponible: false,
      mensaje: "Sin selecciones suficientes en partidos distintos hoy.",
    };
  }
  const casa = combinedOddByHouse(legs);
  if (!casa) {
    return {
      tipo,
      disponible: false,
      mensaje: "Ninguna casa cubre todas las selecciones; no es jugable en una sola app.",
    };
  }
  const prob = round4(legs.reduce((acc, l) => acc * l.fairProb, 1));
  const evVal = round4(prob * (casa.cuota - 1) - (1 - prob));
  const partidos = legs.map((l) => l.partido);
  const correlacion = new Set(partidos).size !== partidos.length;
  return {
    tipo,
    disponible: true,
    casa: casa.casa,
    cuota_combinada: casa.cuota,
    prob_conjunta: prob,
    ev: evVal,
    stake_sugerido_eur: stake,
    correlacion_advertencia: correlacion
      ? "Selecciones del mismo partido: probabilidades correlacionadas, usa Bet Builder / Mi Combi."
      : null,
    selecciones: legs.map((l) => ({
      partido: l.partido,
      mercado: l.mercado,
      cuota: round2(l.byHouse[casa.casa]),
      prob: l.fairProb,
    })),
  };
}

function buildCombos(matches) {
  const legs = buildLegs(matches).filter((l) => l.mejor_cuota);
  const edgeOf = (l) => l.fairProb - 1 / l.mejor_cuota;

  // Combi segura: 2 patas de banda alta, mayor prob.
  const altas = legs
    .filter((l) => l.banda === "alta_prob_75")
    .sort((a, b) => b.fairProb - a.fairProb);

  // Combi valor: banda media con edge positivo vs fair.
  const medias = legs
    .filter((l) => l.banda === "media_prob_55" && edgeOf(l) >= EDGE_THRESHOLD)
    .sort((a, b) => edgeOf(b) - edgeOf(a));

  // Combi riesgo: al menos una banda baja, completada con media/alta.
  const bajas = legs
    .filter((l) => l.banda === "baja_prob_30")
    .sort((a, b) => b.fairProb - a.fairProb);
  const riesgoPool = [...bajas, ...medias, ...altas];

  return [
    makeCombo("combi_segura", pickRange(altas, 2, 2), 15),
    makeCombo("combi_valor", pickRange(medias, 2, 3), 8),
    makeCombo("combi_riesgo", pickRange(riesgoPool, 3, 4), 5),
  ];
}

// ── Supercuota: combinada estrella que cruza hoy + madrugada ───────────────────

const SUPERCUOTA_BAND_RANK = { alta_prob_75: 0, media_prob_55: 1, baja_prob_30: 2 };

function legEdge(leg) {
  return leg.mejor_cuota ? leg.fairProb - 1 / leg.mejor_cuota : -Infinity;
}

function supercuotaObject(version, legs, house, stake) {
  const cuota = round2(legs.reduce((acc, l) => acc * l.byHouse[house], 1));
  const prob = round4(legs.reduce((acc, l) => acc * l.fairProb, 1));
  const evVal = round4(prob * (cuota - 1) - (1 - prob));
  const franjas = new Set(legs.map((l) => l.franja));
  const partidos = legs.map((l) => l.partido);
  return {
    version,
    casa: house,
    cuota_total: cuota,
    prob_conjunta: prob,
    ev: evVal,
    con_valor: evVal > 0,
    cruza_franjas: franjas.has("hoy") && franjas.has("madrugada"),
    stake_sugerido_eur: stake,
    correlacion_advertencia: new Set(partidos).size !== partidos.length
      ? "Selecciones del mismo partido: correlacionadas (Bet Builder / Mi Combi)."
      : null,
    selecciones: legs.map((l) => ({
      franja: l.franja,
      hora_es: l.hora_es,
      partido: l.partido,
      mercado: l.mercado,
      cuota: round2(l.byHouse[house]),
      prob: l.fairProb,
    })),
  };
}

// Elige hasta maxN patas de partidos distintos jugables en `house`, con al
// menos una de hoy y una de la madrugada, priorizando banda alta/media + edge.
function pickSupercuotaLegs(hoyValue, madValue, house, maxN) {
  const has = (l) => l.byHouse[house];
  const rank = (l) => (SUPERCUOTA_BAND_RANK[l.banda] ?? 3);
  const sortFn = (a, b) => rank(a) - rank(b) || legEdge(b) - legEdge(a);
  const hoyP = hoyValue.filter(has).sort(sortFn);
  const madP = madValue.filter(has).sort(sortFn);
  if (!hoyP.length || !madP.length) return null;

  const chosen = [];
  const used = new Set();
  const take = (l) => { chosen.push(l); used.add(l.partido); };
  take(hoyP[0]);
  if (!used.has(madP[0].partido)) take(madP[0]);
  for (const leg of [...hoyP.slice(1), ...madP.slice(1)].sort(sortFn)) {
    if (chosen.length >= maxN) break;
    if (used.has(leg.partido)) continue;
    take(leg);
  }
  return chosen.length >= 2 ? chosen : null;
}

function buildSupercuota(hoyLegs, madrugadaLegs) {
  const value = (arr) => arr.filter((l) => l.mejor_cuota && legEdge(l) >= EDGE_THRESHOLD);
  const hoyValue = value(hoyLegs);
  const madValue = value(madrugadaLegs);
  if (!hoyValue.length || !madValue.length) {
    return {
      disponible: false,
      mensaje: "Necesita ≥1 selección con valor de hoy y ≥1 de la madrugada; falta valor en alguna franja.",
    };
  }

  const houses = new Set();
  [...hoyValue, ...madValue].forEach((l) => Object.keys(l.byHouse).forEach((h) => houses.add(h)));

  let best = null;
  for (const house of houses) {
    const legs = pickSupercuotaLegs(hoyValue, madValue, house, 5);
    if (!legs) continue;
    const obj = supercuotaObject("estrella", legs, house, 5);
    if (!best || obj.ev > best.obj.ev) best = { house, legs, obj };
  }
  if (!best) {
    return { disponible: false, mensaje: "Ninguna casa cubre selecciones de ambas franjas." };
  }

  // Versión segura: quita la pata de menor probabilidad (la más arriesgada).
  let version_segura = null;
  if (best.legs.length > 2) {
    const riskiest = [...best.legs].sort((a, b) => a.fairProb - b.fairProb)[0];
    const reduced = best.legs.filter((l) => l !== riskiest);
    version_segura = supercuotaObject("segura", reduced, best.house, 8);
  }

  // Versión premium: añade una pata de banda baja con valor (más cuota, más riesgo).
  let version_premium = null;
  const usados = new Set(best.legs.map((l) => l.partido));
  const baja = [...hoyValue, ...madValue]
    .filter((l) => l.banda === "baja_prob_30" && l.byHouse[best.house] && !usados.has(l.partido))
    .sort((a, b) => legEdge(b) - legEdge(a))[0];
  if (baja) {
    version_premium = supercuotaObject("premium", [...best.legs, baja], best.house, 3);
  }

  return { disponible: true, ...best.obj, version_segura, version_premium };
}

// ── Selección de picks (aplica bandas y edge) ──────────────────────────────────

function selectPicks(candidates) {
  const result = {};
  for (const [bandName, [lo, hi]] of Object.entries(BANDS)) {
    const inBand = candidates.filter(
      (c) => c.prob_modelo >= lo && c.prob_modelo < hi
    );
    if (!inBand.length) {
      result[bandName] = {
        banda: bandName,
        sin_valor: true,
        mensaje: "Sin picks con valor en esta banda hoy.",
      };
      continue;
    }
    const withValue = inBand.filter((c) => c.tiene_valor);
    const pool = withValue.length ? withValue : inBand;
    const best = pool.reduce((a, b) => (b.ev > a.ev ? b : a));
    result[bandName] = { ...best, banda: bandName };
  }
  return Object.values(result);
}

// ── Construye candidatos desde los matches unificados del orchestrator ─────────

function candidatesFromUnifiedMatches(matches, franja = null) {
  const candidates = [];

  for (const match of matches) {
    const { local, visitante, fecha_utc, cuotas } = match;
    if (!cuotas) continue;

    const fairProbs = cuotas.prob_implicita_justa || {};
    const bestPrices = cuotas.mejor_precio || {};
    const date = String(fecha_utc || "").slice(0, 10);
    const horaEs = madridHora(fecha_utc);

    const outcomes = [
      { key: "1", label: `Gana ${local}`, side: "H" },
      { key: "X", label: "Empate", side: "D" },
      { key: "2", label: `Gana ${visitante}`, side: "A" },
    ];

    for (const { key, label, side: _side } of outcomes) {
      const fairProb = fairProbs[key];
      if (!fairProb) continue;

      // En modo mercado: la "probabilidad del modelo" = fair prob de Pinnacle
      const probModelo = round4(fairProb);
      const bestInfo = bestPrices[key];
      if (!bestInfo || !bestInfo.cuota || bestInfo.cuota <= 1) continue;

      const odd = bestInfo.cuota;
      const edge = round4(probModelo - fairProb); // 0 en modo puro mercado
      const evVal = ev(probModelo, odd);
      const kf = round4(kellyFrac(probModelo, odd, KELLY_FRACTION));

      candidates.push({
        partido: `${local} vs ${visitante}`,
        fecha: date,
        hora_es: horaEs,
        franja,
        mercado: `1X2 — ${label}`,
        mejor_cuota: Math.round(odd * 100) / 100,
        casa: bestInfo.casa || "—",
        prob_modelo: probModelo,
        prob_implicita_justa: round4(fairProb),
        edge_pp: round4(edge * 100),
        ev: evVal,
        kelly_frac: kf,
        stake_kelly_eur: Math.round(kf * BANKROLL * 10) / 10,
        stake_plano_eur: 10,
        banda_confianza: wilsonCI(probModelo),
        tiene_valor: edge >= EDGE_THRESHOLD || evVal > 0,
      });
    }
  }

  return candidates;
}

// ── Analítica de mercado ───────────────────────────────────────────────────────

function marketAnalytics(matches) {
  const overroundAcc = {};
  const overroundCount = {};
  let bestBk = "—";
  let bestBkMin = Infinity;

  for (const match of matches) {
    const ov = match.cuotas?.overround_por_casa || {};
    for (const [bk, margin] of Object.entries(ov)) {
      overroundAcc[bk] = (overroundAcc[bk] || 0) + margin;
      overroundCount[bk] = (overroundCount[bk] || 0) + 1;
    }
  }

  const avgOverround = {};
  for (const bk of Object.keys(overroundAcc)) {
    const avg = overroundAcc[bk] / overroundCount[bk];
    avgOverround[bk] = round4(avg);
    if (avg < bestBkMin) {
      bestBkMin = avg;
      bestBk = bk;
    }
  }

  return {
    overround_por_casa: avgOverround,
    mejor_casa_precio: bestBk,
    nota: "Overround = margen de la casa sobre 1.0. Más bajo = cuotas más justas.",
  };
}

// ── Fetch en vivo (usa la misma infraestructura del orchestrator) ─────────────

// Picks + combinadas + errores de una franja concreta.
function buildFranja(matches, franja) {
  return {
    franja,
    partidos_analizados: matches.length,
    picks: selectPicks(candidatesFromUnifiedMatches(matches, franja)),
    combinadas: buildCombos(matches),
    errores_cuota: detectOddsErrors(matches),
  };
}

async function buildLivePicks() {
  const { buildUnifiedMatches } = require("../lib/orchestrator");

  // Ventana de fetch: hoy y mañana (la madrugada de mañana cae en esta franja).
  const now = new Date();
  const fromDate = now.toISOString().slice(0, 10);
  const data = await buildUnifiedMatches({ from: fromDate, to: addDays(fromDate, 1) });

  // Clasifica por franja en Europe/Madrid (ignora ya iniciados / fuera de franja).
  const hoyMatches = [];
  const madrugadaMatches = [];
  for (const match of data.matches) {
    const win = matchWindow(match.fecha_utc, now);
    if (win === "hoy") hoyMatches.push(match);
    else if (win === "madrugada") madrugadaMatches.push(match);
  }

  const franja_hoy = buildFranja(hoyMatches, "hoy");
  const franja_madrugada = buildFranja(madrugadaMatches, "madrugada");

  const hoyLegs = legsForWindow(hoyMatches, "hoy").filter((l) => l.mejor_cuota);
  const madrugadaLegs = legsForWindow(madrugadaMatches, "madrugada").filter((l) => l.mejor_cuota);
  const supercuota = buildSupercuota(hoyLegs, madrugadaLegs);

  return {
    generated_at: data.generatedAt,
    source: "live_market",
    zona_horaria: REF_TZ,
    disclaimer: DISCLAIMER,
    casas_apostables: APOSTABLE_HOUSES,
    // Compat: el nivel superior sigue exponiendo la franja de hoy.
    partidos_analizados: hoyMatches.length,
    picks: franja_hoy.picks,
    combinadas: franja_hoy.combinadas,
    errores_cuota: franja_hoy.errores_cuota,
    analitica_mercado: marketAnalytics([...hoyMatches, ...madrugadaMatches]),
    // Contrato del prompt: franjas + supercuota.
    franja_hoy,
    franja_madrugada,
    supercuota,
    analitica_por_franja: {
      hoy: marketAnalytics(hoyMatches),
      madrugada: marketAnalytics(madrugadaMatches),
    },
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Método no permitido");
  }

  if (!await requireAnalysisAuth(request, response)) return;

  if (request.method === "HEAD") {
    response.setHeader("Cache-Control", "private, no-store");
    return response.status(200).end();
  }

  // ── Nivel 1: ML model output (mejor calidad) ───────────────────────
  const picksEnv = process.env.PICKS_JSON;
  if (picksEnv) {
    try {
      const picks = JSON.parse(picksEnv);
      response.setHeader(
        "Cache-Control",
        "private, max-age=0, must-revalidate"
      );
      return response.status(200).json({ ...picks, source: "ml_model" });
    } catch {
      console.error("[picks] PICKS_JSON inválido; continuando con fallback.");
    }
  }

  // ── Nivel 2: Live market (Pinnacle fair odds como señal) ───────────
  const hasKeys =
    (process.env.APISPORTS_KEY || process.env.API_FOOTBALL_KEY) &&
    process.env.ODDS_API_KEY;

  if (hasKeys) {
    try {
      const result = await buildLivePicks();
      response.setHeader(
        "Cache-Control",
        "private, max-age=0, must-revalidate"
      );
      return response.status(200).json(result);
    } catch (err) {
      console.error("[picks] Error en live market; usando demo.", err.message);
    }
  }

  // ── Nivel 3: Demo ──────────────────────────────────────────────────
  response.setHeader(
    "Cache-Control",
    "private, max-age=0, must-revalidate"
  );
  return response.status(200).json(DEMO_PICKS);
};

// Expuesto para tests (no forma parte del contrato HTTP).
module.exports._internals = {
  bandOf,
  isTodayRemaining,
  matchWindow,
  madridHora,
  buildLegs,
  legsForWindow,
  detectOddsErrors,
  buildCombos,
  buildSupercuota,
};
