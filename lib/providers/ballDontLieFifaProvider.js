"use strict";

const { CacheStore } = require("../cache");
const { emptyStats, matchInsights } = require("../liveMatches");

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function americanToDecimal(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return Number((odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds)).toFixed(3));
}

function addArrayParams(searchParams, key, values) {
  for (const value of values || []) {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.append(key, String(value));
    }
  }
}

function matchStatus(match) {
  const status = String(match.status || "").toLowerCase();
  const elapsed = match.clock_seconds != null
    ? Math.floor(Number(match.clock_seconds) / 60)
    : null;

  if (status === "completed") {
    return { short: "FT", long: "Match Finished", elapsed: 90 };
  }
  if (status === "in_progress") {
    return {
      short: elapsed != null && elapsed > 45 ? "2H" : "1H",
      long: "In Progress",
      elapsed
    };
  }
  if (status === "postponed") return { short: "PST", long: "Postponed", elapsed: null };
  if (status === "cancelled") return { short: "CANC", long: "Cancelled", elapsed: null };
  return { short: "NS", long: "Not Started", elapsed: null };
}

function normalizeTeam(team, source) {
  if (team) {
    return {
      id: team.id ?? null,
      name: team.name || team.short_name || team.abbreviation || "TBD"
    };
  }
  return {
    id: null,
    name: source?.description || source?.placeholder || "TBD"
  };
}

function normalizeMatch(match) {
  const home = normalizeTeam(match.home_team, match.home_team_source);
  const away = normalizeTeam(match.away_team, match.away_team_source);
  const status = matchStatus(match);
  const timestamp = Date.parse(match.datetime);
  return {
    source: "balldontlie",
    id: String(match.id ?? ""),
    commenceTime: match.datetime || null,
    timestamp: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null,
    home,
    away,
    competition: {
      id: match.stage?.id ?? null,
      name: "FIFA World Cup",
      country: "World",
      season: match.season?.year ?? 2026,
      round: match.round_name || match.stage?.name || null,
      group: match.group?.name || null,
      matchNumber: match.match_number ?? null
    },
    features: {
      status,
      goals: {
        home: numberOrNull(match.home_score),
        away: numberOrNull(match.away_score)
      },
      score: {
        halftime: {
          home: numberOrNull(match.first_half_home_score),
          away: numberOrNull(match.first_half_away_score)
        },
        penalties: {
          home: numberOrNull(match.home_score_penalties),
          away: numberOrNull(match.away_score_penalties)
        }
      },
      venue: match.stadium
        ? {
            id: match.stadium.id ?? null,
            name: match.stadium.name || null,
            city: match.stadium.city || null,
            country: match.stadium.country || null
          }
        : null,
      referee: match.referee?.name || null,
      form: { home: null, away: null },
      statistics: null,
      lineups: null,
      enrichmentErrors: []
    },
    raw: match
  };
}

function normalizeTeamMatchStats(rows, match) {
  const bySide = new Map();
  for (const row of rows || []) {
    bySide.set(row.is_home ? "home" : "away", {
      ...emptyStats(),
      shotsOnGoal: numberOrNull(row.shots_on_target),
      shotsOffGoal: numberOrNull(row.shots_off_target),
      totalShots: numberOrNull(row.shots_total),
      blockedShots: numberOrNull(row.shots_blocked),
      shotsInsideBox: numberOrNull(row.shots_inside_box),
      shotsOutsideBox: numberOrNull(row.shots_outside_box),
      fouls: numberOrNull(row.fouls),
      corners: numberOrNull(row.corners),
      offsides: numberOrNull(row.offsides),
      possession: numberOrNull(row.possession_pct),
      yellowCards: numberOrNull(row.yellow_cards),
      totalPasses: numberOrNull(row.passes_total),
      passesAccurate: numberOrNull(row.passes_accurate),
      passAccuracy: row.passes_total
        ? Number(((Number(row.passes_accurate || 0) / Number(row.passes_total)) * 100).toFixed(1))
        : null,
      expectedGoals: numberOrNull(row.expected_goals),
      goalkeeperSaves: numberOrNull(row.saves)
    });
  }
  return {
    home: bySide.get("home") || emptyStats(),
    away: bySide.get("away") || emptyStats()
  };
}

function eventType(row) {
  const type = String(row.incident_type || "").toLowerCase();
  const cls = String(row.incident_class || row.reason || "").toLowerCase();
  if (type === "goal") return { type: "Goal", detail: cls.includes("own") ? "Own Goal" : "Normal Goal" };
  if (type === "card") return { type: "Card", detail: cls.includes("red") ? "Red Card" : "Yellow Card" };
  if (type === "substitution") return { type: "subst", detail: "Substitution" };
  if (type === "penaltyshootout") return { type: "Penalty", detail: "Penalty Shootout" };
  return { type: row.incident_type || "Action", detail: row.incident_class || null };
}

function normalizeEvents(rows, match) {
  return (rows || [])
    .map((row, index) => {
      const typed = eventType(row);
      const side = row.is_home == null ? null : row.is_home ? "home" : "away";
      const team = side === "home" ? match.home : side === "away" ? match.away : null;
      return {
        id: String(row.id ?? `${row.match_id}-${index}`),
        elapsed: numberOrNull(row.time_minute),
        extra: numberOrNull(row.added_time),
        teamId: team?.id ?? null,
        team: team?.name || null,
        player: row.player?.name || row.player_in?.name || row.player_out?.name || null,
        assist: row.assist_player?.name || null,
        type: typed.type,
        detail: typed.detail,
        comments: row.reason || row.shootout_description || null
      };
    })
    .sort((a, b) =>
      (b.elapsed || 0) - (a.elapsed || 0) ||
      (b.extra || 0) - (a.extra || 0)
    );
}

function bookmakerTitle(vendor) {
  return String(vendor || "")
    .split(/[_-]+/)
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(" ");
}

function normalizedMarketOutcome(name, price, point = null) {
  if (price == null) return null;
  return { name, price, point };
}

function marketsFromOdd(odd, match) {
  const markets = [];
  const h2h = [
    normalizedMarketOutcome(match.home.name, americanToDecimal(odd.moneyline_home_odds)),
    normalizedMarketOutcome("Draw", americanToDecimal(odd.moneyline_draw_odds)),
    normalizedMarketOutcome(match.away.name, americanToDecimal(odd.moneyline_away_odds))
  ].filter(Boolean);
  if (h2h.length) markets.push({ key: "h2h", lastUpdate: odd.updated_at || null, outcomes: h2h });

  const totals = [
    normalizedMarketOutcome("Over", americanToDecimal(odd.total_over_odds), numberOrNull(odd.total_value)),
    normalizedMarketOutcome("Under", americanToDecimal(odd.total_under_odds), numberOrNull(odd.total_value))
  ].filter(Boolean);
  if (totals.length) markets.push({ key: "totals", lastUpdate: odd.updated_at || null, outcomes: totals });

  const spreads = [
    normalizedMarketOutcome(match.home.name, americanToDecimal(odd.spread_home_odds), numberOrNull(odd.spread_home_value)),
    normalizedMarketOutcome(match.away.name, americanToDecimal(odd.spread_away_odds), numberOrNull(odd.spread_away_value))
  ].filter(Boolean);
  if (spreads.length) markets.push({ key: "spreads", lastUpdate: odd.updated_at || null, outcomes: spreads });

  for (const market of odd.markets || []) {
    if (market.type === "both_teams_to_score") {
      const outcomes = (market.outcomes || [])
        .map((outcome) => normalizedMarketOutcome(
          outcome.type === "yes" ? "Yes" : outcome.type === "no" ? "No" : outcome.name,
          numberOrNull(outcome.decimal_odds),
          numberOrNull(outcome.line_value)
        ))
        .filter(Boolean);
      if (outcomes.length) {
        markets.push({ key: "btts", lastUpdate: market.updated_at || odd.updated_at || null, outcomes });
      }
    }
  }
  return markets;
}

function normalizeOddsEvents(oddsRows, matches) {
  const matchesById = new Map(matches.map((match) => [String(match.id), match]));
  const grouped = new Map();
  for (const odd of oddsRows || []) {
    const match = matchesById.get(String(odd.match_id));
    if (!match) continue;
    const key = String(odd.match_id);
    if (!grouped.has(key)) {
      grouped.set(key, {
        source: "balldontlie",
        id: key,
        sportKey: "balldontlie_fifa_worldcup",
        sportTitle: "FIFA World Cup",
        commenceTime: match.commenceTime,
        homeTeam: match.home.name,
        awayTeam: match.away.name,
        bookmakers: []
      });
    }
    grouped.get(key).bookmakers.push({
      key: odd.vendor,
      title: bookmakerTitle(odd.vendor),
      lastUpdate: odd.updated_at || null,
      markets: marketsFromOdd(odd, match)
    });
  }
  return [...grouped.values()];
}

class BallDontLieFifaProvider {
  constructor({
    apiKey,
    baseUrl = "https://api.balldontlie.io",
    season = 2026,
    ttlMs = 5 * 60 * 1000,
    staleTtlMs = 60 * 60 * 1000,
    fetchImpl = fetch
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.season = season;
    this.ttlMs = ttlMs;
    this.staleTtlMs = staleTtlMs;
    this.fetch = fetchImpl;
    this.cache = new CacheStore("balldontlie-fifa");
  }

  ensureConfigured() {
    if (!this.apiKey) {
      const error = new Error("Falta BALLDONTLIE_API_KEY.");
      error.code = "MISSING_BALLDONTLIE_API_KEY";
      throw error;
    }
  }

  async request(path, params = {}, { ttlMs = this.ttlMs } = {}) {
    this.ensureConfigured();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (Array.isArray(value)) addArrayParams(url.searchParams, key, value);
      else if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const cacheKey = `${path}?${url.searchParams.toString()}`;
    return this.cache.getOrLoad({
      key: cacheKey,
      ttlMs,
      staleTtlMs: this.staleTtlMs,
      loader: async () => {
        const response = await this.fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: this.apiKey
          }
        });
        const payload = await response.json().catch(() => ({}));
        const metadata = {
          provider: "balldontlie",
          status: response.status
        };
        if (!response.ok) {
          const message = payload?.error || payload?.message || `HTTP ${response.status}`;
          const error = new Error(`balldontlie: ${message}`);
          error.status = response.status;
          error.metadata = metadata;
          throw error;
        }
        return { data: payload, metadata };
      }
    });
  }

  async getAll(path, params = {}, options = {}) {
    const baseParams = {
      ...(options.includeSeason === false ? {} : { "seasons[]": [this.season] }),
      per_page: 100,
      ...params
    };
    const first = await this.request(path, {
      ...baseParams
    }, options);
    const data = Array.isArray(first.data?.data) ? [...first.data.data] : [];
    let cursor = first.data?.meta?.next_cursor;
    while (cursor) {
      const page = await this.request(path, {
        ...baseParams,
        cursor
      }, options);
      data.push(...(Array.isArray(page.data?.data) ? page.data.data : []));
      cursor = page.data?.meta?.next_cursor;
    }
    return { ...first, data };
  }

  async getFixtures() {
    const result = await this.getAll("/fifa/worldcup/v1/matches");
    return { ...result, data: result.data.map(normalizeMatch) };
  }

  async getEvents(matchIds) {
    const result = await this.getAll("/fifa/worldcup/v1/match_events", {
      "match_ids[]": matchIds
    }, {
      includeSeason: false
    });
    return result;
  }

  async getTeamMatchStats(matchIds) {
    return this.getAll("/fifa/worldcup/v1/team_match_stats", {
      "match_ids[]": matchIds
    }, {
      includeSeason: false
    });
  }

  async getRosters() {
    return this.getAll("/fifa/worldcup/v1/rosters");
  }

  async getOddsEvents(matches) {
    const result = await this.getAll("/fifa/worldcup/v1/odds");
    return {
      ...result,
      catalog: {
        data: [{ key: "balldontlie_fifa_worldcup", title: "FIFA World Cup", active: true }],
        metadata: result.metadata,
        cache: result.cache
      },
      data: normalizeOddsEvents(result.data, matches)
    };
  }

  async resolveSportKey() {
    return {
      sport: { key: "balldontlie_fifa_worldcup", title: "FIFA World Cup", active: true },
      catalog: {
        data: [],
        metadata: { provider: "balldontlie" },
        cache: { status: "static" }
      }
    };
  }

  async getOdds() {
    const fixtures = await this.getFixtures();
    return this.getOddsEvents(fixtures.data);
  }

  async getLiveMatches({ maxMatches = 6 } = {}) {
    const fixturesResult = await this.getFixtures();
    const liveMatches = fixturesResult.data
      .filter((match) => match.features?.status?.short && !["NS", "FT", "PST", "CANC"].includes(match.features.status.short))
      .slice(0, maxMatches);
    if (!liveMatches.length) {
      return {
        generated_at: new Date().toISOString(),
        source: "balldontlie",
        active: false,
        matches: []
      };
    }

    const ids = liveMatches.map((match) => match.id);
    const [eventsResult, statsResult] = await Promise.allSettled([
      this.getEvents(ids),
      this.getTeamMatchStats(ids)
    ]);
    const events = eventsResult.status === "fulfilled" ? eventsResult.value.data : [];
    const stats = statsResult.status === "fulfilled" ? statsResult.value.data : [];

    return {
      generated_at: new Date().toISOString(),
      source: "balldontlie",
      active: liveMatches.length > 0,
      matches: liveMatches.map((match) => {
        const matchEvents = events.filter((event) => String(event.match_id) === String(match.id));
        const matchStats = stats.filter((row) => String(row.match_id) === String(match.id));
        const statistics = normalizeTeamMatchStats(matchStats, match);
        return {
          id: match.id,
          source: "balldontlie",
          start: match.commenceTime,
          competition: match.competition,
          status: match.features.status,
          venue: match.features.venue,
          referee: match.features.referee,
          score: match.features.score,
          home: { ...match.home, goals: match.features.goals.home },
          away: { ...match.away, goals: match.features.goals.away },
          statistics,
          insights: matchInsights(statistics, match),
          events: normalizeEvents(matchEvents, match)
        };
      })
    };
  }
}

module.exports = {
  BallDontLieFifaProvider,
  americanToDecimal,
  normalizeMatch,
  normalizeOddsEvents,
  normalizeTeamMatchStats,
  normalizeEvents
};
