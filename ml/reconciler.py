#!/usr/bin/env python3
"""Empareja fixtures de API-Football con eventos de The Odds API."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any, Callable

TEAM_ALIASES: dict[str, str] = {
    "espana": "spain",
    "cabo verde": "cape verde",
    "arabia saudi": "saudi arabia",
    "arabia saudita": "saudi arabia",
    "ksa": "saudi arabia",
    "corea del sur": "south korea",
    "korea republic": "south korea",
    "republic of korea": "south korea",
    "korea south": "south korea",
    "corea del norte": "north korea",
    "korea dpr": "north korea",
    "estados unidos": "united states",
    "usa": "united states",
    "us": "united states",
    "united states of america": "united states",
    "inglaterra": "england",
    "alemania": "germany",
    "francia": "france",
    "paises bajos": "netherlands",
    "holanda": "netherlands",
    "belgica": "belgium",
    "croacia": "croatia",
    "marruecos": "morocco",
    "costa de marfil": "ivory coast",
    "cote divoire": "ivory coast",
    "cote d ivoire": "ivory coast",
    "japon": "japan",
    "republica checa": "czechia",
    "czech republic": "czechia",
}

_CLUB_SUFFIXES = {"fc", "cf", "sc", "afc", "ac", "cd", "club"}
_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_PRIORITY = {"exact": 3, "alias": 2, "fuzzy": 1}


def strip_accents(text: str) -> str:
    """Quita diacríticos de un nombre."""
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(char for char in normalized if not unicodedata.combining(char))


def normalize_name(name: str) -> str:
    """Normaliza mayúsculas, acentos, puntuación, sufijos y espacios."""
    if not name:
        return ""
    normalized = strip_accents(name).lower()
    normalized = _PUNCT.sub(" ", normalized)
    normalized = _WS.sub(" ", normalized).strip()
    tokens = [
        token
        for token in normalized.split(" ")
        if token and token not in _CLUB_SUFFIXES
    ]
    return " ".join(tokens)


def canonical_team(name: str) -> str:
    """Convierte un nombre a su forma canónica cuando existe un alias."""
    normalized = normalize_name(name)
    return TEAM_ALIASES.get(normalized, normalized)


def parse_utc(timestamp: str) -> datetime:
    """Convierte ISO-8601 con Z u offset a datetime UTC."""
    if timestamp.endswith("Z"):
        timestamp = timestamp[:-1] + "+00:00"
    parsed = datetime.fromisoformat(timestamp)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass
class MatchSide:
    raw: dict
    source: str
    id: Any
    home: str
    away: str
    kickoff: datetime
    home_norm: str = field(init=False)
    away_norm: str = field(init=False)
    home_canon: str = field(init=False)
    away_canon: str = field(init=False)

    def __post_init__(self) -> None:
        self.home_norm = normalize_name(self.home)
        self.away_norm = normalize_name(self.away)
        self.home_canon = canonical_team(self.home)
        self.away_canon = canonical_team(self.away)

    def label(self) -> str:
        return f"{self.home} vs {self.away} @ {self.kickoff:%Y-%m-%d %H:%M}Z"


def from_football(fixture: dict) -> MatchSide:
    return MatchSide(
        raw=fixture,
        source="api_football",
        id=fixture.get("fixture_id"),
        home=fixture.get("home", ""),
        away=fixture.get("away", ""),
        kickoff=parse_utc(fixture["kickoff_utc"]),
    )


def from_odds(event: dict) -> MatchSide:
    return MatchSide(
        raw=event,
        source="odds_api",
        id=event.get("event_id"),
        home=event.get("home_team", ""),
        away=event.get("away_team", ""),
        kickoff=parse_utc(event["commence_time"]),
    )


@dataclass
class MatchResult:
    football: MatchSide
    odds: MatchSide
    method: str
    orientation: str
    confidence: float

    def to_unified(self) -> dict:
        match_id = (
            f"{self.football.home_canon}-{self.football.away_canon}-"
            f"{self.football.kickoff:%Y-%m-%d}"
        ).replace(" ", "_")
        return {
            "match_id_interno": match_id,
            "fecha_utc": self.football.kickoff.isoformat(),
            "local": self.football.home,
            "visitante": self.football.away,
            "fuente_ids": {
                "api_football_fixture": self.football.id,
                "odds_api_event": self.odds.id,
            },
            "reconciliacion": {
                "metodo": self.method,
                "orientacion": self.orientation,
                "confianza": self.confidence,
            },
        }


def _orientation_match(
    football: MatchSide,
    odds: MatchSide,
    swapped: bool,
    fuzzy_threshold: float,
) -> tuple[str, float] | None:
    if swapped:
        odds_home_norm, odds_away_norm = odds.away_norm, odds.home_norm
        odds_home_canon, odds_away_canon = odds.away_canon, odds.home_canon
    else:
        odds_home_norm, odds_away_norm = odds.home_norm, odds.away_norm
        odds_home_canon, odds_away_canon = odds.home_canon, odds.away_canon

    if (
        football.home_norm == odds_home_norm
        and football.away_norm == odds_away_norm
    ):
        return ("exact", 1.0)
    if (
        football.home_canon == odds_home_canon
        and football.away_canon == odds_away_canon
    ):
        return ("alias", 0.97)

    home_ratio = SequenceMatcher(
        None, football.home_canon, odds_home_canon
    ).ratio()
    away_ratio = SequenceMatcher(
        None, football.away_canon, odds_away_canon
    ).ratio()
    if home_ratio >= fuzzy_threshold and away_ratio >= fuzzy_threshold:
        return ("fuzzy", round(min(home_ratio, away_ratio), 3))
    return None


def reconcile(
    football_fixtures: list[dict],
    odds_events: list[dict],
    *,
    tolerance_minutes: int = 90,
    fuzzy_threshold: float = 0.85,
    allow_swapped: bool = True,
    football_adapter: Callable[[dict], MatchSide] = from_football,
    odds_adapter: Callable[[dict], MatchSide] = from_odds,
) -> tuple[list[MatchResult], list[MatchSide], list[MatchSide]]:
    """Devuelve partidos emparejados y los elementos sin pareja de cada fuente."""
    football = [football_adapter(item) for item in football_fixtures]
    odds = [odds_adapter(item) for item in odds_events]
    tolerance = timedelta(minutes=tolerance_minutes)
    matched: list[MatchResult] = []
    used_odds: set[int] = set()

    for fixture in football:
        best: tuple[float, float, float, float, int, str, str] | None = None
        for index, event in enumerate(odds):
            if index in used_odds:
                continue
            time_delta = abs(fixture.kickoff - event.kickoff)
            if time_delta > tolerance:
                continue

            orientations = (False, True) if allow_swapped else (False,)
            for swapped in orientations:
                result = _orientation_match(
                    fixture, event, swapped, fuzzy_threshold
                )
                if result is None:
                    continue
                method, confidence = result
                orientation = "swapped" if swapped else "same"
                orientation_bonus = 0.5 if orientation == "same" else 0.0
                candidate = (
                    _PRIORITY[method],
                    orientation_bonus,
                    confidence,
                    -time_delta.total_seconds(),
                    index,
                    method,
                    orientation,
                )
                if best is None or candidate[:4] > best[:4]:
                    best = candidate

        if best is not None:
            _, _, confidence, _, index, method, orientation = best
            used_odds.add(index)
            matched.append(
                MatchResult(
                    fixture,
                    odds[index],
                    method,
                    orientation,
                    confidence,
                )
            )

    matched_football = {id(item.football) for item in matched}
    unmatched_football = [
        item for item in football if id(item) not in matched_football
    ]
    unmatched_odds = [
        item for index, item in enumerate(odds) if index not in used_odds
    ]
    return matched, unmatched_football, unmatched_odds


if __name__ == "__main__":
    fixtures = [
        {
            "fixture_id": 1001,
            "home": "España",
            "away": "Cabo Verde",
            "kickoff_utc": "2026-06-15T16:00:00Z",
        },
        {
            "fixture_id": 1002,
            "home": "Uruguay",
            "away": "España",
            "kickoff_utc": "2026-06-27T00:00:00Z",
        },
    ]
    events = [
        {
            "event_id": "a1",
            "home_team": "Spain",
            "away_team": "Cape Verde",
            "commence_time": "2026-06-15T16:00:00Z",
        },
        {
            "event_id": "a2",
            "home_team": "Spain",
            "away_team": "Uruguay",
            "commence_time": "2026-06-27T00:30:00Z",
        },
    ]
    matches, missing_fixtures, missing_events = reconcile(fixtures, events)
    for match in matches:
        print(match.to_unified())
    print(f"Sin fixture: {len(missing_fixtures)}")
    print(f"Sin cuotas: {len(missing_events)}")
