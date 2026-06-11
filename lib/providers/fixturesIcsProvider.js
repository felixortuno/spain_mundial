"use strict";

const { CacheStore } = require("../cache");

const DEFAULT_URL =
  "https://ics.fixtur.es/v2/league/fifa-world-cup-2026.ics";

function unfoldIcs(value) {
  return String(value || "").replace(/\r?\n[ \t]/g, "");
}

function readProperty(eventBlock, propertyName) {
  const pattern = new RegExp(`^${propertyName}(?:;[^:]*)?:(.*)$`, "mi");
  return unfoldIcs(eventBlock).match(pattern)?.[1]?.trim() || "";
}

function parseIcsDate(value) {
  const match = String(value).match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/
  );
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
}

function parseSummary(summary) {
  const value = String(summary || "").trim();
  const scored = value.match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+)$/);
  if (scored) {
    return {
      home: scored[1].trim(),
      away: scored[4].trim(),
      homeGoals: Number(scored[2]),
      awayGoals: Number(scored[3]),
      played: true
    };
  }

  const parenthesizedScore = value.match(/^(.+?)\s+-\s+(.+?)\s+\((\d+)-(\d+)\)$/);
  if (parenthesizedScore) {
    return {
      home: parenthesizedScore[1].trim(),
      away: parenthesizedScore[2].trim(),
      homeGoals: Number(parenthesizedScore[3]),
      awayGoals: Number(parenthesizedScore[4]),
      played: true
    };
  }

  const separator = value.indexOf(" - ");
  if (separator === -1) return null;
  return {
    home: value.slice(0, separator).trim(),
    away: value.slice(separator + 3).trim(),
    homeGoals: null,
    awayGoals: null,
    played: false
  };
}

function fixturesFromIcs(icsText) {
  const events = String(icsText || "").match(
    /BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/gi
  ) || [];

  return events.map((eventBlock, index) => {
    const teams = parseSummary(readProperty(eventBlock, "SUMMARY"));
    const date = parseIcsDate(readProperty(eventBlock, "DTSTART"));
    if (!teams || !date) return null;
    return {
      source: "fixtur.es",
      id: readProperty(eventBlock, "UID") || `ics-${index}`,
      commenceTime: date.toISOString(),
      timestamp: Math.floor(date.getTime() / 1000),
      home: { id: null, name: teams.home },
      away: { id: null, name: teams.away },
      competition: {
        id: 1,
        name: "FIFA World Cup",
        country: "World",
        season: 2026,
        round: null
      },
      features: {
        status: {
          short: teams.played ? "FT" : "NS",
          long: teams.played ? "Match Finished" : "Not Started",
          elapsed: teams.played ? 90 : null
        },
        goals: { home: teams.homeGoals, away: teams.awayGoals },
        score: null,
        venue: { name: readProperty(eventBlock, "LOCATION") || null }
      }
    };
  }).filter(Boolean);
}

class FixturesIcsProvider {
  constructor({
    url = DEFAULT_URL,
    ttlMs = 15 * 60 * 1000,
    staleTtlMs = 24 * 60 * 60 * 1000,
    fetchImpl = fetch
  } = {}) {
    this.url = url;
    this.ttlMs = ttlMs;
    this.staleTtlMs = staleTtlMs;
    this.fetch = fetchImpl;
    this.cache = new CacheStore("fixtures-ics");
  }

  async getFixtures() {
    return this.cache.getOrLoad({
      key: this.url,
      ttlMs: this.ttlMs,
      staleTtlMs: this.staleTtlMs,
      loader: async () => {
        const response = await this.fetch(this.url, {
          headers: {
            Accept: "text/calendar",
            "User-Agent": "Mundial-2026-Dashboard/2.0"
          }
        });
        if (!response.ok) {
          throw new Error(`Fixtur.es respondió con HTTP ${response.status}.`);
        }
        return {
          data: fixturesFromIcs(await response.text()),
          metadata: { provider: "fixtur.es", status: response.status }
        };
      }
    });
  }
}

module.exports = {
  FixturesIcsProvider,
  fixturesFromIcs,
  parseSummary
};
