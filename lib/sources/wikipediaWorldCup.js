"use strict";

/**
 * Fuente web de respaldo: resultados del Mundial 2026 desde Wikipedia.
 *
 * Parsea las plantillas {{Football box}} del wikitexto (formato estable y
 * documentado) para extraer partidos FINALIZADOS con marcador, fecha y
 * goleadores. No estima nada: si un partido no tiene marcador numérico, se
 * ignora (no jugado / en juego).
 *
 * Páginas y plantilla son configurables por entorno porque los títulos exactos
 * de los subartículos pueden variar:
 *   WIKI_WORLDCUP_LANG=en
 *   WIKI_WORLDCUP_PAGES=2026 FIFA World Cup group stage,2026 FIFA World Cup knockout stage
 */

// Códigos FIFA/IOC → nombre de selección (mejor esfuerzo; se amplía por env).
// Si falta un código, se usa el propio código como nombre.
const COUNTRY_CODES = {
  ARG: "Argentina", BRA: "Brazil", FRA: "France", ESP: "Spain", ENG: "England",
  GER: "Germany", POR: "Portugal", NED: "Netherlands", BEL: "Belgium", ITA: "Italy",
  CRO: "Croatia", URU: "Uruguay", COL: "Colombia", MEX: "Mexico", USA: "United States",
  CAN: "Canada", MAR: "Morocco", SEN: "Senegal", JPN: "Japan", KOR: "South Korea",
  AUS: "Australia", SUI: "Switzerland", DEN: "Denmark", SRB: "Serbia", POL: "Poland",
  WAL: "Wales", SCO: "Scotland", NOR: "Norway", AUT: "Austria", UKR: "Ukraine",
  TUR: "Turkey", GHA: "Ghana", CMR: "Cameroon", NGA: "Nigeria", CIV: "Ivory Coast",
  EGY: "Egypt", TUN: "Tunisia", ALG: "Algeria", ECU: "Ecuador", PER: "Peru",
  CHI: "Chile", PAR: "Paraguay", IRN: "Iran", KSA: "Saudi Arabia", QAT: "Qatar",
  CRC: "Costa Rica", PAN: "Panama", JAM: "Jamaica", NZL: "New Zealand", RSA: "South Africa",
};

const DEFAULT_USER_AGENT =
  "spain-mundial/1.0 (Mundial 2026 stats fallback; +https://github.com/)";

// ── Extracción de plantillas con emparejado de llaves ──────────────────────────

function extractTemplates(text, name) {
  const out = [];
  const target = name.trim().toLowerCase();
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "{" && text[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length - 1 && depth > 0) {
        if (text[j] === "{" && text[j + 1] === "{") { depth += 1; j += 2; }
        else if (text[j] === "}" && text[j + 1] === "}") { depth -= 1; j += 2; }
        else j += 1;
      }
      const inner = text.slice(i + 2, j - 2);
      const nameEnd = inner.search(/[|}]/);
      const tname = (nameEnd === -1 ? inner : inner.slice(0, nameEnd))
        .trim()
        .toLowerCase();
      if (tname === target) out.push(inner);
      i = j;
    } else {
      i += 1;
    }
  }
  return out;
}

// Divide los parámetros de una plantilla por "|" de primer nivel (respeta
// plantillas y wikienlaces anidados).
function splitParams(inner) {
  const parts = [];
  let depth = 0;
  let link = 0;
  let cur = "";
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    const c2 = inner[i + 1];
    if (c === "{" && c2 === "{") { depth += 1; cur += "{{"; i += 1; continue; }
    if (c === "}" && c2 === "}") { depth -= 1; cur += "}}"; i += 1; continue; }
    if (c === "[" && c2 === "[") { link += 1; cur += "[["; i += 1; continue; }
    if (c === "]" && c2 === "]") { link -= 1; cur += "]]"; i += 1; continue; }
    if (c === "|" && depth === 0 && link === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function paramsOf(inner) {
  const params = {};
  for (const part of splitParams(inner).slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return params;
}

// ── Normalización de equipos, fechas y goleadores ─────────────────────────────

function cleanTeam(raw, codes = COUNTRY_CODES) {
  if (!raw) return null;
  const s = raw.trim();
  const link = s.match(/\[\[([^\]]+)\]\]/);
  if (link) {
    const target = link[1];
    const name = target.includes("|") ? target.split("|").pop() : target;
    return name.replace(/ national (football|soccer) team/i, "").trim() || null;
  }
  const tpl = s.match(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}|]+?)\s*)?\}\}/);
  if (tpl) {
    const arg = (tpl[2] || "").trim().toUpperCase();
    if (codes[arg]) return codes[arg];
    const nameOnly = (tpl[1] || "").trim().toUpperCase();
    if (codes[nameOnly]) return codes[nameOnly];
    return (tpl[2] || tpl[1] || "").trim() || null;
  }
  const plain = s.replace(/\{\{[^}]*\}\}/g, "").replace(/'''?/g, "").trim();
  return plain || null;
}

function parseWikiDate(raw) {
  if (!raw) return null;
  const dts = raw.match(
    /\{\{\s*(?:dts|start ?date)\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i
  );
  const generic = dts || raw.match(/(\d{4})\|(\d{1,2})\|(\d{1,2})/);
  if (generic) {
    const [, y, m, d] = generic;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const text = raw.replace(/\{\{[^}]*\}\}/g, " ").replace(/\[\[|\]\]/g, " ").trim();
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    // Date.parse de "24 June 2026" es hora local; tomamos los componentes
    // locales para no desplazar el día al convertir a UTC.
    const d = new Date(parsed);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

// Cuenta goles por jugador en un parámetro goalsX. Cada minuto dentro de
// {{goal|..}} / {{pen|..}} cuenta un gol; los autogoles ({{o.g.}}) no cuentan.
function parseScorers(goalsValue, team) {
  const scorers = [];
  if (!goalsValue) return scorers;
  const lines = goalsValue.split(/\n|<br\s*\/?>/i);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const link = line.match(/\[\[([^\]]+)\]\]/);
    if (!link) continue;
    const target = link[1];
    const name = (target.includes("|") ? target.split("|").pop() : target).trim();
    let goals = 0;
    const tokenRe = /\{\{\s*(goal|pen)\b([^}]*)\}\}/gi;
    let token;
    while ((token = tokenRe.exec(line)) !== null) {
      const args = token[2].split("|").map((x) => x.trim()).filter(Boolean);
      goals += args.length || 1;
    }
    if (goals > 0) scorers.push({ name, team, goals });
  }
  return scorers;
}

// ── Parseo de una caja de partido ─────────────────────────────────────────────

function parseFootballBox(inner, codes = COUNTRY_CODES) {
  const params = paramsOf(inner);
  const scoreMatch = (params.score || "").match(/(\d+)\s*[–\-—:]\s*(\d+)/);
  if (!scoreMatch) return null; // sin marcador numérico → no finalizado
  const home = Number(scoreMatch[1]);
  const away = Number(scoreMatch[2]);
  const team1 = cleanTeam(params.team1, codes);
  const team2 = cleanTeam(params.team2, codes);
  if (!team1 || !team2) return null;

  const blob = `${params.score || ""} ${params.aet || ""} ${params.penaltyscore || ""}`
    .toLowerCase();
  let status = "FT";
  if (params.penaltyscore || params.penalties1 || /\bpen/.test(blob)) status = "PEN";
  else if (/a\.?e\.?t|aet|extra time|prórroga|prorroga/.test(blob)) status = "AET";

  return {
    team1,
    team2,
    score: { home, away },
    status,
    date: parseWikiDate(params.date),
    scorers: [
      ...parseScorers(params.goals1, team1),
      ...parseScorers(params.goals2, team2),
    ],
  };
}

function parseFootballBoxes(wikitext, { templateNames = ["Football box"], codes = COUNTRY_CODES } = {}) {
  const matches = [];
  for (const templateName of templateNames) {
    for (const inner of extractTemplates(wikitext, templateName)) {
      const parsed = parseFootballBox(inner, codes);
      if (parsed) matches.push(parsed);
    }
  }
  return matches;
}

// ── Acceso a la API de Wikipedia ──────────────────────────────────────────────

function pageUrl(lang, page) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}`;
}

async function fetchWikitext(page, { lang, fetchImpl, userAgent }) {
  const api = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  api.searchParams.set("action", "parse");
  api.searchParams.set("page", page);
  api.searchParams.set("prop", "wikitext");
  api.searchParams.set("formatversion", "2");
  api.searchParams.set("format", "json");
  const res = await fetchImpl(api.toString(), {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!res.ok) {
    const error = new Error(`Wikipedia ${res.status} para "${page}"`);
    error.code = "WIKIPEDIA_HTTP";
    throw error;
  }
  const body = await res.json();
  return body?.parse?.wikitext || "";
}

function dedupeMatches(matches) {
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

async function fetchWorldCupMatches({
  lang = process.env.WIKI_WORLDCUP_LANG || "en",
  pages = (process.env.WIKI_WORLDCUP_PAGES ||
    "2026 FIFA World Cup group stage,2026 FIFA World Cup knockout stage")
    .split(",").map((p) => p.trim()).filter(Boolean),
  templateNames = (process.env.WIKI_WORLDCUP_TEMPLATES || "Football box")
    .split(",").map((t) => t.trim()).filter(Boolean),
  userAgent = process.env.WIKI_USER_AGENT || DEFAULT_USER_AGENT,
  fetchImpl = fetch,
} = {}) {
  const collected = [];
  const sources = [];
  for (const page of pages) {
    try {
      const wikitext = await fetchWikitext(page, { lang, fetchImpl, userAgent });
      const parsed = parseFootballBoxes(wikitext, { templateNames });
      if (parsed.length) {
        collected.push(...parsed);
        sources.push({ page, url: pageUrl(lang, page), partidos: parsed.length });
      }
    } catch (error) {
      // Una página caída no debe tumbar el resto.
      sources.push({ page, url: pageUrl(lang, page), error: error.message });
    }
  }
  return { matches: dedupeMatches(collected), sources };
}

module.exports = {
  COUNTRY_CODES,
  extractTemplates,
  splitParams,
  paramsOf,
  cleanTeam,
  parseWikiDate,
  parseScorers,
  parseFootballBox,
  parseFootballBoxes,
  fetchWorldCupMatches,
  pageUrl,
};
