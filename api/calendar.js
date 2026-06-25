const { loadConfig } = require("../lib/config");
const { BallDontLieFifaProvider } = require("../lib/providers/ballDontLieFifaProvider");

const FALLBACK_FEED_URL =
  "https://ics.fixtur.es/v2/league/fifa-world-cup-2026.ics";
const TOURNAMENT_START = Date.UTC(2026, 5, 11);
const TOURNAMENT_END = Date.UTC(2026, 6, 20);
const MAX_SELECTED_TEAMS = 8;

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
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString()
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

function phaseForDate(start) {
  if (start < Date.UTC(2026, 5, 28, 19)) return "Fase de grupos";
  if (start < Date.UTC(2026, 6, 4)) return "Dieciseisavos de final";
  if (start < Date.UTC(2026, 6, 8)) return "Octavos de final";
  if (start < Date.UTC(2026, 6, 12)) return "Cuartos de final";
  if (start < Date.UTC(2026, 6, 16)) return "Semifinal";
  if (start < Date.UTC(2026, 6, 19)) return "Tercer puesto";
  return "Final";
}

function fixtureMatchesSelection(fixture, selectedTeams) {
  const names = [fixture.home?.name, fixture.away?.name].map(normalize);
  return selectedTeams.some((team) =>
    [team.name, team.code, ...(team.aliases || [])].some((alias) =>
      names.includes(normalize(alias))
    )
  );
}

function createFixtureEvent(fixture) {
  const start = Date.parse(fixture.commenceTime);
  if (!Number.isFinite(start)) return null;
  const end = start + 2 * 60 * 60 * 1000;
  const dtStart = formatIcsDate(start);
  const dtEnd = formatIcsDate(end);
  const stamp = formatIcsDate(new Date());
  if (!dtStart || !dtEnd || !stamp) return null;

  const home = localizeTeamName(fixture.home?.name);
  const away = localizeTeamName(fixture.away?.name);
  const goals = fixture.features?.goals || {};
  const hasScore = goals.home != null && goals.away != null;
  const summary = hasScore
    ? `${home} ${goals.home}-${goals.away} ${away}`
    : `${home} - ${away}`;
  const round =
    fixture.competition?.round ||
    fixture.competition?.group ||
    phaseForDate(start);
  const description = `${round} · Copa Mundial de la FIFA 2026`;
  const venue = fixture.features?.venue;
  const location = [venue?.name, venue?.city, venue?.country]
    .filter(Boolean)
    .join(", ");

  return [
    "BEGIN:VEVENT",
    `UID:balldontlie-${escapeIcsText(fixture.id)}@mundial-2026`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    location ? `LOCATION:${escapeIcsText(location)}` : null,
    "STATUS:CONFIRMED",
    "END:VEVENT"
  ].filter(Boolean).join("\r\n");
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

function calendarFromFixtures(fixtures, selectedTeams) {
  const filtered = (fixtures || [])
    .filter((fixture) => {
      const start = Date.parse(fixture.commenceTime);
      return (
        Number.isFinite(start) &&
        start >= TOURNAMENT_START &&
        start < TOURNAMENT_END &&
        fixtureMatchesSelection(fixture, selectedTeams)
      );
    })
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime))
    .map(createFixtureEvent)
    .filter(Boolean);

  return createCalendar(
    filtered,
    selectedTeams,
    "-//Mundial 2026 Dashboard//balldontlie//ES"
  );
}

async function fetchBallDontLieCalendar(selectedTeams) {
  const config = loadConfig();
  if (!config.ballDontLieApiKey) return null;

  const provider = new BallDontLieFifaProvider({
    apiKey: config.ballDontLieApiKey,
    ...config.ballDontLie
  });
  const result = await provider.getFixtures();
  return calendarFromFixtures(result.data, selectedTeams);
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
    let source = "balldontlie";
    let calendar = null;
    try {
      calendar = await fetchBallDontLieCalendar(selectedTeams);
    } catch (ballDontLieError) {
      console.warn(
        "No se pudo generar el calendario desde balldontlie; usando Fixtur.es.",
        ballDontLieError.message
      );
    }
    if (!calendar) {
      source = "fixtur.es";
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
