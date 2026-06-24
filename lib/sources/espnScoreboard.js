"use strict";

/**
 * Segunda fuente (corroboración): scoreboard público de ESPN en JSON.
 *
 * No sustituye a Wikipedia: confirma marcadores ya recolectados para poder
 * elevar la confianza a "alta" cuando ambas fuentes coinciden, o marcar
 * discrepancia si no. ESPN no expone goleadores en el scoreboard, así que esta
 * fuente solo aporta resultados (team1/team2/score/status/date).
 *
 * Configurable por entorno:
 *   ESPN_WORLDCUP_LEAGUE=fifa.world   (slug del Mundial en ESPN)
 *   ESPN_MAX_DATES=30                 (tope de fechas a consultar)
 */

const DEFAULT_USER_AGENT =
  "spain-mundial/1.0 (Mundial 2026 stats cross-check; +https://github.com/)";

function parseEspnScoreboard(json) {
  const out = [];
  for (const event of json?.events || []) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;
    const completed =
      comp.status?.type?.completed ?? event.status?.type?.completed ?? false;
    if (!completed) continue;

    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
    const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
    if (!home || !away) continue;

    const homeScore = Number(home.score);
    const awayScore = Number(away.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

    const teamName = (c) =>
      c.team?.displayName || c.team?.name || c.team?.shortDisplayName || null;
    const team1 = teamName(home);
    const team2 = teamName(away);
    if (!team1 || !team2) continue;

    const date = String(event.date || comp.date || "").slice(0, 10) || null;
    const statusName = String(comp.status?.type?.name || "").toLowerCase();
    let status = "FT";
    if (/pen|shootout/.test(statusName)) status = "PEN";
    else if (/extra|aet/.test(statusName)) status = "AET";

    out.push({
      team1,
      team2,
      score: { home: homeScore, away: awayScore },
      status,
      date,
    });
  }
  return out;
}

function dedupe(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const key = `${m.team1}|${m.team2}|${m.date}|${m.score.home}-${m.score.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

async function fetchEspnMatchesForDates(dates, {
  league = process.env.ESPN_WORLDCUP_LEAGUE || "fifa.world",
  userAgent = process.env.ESPN_USER_AGENT || DEFAULT_USER_AGENT,
  fetchImpl = fetch,
} = {}) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;
  const all = [];
  for (const date of dates) {
    try {
      const url = `${base}?dates=${String(date).replace(/-/g, "")}`;
      const res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
      });
      if (!res.ok) continue;
      all.push(...parseEspnScoreboard(await res.json()));
    } catch {
      // Una fecha caída no debe tumbar la corroboración.
    }
  }
  return { matches: dedupe(all), source: { name: "ESPN", url: base } };
}

module.exports = {
  parseEspnScoreboard,
  fetchEspnMatchesForDates,
};
