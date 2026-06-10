"""
Entrena LightGBM para predicción 1X2 en fútbol + calibración isotónica.
Fuente: football-data.co.uk (gratuito, sin registro).
Split temporal estricto — nunca aleatorio.

Uso:
    python ml/train.py [--seasons N]   # N últimas temporadas (default: todas)
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import warnings
from io import StringIO
from pathlib import Path

import lightgbm as lgb
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import requests
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss

warnings.filterwarnings("ignore")

# ── Rutas ─────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
DATA_DIR.mkdir(exist_ok=True)
MODELS_DIR.mkdir(exist_ok=True)

# ── Fuentes de datos ───────────────────────────────────────────────────────────
# Ligas: Premier League, La Liga, Bundesliga, Serie A, Ligue 1
LEAGUE_CODES = ["E0", "SP1", "D1", "I1", "F1"]
# Temporadas de la 16/17 a la 24/25
ALL_SEASONS = [f"{y % 100:02d}{(y+1) % 100:02d}" for y in range(2016, 2025)]
BASE_URL = "https://www.football-data.co.uk/mmz4281/{season}/{league}.csv"

# ── Parámetros configurables ───────────────────────────────────────────────────
CONFIG = {
    "train_end_season": "2223",   # incluye esta temporada en train
    "val_season": "2324",         # val = calibración
    "test_season": "2425",        # test = backtest final
    "edge_threshold": 0.02,       # edge mínimo para pick con valor
    "band_a": (0.22, 0.38),       # banda ~30%
    "band_b": (0.47, 0.63),       # banda ~55%
    "band_c": (0.67, 0.83),       # banda ~75%
    "kelly_fraction": 0.25,       # Kelly fraccionado
    "bankroll": 1000.0,
    "flat_stake": 10.0,
}

# ── Columnas de cuotas disponibles ────────────────────────────────────────────
ODD_COLS_H = ["B365H", "BWH", "IWH", "PSH", "WHH"]
ODD_COLS_D = ["B365D", "BWD", "IWD", "PSD", "WHD"]
ODD_COLS_A = ["B365A", "BWA", "IWA", "PSA", "WHA"]
CLOSE_H = "PSCH"   # Pinnacle cierre — la cuota "inteligente"
CLOSE_D = "PSCD"
CLOSE_A = "PSCA"

ELO_K = 32
ELO_INITIAL = 1500


# ── Descarga de datos ──────────────────────────────────────────────────────────

def _download_csv(league: str, season: str) -> pd.DataFrame | None:
    cache = DATA_DIR / f"{league}_{season}.csv"
    if cache.exists():
        try:
            return pd.read_csv(cache, encoding="latin-1", on_bad_lines="skip")
        except Exception:
            cache.unlink(missing_ok=True)

    url = BASE_URL.format(season=season, league=league)
    try:
        resp = requests.get(url, timeout=20)
        if resp.status_code != 200:
            return None
        cache.write_bytes(resp.content)
        return pd.read_csv(StringIO(resp.text), encoding="latin-1", on_bad_lines="skip")
    except Exception as exc:
        print(f"  [warn] {league} {season}: {exc}")
        return None


def load_all_data(seasons: list[str] | None = None) -> pd.DataFrame:
    seasons = seasons or ALL_SEASONS
    frames: list[pd.DataFrame] = []
    print("Descargando datos de football-data.co.uk …")
    for season in seasons:
        for league in LEAGUE_CODES:
            df = _download_csv(league, season)
            if df is None or df.empty:
                continue
            df["season"] = season
            df["league"] = league
            frames.append(df)
            print(f"  ✓ {league} {season}  ({len(df)} partidos)")

    if not frames:
        raise RuntimeError("No se pudieron descargar datos. Comprueba tu conexión.")
    return pd.concat(frames, ignore_index=True)


# ── Limpieza ───────────────────────────────────────────────────────────────────

def clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # Fecha
    df["Date"] = pd.to_datetime(df["Date"], dayfirst=True, errors="coerce")
    df = df.dropna(subset=["Date", "HomeTeam", "AwayTeam", "FTR"])

    # Resultado a entero: H→2, D→1, A→0
    df = df[df["FTR"].isin(["H", "D", "A"])].copy()
    df["target"] = df["FTR"].map({"H": 2, "D": 1, "A": 0}).astype(int)

    # Goles
    df["FTHG"] = pd.to_numeric(df.get("FTHG"), errors="coerce").fillna(0)
    df["FTAG"] = pd.to_numeric(df.get("FTAG"), errors="coerce").fillna(0)

    # Ordenar cronológicamente
    df = df.sort_values("Date").reset_index(drop=True)

    # Cuotas — coercionar
    for col in ODD_COLS_H + ODD_COLS_D + ODD_COLS_A + [CLOSE_H, CLOSE_D, CLOSE_A]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


# ── ELO ───────────────────────────────────────────────────────────────────────

def compute_elo(df: pd.DataFrame) -> pd.DataFrame:
    """Añade elo_home / elo_away (rating ANTES del partido)."""
    ratings: dict[str, float] = {}
    elo_h_list: list[float] = []
    elo_a_list: list[float] = []

    for _, row in df.iterrows():
        h, a = row["HomeTeam"], row["AwayTeam"]
        rh = ratings.get(h, ELO_INITIAL)
        ra = ratings.get(a, ELO_INITIAL)
        elo_h_list.append(rh)
        elo_a_list.append(ra)

        # Actualizar solo con resultado conocido
        exp_h = 1 / (1 + 10 ** ((ra - rh) / 400))
        score_h = 1.0 if row["FTHG"] > row["FTAG"] else (0.5 if row["FTHG"] == row["FTAG"] else 0.0)
        delta = ELO_K * (score_h - exp_h)
        ratings[h] = rh + delta
        ratings[a] = ra - delta

    df["elo_home"] = elo_h_list
    df["elo_away"] = elo_a_list
    df["elo_diff"] = df["elo_home"] - df["elo_away"]
    return df


# ── Forma reciente ─────────────────────────────────────────────────────────────

def _rolling_team_stats(df: pd.DataFrame, team_col: str, is_home: bool, window: int = 5):
    """Puntos, goles a favor y en contra en últimos `window` partidos."""
    goal_for_col = "FTHG" if is_home else "FTAG"
    goal_ag_col = "FTAG" if is_home else "FTHG"
    result_col = "FTR"

    prefix = "h" if is_home else "a"
    records: dict[str, list] = {}  # team → list of (date, pts, gf, ga)

    pts_list, gf_list, ga_list = [], [], []

    for _, row in df.iterrows():
        team = row[team_col]
        gf = row[goal_for_col]
        ga = row[goal_ag_col]
        ftr = row[result_col]

        pts = 3 if (is_home and ftr == "H") or (not is_home and ftr == "A") else (1 if ftr == "D" else 0)

        hist = records.get(team, [])
        recent = hist[-window:]

        pts_list.append(np.mean([r[1] for r in recent]) if recent else 1.5)
        gf_list.append(np.mean([r[2] for r in recent]) if recent else 1.0)
        ga_list.append(np.mean([r[3] for r in recent]) if recent else 1.0)

        records.setdefault(team, []).append((row["Date"], pts, gf, ga))

    df[f"{prefix}_form_pts"] = pts_list
    df[f"{prefix}_form_gf"] = gf_list
    df[f"{prefix}_form_ga"] = ga_list
    return df


def add_form_features(df: pd.DataFrame) -> pd.DataFrame:
    df = _rolling_team_stats(df, "HomeTeam", is_home=True)
    df = _rolling_team_stats(df, "AwayTeam", is_home=False)
    df["form_diff_pts"] = df["h_form_pts"] - df["a_form_pts"]
    df["form_diff_gf"] = df["h_form_gf"] - df["a_form_gf"]
    return df


# ── Cuotas → probabilidades ────────────────────────────────────────────────────

def _best_odd(row: pd.Series, cols: list[str]) -> float:
    vals = [row[c] for c in cols if c in row.index and pd.notna(row[c]) and row[c] > 1.0]
    return max(vals) if vals else np.nan


def _mean_odd(row: pd.Series, cols: list[str]) -> float:
    vals = [row[c] for c in cols if c in row.index and pd.notna(row[c]) and row[c] > 1.0]
    return np.mean(vals) if vals else np.nan


def add_odds_features(df: pd.DataFrame) -> pd.DataFrame:
    df["best_H"] = df.apply(_best_odd, cols=ODD_COLS_H, axis=1)
    df["best_D"] = df.apply(_best_odd, cols=ODD_COLS_D, axis=1)
    df["best_A"] = df.apply(_best_odd, cols=ODD_COLS_A, axis=1)
    df["mean_H"] = df.apply(_mean_odd, cols=ODD_COLS_H, axis=1)
    df["mean_D"] = df.apply(_mean_odd, cols=ODD_COLS_D, axis=1)
    df["mean_A"] = df.apply(_mean_odd, cols=ODD_COLS_A, axis=1)

    # Probabilidad implícita Pinnacle (quitando margen)
    for suffix in ["H", "D", "A"]:
        df[f"pin_{suffix}"] = 1.0 / df.get(f"PS{suffix}", pd.Series(np.nan, index=df.index))

    df["pin_sum"] = df["pin_H"] + df["pin_D"] + df["pin_A"]
    for suffix in ["H", "D", "A"]:
        df[f"pin_fair_{suffix}"] = df[f"pin_{suffix}"] / df["pin_sum"].where(df["pin_sum"] > 0)

    # Movimiento de cuota (apertura Bet365 vs cierre Pinnacle)
    df["move_H"] = (1.0 / df["B365H"].clip(lower=1.01)) - df.get("pin_fair_H", pd.Series(np.nan, index=df.index))
    df["move_A"] = (1.0 / df["B365A"].clip(lower=1.01)) - df.get("pin_fair_A", pd.Series(np.nan, index=df.index))

    # Overround medio
    df["overround"] = df.apply(
        lambda r: sum(
            1.0 / r[c] for c in ["mean_H", "mean_D", "mean_A"] if pd.notna(r[c]) and r[c] > 0
        ),
        axis=1,
    )

    return df


# ── Feature set final ──────────────────────────────────────────────────────────

FEATURE_COLS = [
    "elo_diff",
    "h_form_pts", "a_form_pts", "form_diff_pts",
    "h_form_gf", "a_form_gf", "form_diff_gf",
    "h_form_ga", "a_form_ga",
    "pin_fair_H", "pin_fair_D", "pin_fair_A",
    "move_H", "move_A",
    "overround",
]


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = compute_elo(df)
    df = add_form_features(df)
    df = add_odds_features(df)
    df["__season_key"] = df["season"].apply(lambda s: int(s[:2]) * 100 + int(s[2:]))
    return df


# ── Split temporal ─────────────────────────────────────────────────────────────

def temporal_split(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    train_key = int(CONFIG["train_end_season"][:2]) * 100 + int(CONFIG["train_end_season"][2:])
    val_key = int(CONFIG["val_season"][:2]) * 100 + int(CONFIG["val_season"][2:])
    test_key = int(CONFIG["test_season"][:2]) * 100 + int(CONFIG["test_season"][2:])

    train = df[df["__season_key"] <= train_key]
    val = df[df["__season_key"] == val_key]
    test = df[df["__season_key"] == test_key]
    return train, val, test


# ── Entrenamiento ──────────────────────────────────────────────────────────────

def _xy(split: pd.DataFrame):
    valid = split.dropna(subset=FEATURE_COLS)
    X = valid[FEATURE_COLS].values.astype(np.float32)
    y = valid["target"].values.astype(int)
    return X, y, valid


def train_lgbm(X_train, y_train, X_val, y_val) -> lgb.Booster:
    dtrain = lgb.Dataset(X_train, label=y_train)
    dval = lgb.Dataset(X_val, label=y_val, reference=dtrain)

    params = {
        "objective": "multiclass",
        "num_class": 3,
        "metric": "multi_logloss",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_child_samples": 30,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.85,
        "bagging_freq": 5,
        "lambda_l1": 0.1,
        "lambda_l2": 0.1,
        "verbose": -1,
        "seed": 42,
    }

    callbacks = [lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)]
    model = lgb.train(
        params,
        dtrain,
        num_boost_round=2000,
        valid_sets=[dval],
        callbacks=callbacks,
    )
    print(f"  Mejor iteración: {model.best_iteration}")
    return model


# ── Calibración isotónica ──────────────────────────────────────────────────────

def calibrate(
    model: lgb.Booster, X_val: np.ndarray, y_val: np.ndarray
) -> list[IsotonicRegression]:
    """Calibra cada clase por separado con regresión isotónica."""
    raw = model.predict(X_val)   # (N, 3)
    calibrators = []
    for c in range(3):
        y_bin = (y_val == c).astype(float)
        iso = IsotonicRegression(out_of_bounds="clip")
        iso.fit(raw[:, c], y_bin)
        calibrators.append(iso)
    return calibrators


def predict_calibrated(
    model: lgb.Booster,
    calibrators: list[IsotonicRegression],
    X: np.ndarray,
) -> np.ndarray:
    """Devuelve probabilidades calibradas y renormalizadas. Shape (N, 3) → [A, D, H]."""
    raw = model.predict(X)
    cal = np.column_stack([c.predict(raw[:, i]) for i, c in enumerate(calibrators)])
    row_sums = cal.sum(axis=1, keepdims=True).clip(min=1e-9)
    return cal / row_sums


# ── Métricas y calibración ─────────────────────────────────────────────────────

def evaluate(probs: np.ndarray, y: np.ndarray, label: str = "test") -> dict:
    outcomes = {0: "Away", 1: "Draw", 2: "Home"}
    results = {}
    ll = log_loss(y, probs)
    results["log_loss"] = ll

    for c, name in outcomes.items():
        y_bin = (y == c).astype(float)
        bs = brier_score_loss(y_bin, probs[:, c])
        results[f"brier_{name}"] = bs

    print(f"\n── {label} ──")
    print(f"  Log-loss: {ll:.4f}")
    for c, name in outcomes.items():
        print(f"  Brier {name}: {results[f'brier_{name}']:.4f}")
    return results


def plot_calibration(probs: np.ndarray, y: np.ndarray, label: str = "test", n_bins: int = 10):
    """Diagrama de fiabilidad (reliability diagram) por clase."""
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    outcomes = {0: "Away (A)", 1: "Draw (D)", 2: "Home (H)"}
    bins = np.linspace(0, 1, n_bins + 1)
    bin_centers = (bins[:-1] + bins[1:]) / 2

    for ax, (c, name) in zip(axes, outcomes.items()):
        y_bin = (y == c).astype(float)
        p = probs[:, c]
        fraction_pos = []
        mean_pred = []
        for lo, hi in zip(bins[:-1], bins[1:]):
            mask = (p >= lo) & (p < hi)
            if mask.sum() == 0:
                continue
            fraction_pos.append(y_bin[mask].mean())
            mean_pred.append(p[mask].mean())

        ax.plot([0, 1], [0, 1], "k--", alpha=0.4, label="Perfecta")
        ax.plot(mean_pred, fraction_pos, "o-", color="#ef3340", label="Modelo")
        ax.set_title(name)
        ax.set_xlabel("Prob. predicha")
        ax.set_ylabel("Fracción positivos")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.legend(fontsize=8)

    fig.suptitle(f"Curva de calibración — {label}", fontsize=12)
    fig.tight_layout()
    out = MODELS_DIR / f"calibration_{label}.png"
    fig.savefig(out, dpi=120)
    plt.close(fig)
    print(f"  Gráfico guardado: {out}")


# ── Backtest ───────────────────────────────────────────────────────────────────

def _kelly_stake(prob: float, odd: float, fraction: float, bankroll: float) -> float:
    if odd <= 1.0:
        return 0.0
    b = odd - 1
    q = 1 - prob
    k = (b * prob - q) / b
    return max(0.0, fraction * k * bankroll)


def backtest(
    probs: np.ndarray,
    df_test: pd.DataFrame,
    y_test: np.ndarray,
) -> dict:
    """
    Simula staking plano y Kelly fraccionado.
    Solo apuesta en picks con edge > CONFIG['edge_threshold'].
    """
    rows = []
    for i, (idx, row) in enumerate(df_test.iterrows()):
        p_h, p_d, p_a = probs[i, 2], probs[i, 1], probs[i, 0]
        actual = y_test[i]

        for outcome, prob, best_odd_col in [
            ("H", p_h, "best_H"),
            ("D", p_d, "best_D"),
            ("A", p_a, "best_A"),
        ]:
            odd = row.get(best_odd_col, np.nan)
            if pd.isna(odd) or odd <= 1.0:
                continue

            pin_col = {"H": "pin_fair_H", "D": "pin_fair_D", "A": "pin_fair_A"}[outcome]
            pin_fair = row.get(pin_col, np.nan)
            if pd.isna(pin_fair) or pin_fair <= 0:
                continue

            edge = prob - pin_fair
            if edge < CONFIG["edge_threshold"]:
                continue

            ev = prob * (odd - 1) - (1 - prob)
            result_code = {"H": 2, "D": 1, "A": 0}[outcome]
            won = int(actual == result_code)

            rows.append({
                "outcome": outcome,
                "prob": prob,
                "odd": odd,
                "edge": edge,
                "ev": ev,
                "won": won,
                "flat_pnl": (odd - 1) * CONFIG["flat_stake"] if won else -CONFIG["flat_stake"],
            })

    if not rows:
        print("  [warn] No se encontraron picks con valor en el backtest.")
        return {}

    res = pd.DataFrame(rows)
    n = len(res)
    win_rate = res["won"].mean()
    flat_roi = res["flat_pnl"].sum() / (n * CONFIG["flat_stake"])
    flat_yield = res["flat_pnl"].sum() / (n * CONFIG["flat_stake"])
    max_dd = _max_drawdown(res["flat_pnl"].cumsum())

    # ── Por banda ──
    bands = {"A (~30%)": (0.22, 0.38), "B (~55%)": (0.47, 0.63), "C (~75%)": (0.67, 0.83)}
    print(f"\n── Backtest ({n} picks con valor, flat stake {CONFIG['flat_stake']:.0f}€) ──")
    print(f"  Win rate:    {win_rate:.1%}")
    print(f"  ROI (flat):  {flat_roi:+.1%}")
    print(f"  Max DD:      {max_dd:.0f}€")

    band_stats = {}
    for name, (lo, hi) in bands.items():
        mask = (res["prob"] >= lo) & (res["prob"] < hi)
        sub = res[mask]
        if sub.empty:
            continue
        band_stats[name] = {
            "n": len(sub),
            "win_rate": sub["won"].mean(),
            "roi": sub["flat_pnl"].sum() / (len(sub) * CONFIG["flat_stake"]),
            "mean_ev": sub["ev"].mean(),
        }
        print(f"  Banda {name}: {len(sub)} picks | WR {sub['won'].mean():.1%} | ROI {sub['flat_pnl'].sum()/(len(sub)*CONFIG['flat_stake']):+.1%}")

    return {
        "n_picks": n,
        "win_rate": win_rate,
        "flat_roi": flat_roi,
        "flat_yield": flat_yield,
        "max_drawdown": max_dd,
        "bands": band_stats,
    }


def _max_drawdown(cumulative_pnl: pd.Series) -> float:
    peak = cumulative_pnl.cummax()
    dd = peak - cumulative_pnl
    return dd.max()


# ── Guardado de artefactos ─────────────────────────────────────────────────────

def save_artifacts(model: lgb.Booster, calibrators: list, metrics: dict, backtest_stats: dict):
    with open(MODELS_DIR / "lgbm_model.pkl", "wb") as f:
        pickle.dump(model, f)
    with open(MODELS_DIR / "calibrators.pkl", "wb") as f:
        pickle.dump(calibrators, f)

    report = {
        "feature_cols": FEATURE_COLS,
        "config": CONFIG,
        "metrics": metrics,
        "backtest": backtest_stats,
    }
    with open(MODELS_DIR / "report.json", "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n✓ Modelo guardado en {MODELS_DIR}/")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", type=int, default=None, help="Últimas N temporadas")
    args = parser.parse_args()

    seasons = ALL_SEASONS[-args.seasons:] if args.seasons else ALL_SEASONS

    raw = load_all_data(seasons)
    df = clean(raw)
    print(f"\nDatos limpios: {len(df):,} partidos")

    df = build_features(df)
    train_df, val_df, test_df = temporal_split(df)
    print(f"Train: {len(train_df):,} | Val: {len(val_df):,} | Test: {len(test_df):,}")

    X_train, y_train, _ = _xy(train_df)
    X_val, y_val, _ = _xy(val_df)
    X_test, y_test, test_valid = _xy(test_df)

    print("\nEntrenando LightGBM …")
    model = train_lgbm(X_train, y_train, X_val, y_val)

    print("\nCalibrando probabilidades …")
    calibrators = calibrate(model, X_val, y_val)

    probs_val = predict_calibrated(model, calibrators, X_val)
    probs_test = predict_calibrated(model, calibrators, X_test)

    val_metrics = evaluate(probs_val, y_val, "validación")
    test_metrics = evaluate(probs_test, y_test, "test")

    plot_calibration(probs_val, y_val, "validacion")
    plot_calibration(probs_test, y_test, "test")

    bt_stats = backtest(probs_test, test_valid, y_test)

    save_artifacts(model, calibrators, {"val": val_metrics, "test": test_metrics}, bt_stats)
    print("\n✓ Entrenamiento completo. Ejecuta predict.py para generar picks.json")


if __name__ == "__main__":
    main()
