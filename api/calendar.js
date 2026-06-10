const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";
const WORLD_CUP_LEAGUE_ID = "1";
const WORLD_CUP_SEASON = "2026";
const UPSTREAM_FEED_URL = "https://ics.fixtur.es/v2/es.ics";
const TOURNAMENT_START = Date.UTC(2026, 5, 11);
const TOURNAMENT_END = Date.UTC(2026, 6, 20);
const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;

const TEAM_NAMES_ES = new Map([
  ["Spain", "España"],
  ["Cape Verde", "Cabo Verde"],
  ["Saudi Arabia", "Arabia Saudí"]
]);

const MATCH_STATUS_ES = new Map([
  ["Not Started", "Por comenzar"],
  ["First Half", "Primera parte"],
  ["Halftime", "Descanso"],
  ["Second Half", "Segunda parte"],
  ["Extra Time", "Prórroga"],
  ["Penalty In Progress", "Penaltis"],
  ["Match Finished", "Finalizado"],
  ["Match Finished After Extra Time", "Finalizado tras prórroga"],
  ["Match Finished After Penalty", "Finalizado tras penaltis"],
  ["Match Postponed", "Aplazado"],
  ["Match Cancelled", "Cancelado"],
  ["Time to be defined", "Hora por confirmar"]
]);

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatIcsDate(value) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function localizeTeamName(name) {
  return TEAM_NAMES_ES.get(name) || name || "Por confirmar";
}

function translateRound(round) {
  const normalized = String(round || "").toLowerCase();

  if (normalized.includes("group")) return "Fase de grupos";
  if (normalized.includes("round of 32")) return "Dieciseisavos de final";
  if (normalized.includes("round of 16")) return "Octavos de final";
  if (normalized.includes("quarter")) return "Cuartos de final";
  if (normalized.includes("semi")) return "Semifinal";
  if (normalized.includes("third")) return "Tercer puesto";
  if (normalized.includes("final")) return "Final";

  return round || "Copa Mundial de la FIFA 2026";
}

function isSpainTeam(team) {
  return (
    team?.code === "ESP" ||
    String(team?.name || "").toLowerCase() === "spain" ||
    String(team?.name || "").toLowerCase() === "españa"
  );
}

function fixtureSummary(fixture) {
  const home = localizeTeamName(fixture.teams?.home?.name);
  const away = localizeTeamName(fixture.teams?.away?.name);
  const status = fixture.fixture?.status?.short;
  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;
  const hasScore =
    Number.isFinite(homeGoals) &&
    Number.isFinite(awayGoals) &&
    !["NS", "TBD", "PST", "CANC"].includes(status);

  return hasScore
    ? `${home} ${homeGoals} - ${awayGoals} ${away}`
    : `${home} - ${away}`;
}

function fixtureToIcsEvent(fixture) {
  const start = Date.parse(fixture.fixture?.date);
  if (!Number.isFinite(start)) {
    return "";
  }

  const venue = fixture.fixture?.venue || {};
  const location = [venue.name, venue.city].filter(Boolean).join(", ");
  const phase = translateRound(fixture.league?.round);
  const rawMatchStatus = fixture.fixture?.status?.long;
  const matchStatus = MATCH_STATUS_ES.get(rawMatchStatus) || rawMatchStatus;
  const description = [phase, "Copa Mundial de la FIFA 2026", matchStatus]
    .filter(Boolean)
    .join(" · ");
  const calendarStatus =
    fixture.fixture?.status?.short === "CANC" ? "CANCELLED" : "CONFIRMED";

  return [
    "BEGIN:VEVENT",
    `UID:api-football-${fixture.fixture.id}@spain-mundial.vercel.app`,
    `DTSTAMP:${formatIcsDate(Date.now())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(start + MATCH_DURATION_MS)}`,
    `SUMMARY:${escapeIcsText(fixtureSummary(fixture))}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    location ? `LOCATION:${escapeIcsText(location)}` : "",
    `STATUS:${calendarStatus}`,
    "TRANSP:OPAQUE",
    "END:VEVENT"
  ]
    .filter(Boolean)
    .join("\r\n");
}

function fixturesToCalendar(fixtures) {
  const spainFixtures = fixtures
    .filter(
      (fixture) =>
        isSpainTeam(fixture.teams?.home) || isSpainTeam(fixture.teams?.away)
    )
    .sort(
      (a, b) =>
        Date.parse(a.fixture?.date || 0) - Date.parse(b.fixture?.date || 0)
    );

  if (spainFixtures.length === 0) {
    throw new Error("API-Football no devolvió partidos de España.");
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Spain Mundial//API-Football//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:España · Mundial 2026",
    "X-WR-CALDESC:Partidos de España en el Mundial 2026",
    "X-PUBLISHED-TTL:PT1H",
    ...spainFixtures.map(fixtureToIcsEvent).filter(Boolean),
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

async function fetchApiFootballCalendar(apiKey) {
  const url = new URL(API_FOOTBALL_URL);
  url.searchParams.set("league", WORLD_CUP_LEAGUE_ID);
  url.searchParams.set("season", WORLD_CUP_SEASON);
  url.searchParams.set("timezone", "UTC");

  const apiResponse = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-apisports-key": apiKey
    }
  });

  if (!apiResponse.ok) {
    throw new Error(`API-Football respondió con HTTP ${apiResponse.status}.`);
  }

  const payload = await apiResponse.json();
  const errors = payload.errors;
  const hasErrors = Array.isArray(errors)
    ? errors.length > 0
    : errors && Object.keys(errors).length > 0;

  if (hasErrors) {
    throw new Error(`API-Football devolvió un error: ${JSON.stringify(errors)}`);
  }

  if (!Array.isArray(payload.response)) {
    throw new Error("La respuesta de API-Football no contiene partidos.");
  }

  return fixturesToCalendar(payload.response);
}

function unfoldIcs(value) {
  return value.replace(/\r?\n[ \t]/g, "");
}

function readProperty(eventBlock, propertyName) {
  const unfolded = unfoldIcs(eventBlock);
  const pattern = new RegExp(`^${propertyName}(?:;[^:]*)?:(.*)$`, "mi");
  const match = unfolded.match(pattern);
  return match ? match[1].trim() : "";
}

function parseIcsDate(value) {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/
  );

  if (!match) {
    return NaN;
  }

  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function phaseForDate(start) {
  if (start < Date.UTC(2026, 5, 28)) return "Fase de grupos";
  if (start < Date.UTC(2026, 6, 4)) return "Dieciseisavos de final";
  if (start < Date.UTC(2026, 6, 8)) return "Octavos de final";
  if (start < Date.UTC(2026, 6, 12)) return "Cuartos de final";
  if (start < Date.UTC(2026, 6, 16)) return "Semifinal";
  if (start < Date.UTC(2026, 6, 19)) return "Tercer puesto";
  return "Final";
}

function localizeSummary(summary) {
  return summary
    .replace(/\bSpain\b/gi, "España")
    .replace(/\bCape Verde\b/gi, "Cabo Verde")
    .replace(/\bSaudi Arabia\b/gi, "Arabia Saudí");
}

function isSpainWorldCupEvent(eventBlock) {
  const summary = readProperty(eventBlock, "SUMMARY");
  const start = parseIcsDate(readProperty(eventBlock, "DTSTART"));

  return (
    /\b(spain|españa)\b/i.test(summary) &&
    Number.isFinite(start) &&
    start >= TOURNAMENT_START &&
    start < TOURNAMENT_END
  );
}

function cleanEvent(eventBlock) {
  const start = parseIcsDate(readProperty(eventBlock, "DTSTART"));
  const summary = localizeSummary(readProperty(eventBlock, "SUMMARY"));
  const description = `${phaseForDate(start)} · Copa Mundial de la FIFA 2026`;
  let cleaned = eventBlock.replace(
    /^SUMMARY(?:;[^:]*)?:.*$/mi,
    `SUMMARY:${summary}`
  );

  if (/^DESCRIPTION(?:;[^:]*)?:/mi.test(cleaned)) {
    cleaned = cleaned.replace(
      /^DESCRIPTION(?:;[^:]*)?:.*(?:\r?\n[ \t].*)*/mi,
      `DESCRIPTION:${description}`
    );
  } else {
    cleaned = cleaned.replace(
      /^END:VEVENT/im,
      `DESCRIPTION:${description}\r\nEND:VEVENT`
    );
  }

  return cleaned;
}

function filterWorldCupEvents(icsText) {
  const eventPattern = /BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/gi;
  const events = icsText.match(eventPattern) || [];
  const firstEventIndex = icsText.search(/BEGIN:VEVENT/i);

  if (firstEventIndex < 0 || events.length === 0) {
    throw new Error("El feed de origen no contiene eventos.");
  }

  const lastEvent = events.at(-1);
  const lastEventIndex = icsText.lastIndexOf(lastEvent);
  const header = icsText.slice(0, firstEventIndex);
  const footer = icsText.slice(lastEventIndex + lastEvent.length);
  const filteredEvents = events.filter(isSpainWorldCupEvent).map(cleanEvent);

  return [
    header
      .replace(/^X-WR-CALNAME:.*$/im, "X-WR-CALNAME:España · Mundial 2026")
      .replace(/^X-WR-CALDESC:.*$/im, "X-WR-CALDESC:Partidos de España en el Mundial 2026"),
    ...filteredEvents,
    footer
  ].join("");
}

async function fetchFallbackCalendar() {
  const upstreamResponse = await fetch(UPSTREAM_FEED_URL, {
    headers: {
      Accept: "text/calendar",
      "User-Agent": "Spain-Mundial-Calendar/1.0"
    }
  });

  if (!upstreamResponse.ok) {
    throw new Error(`El proveedor ICS respondió con HTTP ${upstreamResponse.status}.`);
  }

  return filterWorldCupEvents(await upstreamResponse.text());
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Método no permitido");
  }

  try {
    let calendar;
    let source = "ics-fallback";
    const apiKey = process.env.API_FOOTBALL_KEY;

    if (apiKey) {
      try {
        calendar = await fetchApiFootballCalendar(apiKey);
        source = "api-football";
      } catch (apiError) {
        console.error("API-Football falló; se usará el respaldo ICS.", apiError);
      }
    }

    if (!calendar) {
      calendar = await fetchFallbackCalendar();
    }

    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'inline; filename="espana-mundial-2026.ics"'
    );
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Calendar-Source", source);
    response.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );

    if (request.method === "HEAD") {
      return response.status(200).end();
    }

    return response.status(200).send(calendar);
  } catch (error) {
    console.error("No se pudo generar el calendario.", error);
    return response.status(502).json({
      error: "No se pudo actualizar el calendario de España."
    });
  }
};
