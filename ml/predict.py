"""
Genera picks.json consumible por el frontend a partir del modelo entrenado.

Modos de uso:
─────────────────────────────────────────────────────────────────────────────
1. Demo (sin API keys):
       python ml/predict.py

2. CSV manual:
       python ml/predict.py --fixtures fixtures.csv

3. Live:
       Desactivado en este proyecto. Para producir picks reales, genera un CSV
       de fixtures/cuotas y usa el modo manual, o publica PICKS_JSON en Vercel.

─────────────────────────────────────────────────────────────────────────────
Columnas del CSV manual (modo 2):
    HomeTeam, AwayTeam, Date,
    B365H, B365D, B365A,   ← Bet365
    PSH, PSD, PSA,         ← Pinnacle apertura
    BWH, BWD, BWA,         ← Bwin
    IWH, IWD, IWA,         ← Interwetten
    WHH, WHD, WHA          ← WilliamHill
    [+ columnas de features opcionales: elo_diff, h_form_pts, ...]

Si el modelo no está entrenado (ml/models/ vacío) se usan estimaciones de demo.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

ROOT = Path(__file__).parent
MODELS_DIR = ROOT / "models"
OUTPUT_DEFAULT = ROOT.parent / "picks.json"

# Umbral y configuración (puede sobreescribirse con env vars)
EDGE_THRESHOLD = float(os.getenv("EDGE_THRESHOLD", "0.02"))
KELLY_FRACTION = float(os.getenv("KELLY_FRACTION", "0.25"))
BAND_TOLERANCE = float(os.getenv("BAND_TOLERANCE", "0.08"))
BANKROLL = float(os.getenv("BANKROLL", "1000"))

BANDS = {
    "baja_prob_30": (0.30 - BAND_TOLERANCE, 0.30 + BAND_TOLERANCE),
    "media_prob_55": (0.55 - BAND_TOLERANCE, 0.55 + BAND_TOLERANCE),
    "alta_prob_75": (0.75 - BAND_TOLERANCE, 0.75 + BAND_TOLERANCE),
}

ODD_COLS_H = ["B365H", "BWH", "IWH", "PSH", "WHH"]
ODD_COLS_D = ["B365D", "BWD", "IWD", "PSD", "WHD"]
ODD_COLS_A = ["B365A", "BWA", "IWA", "PSA", "WHA"]
FEATURE_COLS = [
    "elo_diff",
    "h_form_pts", "a_form_pts", "form_diff_pts",
    "h_form_gf", "a_form_gf", "form_diff_gf",
    "h_form_ga", "a_form_ga",
    "pin_fair_H", "pin_fair_D", "pin_fair_A",
    "move_H", "move_A",
    "overround",
]

BOOKMAKER_LABELS = {
    "B365H": "Bet365", "B365D": "Bet365", "B365A": "Bet365",
    "PSH": "Pinnacle", "PSD": "Pinnacle", "PSA": "Pinnacle",
    "BWH": "Bwin", "BWD": "Bwin", "BWA": "Bwin",
    "IWH": "Interwetten", "IWD": "Interwetten", "IWA": "Interwetten",
    "WHH": "WilliamHill", "WHD": "WilliamHill", "WHA": "WilliamHill",
}


# ── Carga del modelo ───────────────────────────────────────────────────────────

def load_model():
    model_path = MODELS_DIR / "lgbm_model.pkl"
    cal_path = MODELS_DIR / "calibrators.pkl"

    if not model_path.exists() or not cal_path.exists():
        return None, None

    with open(model_path, "rb") as f:
        model = pickle.load(f)
    with open(cal_path, "rb") as f:
        calibrators = pickle.load(f)
    return model, calibrators


# ── Datos de demo (Mundial 2026) ───────────────────────────────────────────────

DEMO_FIXTURES = [
    {
        "HomeTeam": "Spain", "AwayTeam": "Morocco",
        "Date": "2026-06-14",
        "B365H": 1.44, "B365D": 4.10, "B365A": 7.50,
        "PSH": 1.46, "PSD": 4.20, "PSA": 7.80,
        "BWH": 1.43, "BWD": 4.00, "BWA": 7.20,
        "IWH": 1.45, "IWD": 4.05, "IWA": 7.40,
        "WHH": 1.44, "WHD": 4.00, "WHA": 7.00,
        "PSCH": 1.48, "PSCD": 4.30, "PSCA": 8.00,
        # Features de contexto (normalmente derivadas del histórico)
        "elo_diff": 145, "h_form_pts": 2.4, "a_form_pts": 1.6,
        "form_diff_pts": 0.8, "h_form_gf": 2.0, "a_form_gf": 1.2,
        "form_diff_gf": 0.8, "h_form_ga": 0.6, "a_form_ga": 1.4,
    },
    {
        "HomeTeam": "Brazil", "AwayTeam": "Mexico",
        "Date": "2026-06-15",
        "B365H": 1.62, "B365D": 3.75, "B365A": 5.50,
        "PSH": 1.65, "PSD": 3.80, "PSA": 5.70,
        "BWH": 1.61, "BWD": 3.70, "BWA": 5.30,
        "IWH": 1.63, "IWD": 3.70, "IWA": 5.40,
        "WHH": 1.62, "WHD": 3.65, "WHA": 5.00,
        "PSCH": 1.68, "PSCD": 3.90, "PSCA": 5.80,
        "elo_diff": 88, "h_form_pts": 2.2, "a_form_pts": 1.8,
        "form_diff_pts": 0.4, "h_form_gf": 1.8, "a_form_gf": 1.4,
        "form_diff_gf": 0.4, "h_form_ga": 0.8, "a_form_ga": 1.2,
    },
    {
        "HomeTeam": "France", "AwayTeam": "Belgium",
        "Date": "2026-06-16",
        "B365H": 2.05, "B365D": 3.40, "B365A": 3.70,
        "PSH": 2.10, "PSD": 3.45, "PSA": 3.75,
        "BWH": 2.03, "BWD": 3.35, "BWA": 3.65,
        "IWH": 2.07, "IWD": 3.35, "IWA": 3.68,
        "WHH": 2.05, "WHD": 3.30, "WHA": 3.60,
        "PSCH": 2.12, "PSCD": 3.50, "PSCA": 3.80,
        "elo_diff": 22, "h_form_pts": 1.8, "a_form_pts": 1.7,
        "form_diff_pts": 0.1, "h_form_gf": 1.5, "a_form_gf": 1.6,
        "form_diff_gf": -0.1, "h_form_ga": 1.0, "a_form_ga": 1.1,
    },
    {
        "HomeTeam": "Argentina", "AwayTeam": "Ecuador",
        "Date": "2026-06-15",
        "B365H": 1.33, "B365D": 4.80, "B365A": 9.50,
        "PSH": 1.35, "PSD": 4.90, "PSA": 9.80,
        "BWH": 1.32, "BWD": 4.70, "BWA": 9.00,
        "IWH": 1.34, "IWD": 4.75, "IWA": 9.30,
        "WHH": 1.33, "WHD": 4.65, "WHA": 8.80,
        "PSCH": 1.37, "PSCD": 5.00, "PSCA": 10.00,
        "elo_diff": 210, "h_form_pts": 2.6, "a_form_pts": 1.4,
        "form_diff_pts": 1.2, "h_form_gf": 2.4, "a_form_gf": 1.0,
        "form_diff_gf": 1.4, "h_form_ga": 0.4, "a_form_ga": 1.6,
    },
    {
        "HomeTeam": "Portugal", "AwayTeam": "Uruguay",
        "Date": "2026-06-16",
        "B365H": 1.75, "B365D": 3.55, "B365A": 4.80,
        "PSH": 1.78, "PSD": 3.60, "PSA": 4.90,
        "BWH": 1.74, "BWD": 3.50, "BWA": 4.70,
        "IWH": 1.76, "IWD": 3.50, "IWA": 4.75,
        "WHH": 1.75, "WHD": 3.45, "WHA": 4.60,
        "PSCH": 1.80, "PSCD": 3.65, "PSCA": 5.00,
        "elo_diff": 55, "h_form_pts": 2.0, "a_form_pts": 1.9,
        "form_diff_pts": 0.1, "h_form_gf": 1.7, "a_form_gf": 1.5,
        "form_diff_gf": 0.2, "h_form_ga": 0.9, "a_form_ga": 1.0,
    },
]


# ── Construcción de features para inferencia ───────────────────────────────────

def _build_pin_features(row: pd.Series) -> dict:
    ph = 1.0 / row.get("PSH", np.nan) if row.get("PSH", np.nan) > 0 else np.nan
    pd_ = 1.0 / row.get("PSD", np.nan) if row.get("PSD", np.nan) > 0 else np.nan
    pa = 1.0 / row.get("PSA", np.nan) if row.get("PSA", np.nan) > 0 else np.nan
    s = sum(x for x in [ph, pd_, pa] if not math.isnan(x)) or np.nan

    return {
        "pin_fair_H": ph / s if s else np.nan,
        "pin_fair_D": pd_ / s if s else np.nan,
        "pin_fair_A": pa / s if s else np.nan,
        "move_H": (1.0 / row.get("B365H", np.nan) - ph / s) if s else np.nan,
        "move_A": (1.0 / row.get("B365A", np.nan) - pa / s) if s else np.nan,
        "overround": s if s else 1.05,
    }


def build_inference_features(df: pd.DataFrame) -> np.ndarray:
    rows = []
    for _, row in df.iterrows():
        pin = _build_pin_features(row)
        feat = {col: row.get(col, np.nan) for col in FEATURE_COLS}
        feat.update(pin)
        rows.append([feat.get(c, np.nan) for c in FEATURE_COLS])
    return np.array(rows, dtype=np.float32)


# ── Probabilidades de demo (sin modelo entrenado) ──────────────────────────────

def _demo_probs(df: pd.DataFrame) -> np.ndarray:
    """
    Estimación de probabilidades basada puramente en Pinnacle fair odds
    + ajuste de localía por diferencia ELO. Sustituto del modelo para demos.
    """
    probs = []
    for _, row in df.iterrows():
        pin = _build_pin_features(row)
        ph = pin.get("pin_fair_H", 0.45) or 0.45
        pd_ = pin.get("pin_fair_D", 0.28) or 0.28
        pa = pin.get("pin_fair_A", 0.27) or 0.27

        elo_adj = float(row.get("elo_diff", 0)) / 4000.0
        ph = min(max(ph + elo_adj, 0.05), 0.90)
        pa = min(max(pa - elo_adj, 0.05), 0.90)
        s = ph + pd_ + pa
        probs.append([pa / s, pd_ / s, ph / s])  # [A, D, H] → índices 0,1,2
    return np.array(probs)


# ── Análisis de cuotas ─────────────────────────────────────────────────────────

def _best_odd_info(row: pd.Series, cols: list[str]) -> tuple[float, str]:
    best, best_bk = np.nan, "—"
    for col in cols:
        v = row.get(col, np.nan)
        if pd.notna(v) and v > 1.0:
            if pd.isna(best) or v > best:
                best = v
                best_bk = BOOKMAKER_LABELS.get(col, col)
    return best, best_bk


def _market_analytics(df: pd.DataFrame) -> dict:
    overrounds: dict[str, list] = {}
    for _, row in df.iterrows():
        for bk_h, bk_d, bk_a, label in [
            ("B365H", "B365D", "B365A", "Bet365"),
            ("PSH", "PSD", "PSA", "Pinnacle"),
            ("BWH", "BWD", "BWA", "Bwin"),
            ("WHH", "WHD", "WHA", "WilliamHill"),
        ]:
            try:
                ov = sum(1.0 / row[c] for c in [bk_h, bk_d, bk_a] if pd.notna(row.get(c)) and row.get(c, 0) > 1)
                if ov > 0.8:
                    overrounds.setdefault(label, []).append(ov)
            except Exception:
                pass

    return {
        bk: round(float(np.mean(vals)) - 1.0, 4)
        for bk, vals in overrounds.items()
        if vals
    }


# ── Kelly ──────────────────────────────────────────────────────────────────────

def fractional_kelly(prob: float, odd: float, fraction: float = KELLY_FRACTION) -> float:
    if odd <= 1.0:
        return 0.0
    b = odd - 1.0
    k = (b * prob - (1 - prob)) / b
    return round(max(0.0, fraction * k), 4)


def confidence_interval(prob: float, n: int = 500) -> list[float]:
    """Wilson interval (95%)."""
    z = 1.96
    denom = 1 + z ** 2 / n
    center = (prob + z ** 2 / (2 * n)) / denom
    margin = (z * math.sqrt(prob * (1 - prob) / n + z ** 2 / (4 * n ** 2))) / denom
    return [round(max(0.0, center - margin), 3), round(min(1.0, center + margin), 3)]


# ── Selección de picks por banda ───────────────────────────────────────────────

def select_picks(df: pd.DataFrame, probs: np.ndarray) -> list[dict]:
    """
    Para cada fixture y resultado posible, calcula edge y EV.
    Agrupa en bandas y devuelve el pick de mayor EV por banda.
    """
    candidates: list[dict] = []

    for i, (_, row) in enumerate(df.iterrows()):
        p_arr = probs[i]  # [A, D, H]
        date_str = str(row.get("Date", ""))[:10]
        home = str(row.get("HomeTeam", "?"))
        away = str(row.get("AwayTeam", "?"))

        for outcome_idx, outcome_label, odd_cols, market_label in [
            (2, "H", ODD_COLS_H, f"Gana {home}"),
            (1, "D", ODD_COLS_D, "Empate"),
            (0, "A", ODD_COLS_A, f"Gana {away}"),
        ]:
            prob = float(p_arr[outcome_idx])
            best_odd, best_bk = _best_odd_info(row, odd_cols)
            if pd.isna(best_odd) or best_odd <= 1.0:
                continue

            pin_col = {"H": "pin_fair_H", "D": "pin_fair_D", "A": "pin_fair_A"}[outcome_label]
            pin = _build_pin_features(row).get(pin_col, np.nan)
            if pd.isna(pin) or pin <= 0:
                continue

            edge = round(prob - pin, 4)
            ev = round(prob * (best_odd - 1) - (1 - prob), 4)
            kelly = fractional_kelly(prob, best_odd)
            ci = confidence_interval(prob)

            candidates.append({
                "partido": f"{home} vs {away}",
                "fecha": date_str,
                "mercado": f"1X2 — {market_label}",
                "outcome": outcome_label,
                "mejor_cuota": round(best_odd, 2),
                "casa": best_bk,
                "prob_modelo": round(prob, 4),
                "prob_implicita_justa": round(pin, 4),
                "edge_pp": round(edge * 100, 2),
                "ev": ev,
                "kelly_frac": kelly,
                "stake_kelly_eur": round(kelly * BANKROLL, 1),
                "stake_plano_eur": 10.0,
                "banda_confianza": ci,
                "tiene_valor": edge >= EDGE_THRESHOLD,
            })

    picks_by_band: dict[str, dict | None] = {b: None for b in BANDS}

    for band_name, (lo, hi) in BANDS.items():
        in_band = [c for c in candidates if lo <= c["prob_modelo"] < hi]
        if not in_band:
            picks_by_band[band_name] = {
                "banda": band_name,
                "sin_valor": True,
                "mensaje": "Sin picks con valor en esta banda hoy.",
            }
            continue

        with_value = [c for c in in_band if c["tiene_valor"]]
        pool = with_value or in_band
        best = max(pool, key=lambda c: c["ev"])
        best["banda"] = band_name
        picks_by_band[band_name] = best

    return list(picks_by_band.values())


# ── Salida JSON ────────────────────────────────────────────────────────────────

def build_output(df: pd.DataFrame, probs: np.ndarray, is_demo: bool) -> dict:
    picks = select_picks(df, probs)
    market = _market_analytics(df)

    best_bk = min(market, key=market.get) if market else "—"

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "is_demo": is_demo,
        "disclaimer": (
            "⚠ Estimaciones estadísticas, no garantías. "
            "Solo mayores de 18 años. No es consejo financiero. "
            "Juega con responsabilidad — www.jugarbien.es"
        ),
        "picks": picks,
        "analitica_mercado": {
            "overround_por_casa": market,
            "mejor_casa_precio": best_bk,
            "nota": (
                "Overround = margen de la casa sobre 1.0. "
                "Más bajo = cuotas más justas."
            ),
        },
    }


# ── Live fetch ─────────────────────────────────────────────────────────────────

# Mapping bookmaker keys (The Odds API) → prefijo de columna de cuotas
_BK_PREFIX: dict[str, str] = {
    "bet365": "B365",
    "pinnacle": "PS",
    "bwin": "BW",
    "william_hill": "WH",
    "unibet_eu": "IW",       # proxy razonable
    "betfair_ex_eu": None,   # solo exchange, cuotas distintas
}


def fetch_odds_api(api_key: str, sport: str = "soccer_fifa_world_cup") -> list[dict]:
    """
    Devuelve eventos h2h del Mundial desde The Odds API.
    Normaliza al formato que espera from_odds().
    """
    import urllib.request

    url = (
        f"https://api.the-odds-api.com/v4/sports/{sport}/odds/"
        f"?apiKey={api_key}&regions=eu&markets=h2h&dateFormat=iso&oddsFormat=decimal"
    )
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _extract_h2h_odds(event: dict, home_team: str, away_team: str) -> dict:
    """
    Extrae cuotas H/D/A de un evento de The Odds API.
    Devuelve un dict con columnas tipo B365H, B365D, B365A, PSH, ...
    """
    from reconciler import canonical_team  # importación local para no contaminar el top-level

    home_c = canonical_team(home_team)
    away_c = canonical_team(away_team)
    row: dict[str, float] = {}

    for bk in event.get("bookmakers", []):
        prefix = _BK_PREFIX.get(bk["key"])
        if prefix is None:
            continue
        for market in bk.get("markets", []):
            if market["key"] != "h2h":
                continue
            odds_map: dict[str, float] = {}
            for outcome in market.get("outcomes", []):
                name = outcome["name"]
                price = float(outcome["price"])
                if name == "Draw":
                    odds_map["D"] = price
                elif canonical_team(name) == home_c:
                    odds_map["H"] = price
                elif canonical_team(name) == away_c:
                    odds_map["A"] = price
            for side in ("H", "D", "A"):
                if side in odds_map:
                    row[f"{prefix}{side}"] = odds_map[side]
    return row


def reconciled_to_dataframe(
    matched: list,     # list[MatchResult] from reconciler.reconcile()
) -> pd.DataFrame:
    """
    Convierte los partidos reconciliados en el DataFrame de features
    que espera build_inference_features() / select_picks().

    Columnas de cuotas: rellenadas desde The Odds API vía _extract_h2h_odds().
    Columnas de features (ELO, forma): a 0.0 cuando no disponibles — el modelo
    usa las probabilidades de Pinnacle como señal principal en ese caso.
    """
    rows = []
    for m in matched:
        fb = m.football
        od = m.odds

        home = fb.home if m.orientation == "same" else fb.away
        away = fb.away if m.orientation == "same" else fb.home

        base = {
            "HomeTeam": home,
            "AwayTeam": away,
            "Date": fb.kickoff.date().isoformat(),
            # Features de contexto: neutrales cuando no hay histórico
            "elo_diff": 0.0,
            "h_form_pts": 1.5, "a_form_pts": 1.5,
            "form_diff_pts": 0.0,
            "h_form_gf": 1.2, "a_form_gf": 1.2,
            "form_diff_gf": 0.0,
            "h_form_ga": 1.2, "a_form_ga": 1.2,
        }

        # Cuotas desde The Odds API
        odds_row = _extract_h2h_odds(od.raw, home, away)
        base.update(odds_row)

        # Metadatos de reconciliación para trazabilidad
        base["_reconcile_method"] = m.method
        base["_reconcile_conf"] = m.confidence
        base["_fixture_id"] = fb.id
        base["_event_id"] = od.id

        rows.append(base)

    return pd.DataFrame(rows)


def _print_reconcile_report(matched: list, un_fb: list, un_od: list) -> None:
    print(f"\n── Reconciliación ──────────────────────────────────────")
    print(f"  Emparejados: {len(matched)}")
    for m in matched:
        flag = " [⚠ orientación invertida]" if m.orientation == "swapped" else ""
        print(f"    ✓ {m.football.label()} · método={m.method} conf={m.confidence}{flag}")
    if un_fb:
        print(f"  Sin cuotas ({len(un_fb)} fixtures):")
        for f in un_fb:
            print(f"    – {f.label()}  (fixture_id={f.id})")
    if un_od:
        print(f"  Sin fixture ({len(un_od)} eventos de cuotas):")
        for o in un_od:
            print(f"    – {o.label()}  (event_id={o.id})")
    print()


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Genera picks.json para el frontend de análisis de cuotas."
    )
    parser.add_argument("--fixtures", type=str, default=None,
                        help="CSV con fixtures y cuotas (modo manual)")
    parser.add_argument("--live", action="store_true",
                        help="Modo live desactivado; usa --fixtures o PICKS_JSON")
    parser.add_argument("--odds-api-key", type=str,
                        default=os.getenv("ODDS_API_KEY"),
                        help="API key de The Odds API (o env ODDS_API_KEY)")
    parser.add_argument("--days-ahead", type=int, default=2,
                        help="Días hacia adelante para fetch de fixtures (default 2)")
    parser.add_argument("--output", type=str, default=str(OUTPUT_DEFAULT))
    args = parser.parse_args()

    model, calibrators = load_model()
    is_demo = model is None

    # ── Cargar fixtures ────────────────────────────────────────────────
    df: pd.DataFrame | None = None

    if args.live:
        print("✗ --live está desactivado. Usa --fixtures CSV o publica PICKS_JSON en Vercel.")
        sys.exit(1)

    elif args.fixtures:
        df = pd.read_csv(args.fixtures)
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce")

    else:
        df = pd.DataFrame(DEMO_FIXTURES)
        df["Date"] = pd.to_datetime(df["Date"])
        if is_demo:
            print("⚠ Modelo no encontrado. Ejecuta train.py primero. Usando estimaciones de demo.")

    # ── Inferencia ─────────────────────────────────────────────────────
    if model is not None:
        X = build_inference_features(df)
        raw = model.predict(X)
        probs = np.column_stack([c.predict(raw[:, i]) for i, c in enumerate(calibrators)])
        row_sums = probs.sum(axis=1, keepdims=True).clip(min=1e-9)
        probs = probs / row_sums
    else:
        probs = _demo_probs(df)

    output = build_output(df, probs, is_demo)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"✓ picks.json escrito en {out_path}")
    for p in output["picks"]:
        if p.get("sin_valor"):
            print(f"  [{p['banda']}] Sin valor hoy")
        else:
            print(
                f"  [{p['banda']}] {p['partido']} · {p['mercado']} "
                f"· prob {p['prob_modelo']:.0%} · edge {p['edge_pp']:+.1f}pp · EV {p['ev']:+.3f}"
            )


if __name__ == "__main__":
    main()
