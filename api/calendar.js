const UPSTREAM_FEED_URL = "https://ics.fixtur.es/v2/es.ics";
const TOURNAMENT_START = Date.UTC(2026, 5, 11);
const TOURNAMENT_END = Date.UTC(2026, 6, 20);

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

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).send("Método no permitido");
  }

  try {
    const upstreamResponse = await fetch(UPSTREAM_FEED_URL, {
      headers: {
        Accept: "text/calendar",
        "User-Agent": "Spain-Mundial-Calendar/1.0"
      }
    });

    if (!upstreamResponse.ok) {
      throw new Error(`El proveedor respondió con HTTP ${upstreamResponse.status}.`);
    }

    const icsText = await upstreamResponse.text();
    const filteredCalendar = filterWorldCupEvents(icsText);

    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'inline; filename="espana-mundial-2026.ics"'
    );
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
    );

    if (request.method === "HEAD") {
      return response.status(200).end();
    }

    return response.status(200).send(filteredCalendar);
  } catch (error) {
    console.error("No se pudo generar el calendario.", error);
    return response.status(502).json({
      error: "No se pudo actualizar el calendario de España."
    });
  }
};
