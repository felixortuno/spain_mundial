const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";
const WORLD_CUP_LEAGUE_ID = "1";
const WORLD_CUP_SEASON = "2026";
const FALLBACK_FEED_URL =
  "https://ics.fixtur.es/v2/league/fifa-world-cup-2026.ics";
const TOURNAMENT_START = Date.UTC(2026, 5, 11);
const TOURNAMENT_END = Date.UTC(2026, 6, 20);
const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_SELECTED_TEAMS = 8;
const API_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

let apiDisabledUntil = 0;

const TEAMS = [
  ["ALG", "Argelia", ["Algeria"]],
  ["ARG", "Argentina", ["Argentina"]],
  ["AUS", "Australia", ["Australia"]],
  ["AUT", "Austria", ["Austria"]],
  ["BEL", "Bélgica", ["Belgium"]],
  ["BIH", "Bosnia y Herzegovina", ["Bosnia and Herzegovina"]],
  ["BRA", "Brasil", ["Brazil"]],
  ["CAN", "Canadá", ["Canada"]],
  ["CPV", "Cabo Verde", ["Cape Verde"]],
  ["COL", "Colombia", ["Colombia"]],
  ["CRO", "Croacia", ["Croatia"]],
  ["CUW", "Curazao", ["Curaçao", "Curacao"]],
  ["CZE", "Chequia", ["Czech Republic", "Czechia"]],
  ["COD", "RD Congo", ["DR Congo", "Congo DR"]],
  ["ECU", "Ecuador", ["Ecuador"]],
  ["EGY", "Egipto", ["Egypt"]],
  ["ENG", "Inglaterra", ["England"]],
  ["FRA", "Francia", ["France"]],
  ["GER", "Alemania", ["Germany"]],
  ["GHA", "Ghana", ["Ghana"]],
  ["HAI", "Haití", ["Haiti"]],
  ["IRN", "Irán", ["Iran"]],
  ["IRQ", "Irak", ["Iraq"]],
  ["CIV", "Costa de Marfil", ["Ivory Coast", "Côte d'Ivoire"]],
  ["JPN", "Japón", ["Japan"]],
  ["JOR", "Jordania", ["Jordan"]],
  ["MEX", "México", ["Mexico"]],
  ["MAR", "Marruecos", ["Morocco"]],
  ["NED", "Países Bajos", ["Netherlands"]],
  ["NZL", "Nueva Zelanda", ["New Zealand"]],
  ["NOR", "Noruega", ["Norway"]],
  ["PAN", "Panamá", ["Panama"]],
  ["PAR", "Paraguay", ["Paraguay"]],
  ["POR", "Portugal", ["Portugal"]],
  ["QAT", "Catar", ["Qatar"]],
  ["KSA", "Arabia Saudí", ["Saudi Arabia"]],
  ["SCO", "Escocia", ["Scotland"]],
  ["SEN", "Senegal", ["Senegal"]],
  ["RSA", "Sudáfrica", ["South Africa"]],
  ["KOR", "Corea del Sur", ["South Korea", "Korea Republic"]],
  ["ESP", "España", ["Spain", "España"]],
  ["SWE", "Suecia", ["Sweden"]],
  ["SUI", "Suiza", ["Switzerland"]],
  ["TUN", "Túnez", ["Tunisia"]],
  ["TUR", "Turquía", ["Türkiye", "Turkey"]],
  ["USA", "Estados Unidos", ["United States", "USA"]],
  ["URU", "Uruguay", ["Uruguay"]],
  ["UZB", "Uzbekistán", ["Uzbekistan"]]
].map(([code, name, aliases]) => ({ code, name, aliases }));

const TEAM_BY_CODE = new Map(TEAMS.map((team) => [team.code, team]));
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

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function selectedTeamsFromRequest(request) {
  const requestUrl = new URL(request.url || "/", "https://calendar.local");
  const raw =
    request.query?.teams ||
    requestUrl.searchParams.get("teams") ||
    "ESP";
  const codes = String(raw)
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code, index, values) => TEAM_BY_CODE.has(code) && values.indexOf(code) === index)
    .slice(0, MAX_SELECTED_TEAMS);

  return (codes.length ? codes : ["ESP"]).map((code) => TEAM_BY_CODE.get(code));
}

function calendarName(selectedTeams) {
  if (selectedTeams.length === 1) {
    return `${selectedTeams[0].name} · Mundial 2026`;
  }

  if (selectedTeams.length <= 3) {
    return `${selectedTeams.map((team) => team.name).join(", ")} · Mundial 2026`;
  }

  return `${selectedTeams.length} selecciones · Mundial 2026`;
}

function localizeTeamName(name) {
  const normalizedName = normalize(name);
  const team = TEAMS.find((candidate) =>
    candidate.aliases.some((alias) => normalize(alias) === normalizedName)
  );
  return team?.name || name || "Por confirmar";
}

function localizeSummary(summary) {
  let localized = String(summary || "");
  const aliases = TEAMS.flatMap((team) =>
    team.aliases.map((alias) => ({ alias, name: team.name }))
  ).sort((a, b) => b.alias.length - a.alias.length);

  for (const { alias, name } of aliases) {
    localized = localized.replace(
      new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"),
      name
    );
  }

  return localized;
}

function translateRound(round) {
  const normalized = normalize(round);
  if (normalized.includes("group")) return "Fase de grupos";
  if (normalized.includes("round of 32")) return "Dieciseisavos de final";
  if (normalized.includes("round of 16")) return "Octavos de final";
  if (normalized.includes("quarter")) return "Cuartos de final";
  if (normalized.includes("semi")) return "Semifinal";
  if (normalized.includes("third")) return "Tercer puesto";
  if (normalized.includes("final")) return "Final";
  return round || "Copa Mundial de la FIFA 2026";
}

function phaseForDate(start) {
  if (start < Date.UTC(2026, 5, 28, 19)) return "Fase de grupos";
  if (start < Date.UTC(2026, 6, 4)) return "Dieciseisavos de final";
  if (start < Date.UTC(2026, 6, 8)) return "Octavos de final";
  if (start < Date.UTC(2026, 6, 12)) return "Cuartos de final";
  if (start < Date.UTC(2026, 6, 16)) return "Semifinal";
  if (start < Date.UTC(2026, 6, 19)) return "Tercer puesto";
  return "Final";
}

function apiTeamMatches(team, selectedTeams) {
  const teamCode = String(team?.code || "").toUpperCase();
  const teamName = normalize(team?.name);
  return selectedTeams.some(
    (selected) =>
      teamCode === selected.code ||
      selected.aliases.some((alias) => normalize(alias) === teamName)
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
  if (!Number.isFinite(start)) return "";

  const venue = fixture.fixture?.venue || {};
  const location = [venue.name, venue.city].filter(Boolean).join(", ");
  const rawStatus = fixture.fixture?.status?.long;
  const status = MATCH_STATUS_ES.get(rawStatus) || rawStatus;
  const description = [
    translateRound(fixture.league?.round),
    "Copa Mundial de la FIFA 2026",
    status
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    "BEGIN:VEVENT",
    `UID:api-football-${fixture.fixture.id}@spain-mundial.vercel.app`,
    `DTSTAMP:${formatIcsDate(Date.now())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(start + MATCH_DURATION_MS)}`,
    `SUMMARY:${escapeIcsText(fixtureSummary(fixture))}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    location ? `LOCATION:${escapeIcsText(location)}` : "",
    `STATUS:${fixture.fixture?.status?.short === "CANC" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT"
  ]
    .filter(Boolean)
    .join("\r\n");
}

function createCalendar(events, selectedTeams, productId) {
  if (events.length === 0) {
    throw new Error("No hay partidos publicados para la selección elegida.");
  }

  const name = calendarName(selectedTeams);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${productId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    `X-WR-CALDESC:${escapeIcsText(`Partidos de ${name}`)}`,
    "X-PUBLISHED-TTL:PT1H",
    ...events,
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

function fixturesToCalendar(fixtures, selectedTeams) {
  const filtered = fixtures
    .filter(
      (fixture) =>
        apiTeamMatches(fixture.teams?.home, selectedTeams) ||
        apiTeamMatches(fixture.teams?.away, selectedTeams)
    )
    .sort(
      (a, b) =>
        Date.parse(a.fixture?.date || 0) - Date.parse(b.fixture?.date || 0)
    );

  return createCalendar(
    filtered.map(fixtureToIcsEvent).filter(Boolean),
    selectedTeams,
    "-//Mundial 2026 Dashboard//API-Football//ES"
  );
}

async function fetchApiFootballCalendar(apiKey, selectedTeams) {
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

  return fixturesToCalendar(payload.response, selectedTeams);
}

function unfoldIcs(value) {
  return value.replace(/\r?\n[ \t]/g, "");
}

function readProperty(eventBlock, propertyName) {
  const unfolded = unfoldIcs(eventBlock);
  const pattern = new RegExp(`^${propertyName}(?:;[^:]*)?:(.*)$`, "mi");
  return unfolded.match(pattern)?.[1]?.trim() || "";
}

function parseIcsDate(value) {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/
  );
  if (!match) return NaN;

  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
}

function summaryMatchesSelection(summary, selectedTeams) {
  const normalizedSummary = normalize(summary);
  return selectedTeams.some((team) =>
    team.aliases.some((alias) => normalizedSummary.includes(normalize(alias)))
  );
}

function cleanFallbackEvent(eventBlock) {
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

  return cleaned.trim();
}

function filterFallbackCalendar(icsText, selectedTeams) {
  const events = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/gi) || [];
  const filtered = events
    .filter((eventBlock) => {
      const start = parseIcsDate(readProperty(eventBlock, "DTSTART"));
      return (
        Number.isFinite(start) &&
        start >= TOURNAMENT_START &&
        start < TOURNAMENT_END &&
        summaryMatchesSelection(readProperty(eventBlock, "SUMMARY"), selectedTeams)
      );
    })
    .map(cleanFallbackEvent)
    .sort(
      (a, b) =>
        parseIcsDate(readProperty(a, "DTSTART")) -
        parseIcsDate(readProperty(b, "DTSTART"))
    );

  return createCalendar(
    filtered,
    selectedTeams,
    "-//Mundial 2026 Dashboard//Fixtur.es//ES"
  );
}

async function fetchFallbackCalendar(selectedTeams) {
  const upstreamResponse = await fetch(FALLBACK_FEED_URL, {
    headers: {
      Accept: "text/calendar",
      "User-Agent": "Mundial-2026-Dashboard/2.0"
    }
  });

  if (!upstreamResponse.ok) {
    throw new Error(`El proveedor ICS respondió con HTTP ${upstreamResponse.status}.`);
  }

  return filterFallbackCalendar(await upstreamResponse.text(), selectedTeams);
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Método no permitido");
  }

  const selectedTeams = selectedTeamsFromRequest(request);

  try {
    let calendar;
    let source = "ics-fallback";
    const apiKey = process.env.API_FOOTBALL_KEY;

    const seasonDataEnabled =
      process.env.API_FOOTBALL_SEASON_DATA_ENABLED !== "false";

    if (seasonDataEnabled && apiKey && Date.now() >= apiDisabledUntil) {
      try {
        calendar = await fetchApiFootballCalendar(apiKey, selectedTeams);
        source = "api-football";
      } catch (apiError) {
        apiDisabledUntil = Date.now() + API_RETRY_DELAY_MS;
        console.warn("API-Football no está disponible; se usará el respaldo ICS.", apiError);
      }
    }

    if (!calendar) {
      calendar = await fetchFallbackCalendar(selectedTeams);
    }

    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'inline; filename="mundial-2026.ics"'
    );
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("X-Calendar-Source", source);
    response.setHeader(
      "X-Selected-Teams",
      selectedTeams.map((team) => team.code).join(",")
    );
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
      error: "No se pudo actualizar el calendario del Mundial."
    });
  }
};
