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
  analitica_mercado: {
    overround_por_casa: {
      Bet365: 0.051, Pinnacle: 0.023, Bwin: 0.058, WilliamHill: 0.063,
    },
    mejor_casa_precio: "Pinnacle",
    nota: "Overround = margen de la casa sobre 1.0. Más bajo = cuotas más justas.",
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

function candidatesFromUnifiedMatches(matches) {
  const candidates = [];

  for (const match of matches) {
    const { local, visitante, fecha_utc, cuotas } = match;
    if (!cuotas) continue;

    const fairProbs = cuotas.prob_implicita_justa || {};
    const bestPrices = cuotas.mejor_precio || {};
    const date = String(fecha_utc || "").slice(0, 10);

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

async function buildLivePicks() {
  const { buildUnifiedMatches } = require("../lib/orchestrator");

  const data = await buildUnifiedMatches({
    from: new Date().toISOString().slice(0, 10),
    to: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });

  const candidates = candidatesFromUnifiedMatches(data.matches);
  const picks = selectPicks(candidates);
  const analytics = marketAnalytics(data.matches);

  return {
    generated_at: data.generatedAt,
    source: "live_market",
    disclaimer: DISCLAIMER,
    picks,
    analitica_mercado: analytics,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Método no permitido");
  }

  if (!requireAnalysisAuth(request, response)) return;

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
