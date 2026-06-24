"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFootballBoxes,
  cleanTeam,
  parseWikiDate,
  parseScorers,
  fetchWorldCupMatches,
} = require("../lib/sources/wikipediaWorldCup");

// Wikitexto representativo: 2 partidos finalizados + 1 sin jugar (sin marcador).
const WIKITEXT = `
Algo de prosa antes.

{{Football box
|date={{dts|2026|6|24}}
|team1={{fb|ESP}}
|score=3–1
|team2={{fb|MAR}}
|goals1=[[Lamine Yamal]] {{goal|12|66}}<br>[[Álvaro Morata]] {{goal|45+2}}
|goals2=[[Achraf Hakimi]] {{pen|80}}
|stadium=Estadio X
}}

{{Football box
|date={{dts|2026|6|24}}
|team1={{fb|FRA}}
|score=0–0
|team2={{fb|BEL}}
|goals1=
|goals2=
}}

{{Football box
|date={{dts|2026|6|25}}
|team1={{fb|BRA}}
|score=v
|team2={{fb|ARG}}
}}
`;

test("cleanTeam resuelve códigos FIFA y wikienlaces", () => {
  assert.equal(cleanTeam("{{fb|ESP}}"), "Spain");
  assert.equal(cleanTeam("{{ESP}}"), "Spain");
  assert.equal(cleanTeam("[[Spain national football team|Spain]]"), "Spain");
  assert.equal(cleanTeam("[[Morocco]]"), "Morocco");
});

test("parseWikiDate entiende {{dts}} y texto plano", () => {
  assert.equal(parseWikiDate("{{dts|2026|6|24}}"), "2026-06-24");
  assert.equal(parseWikiDate("24 June 2026"), "2026-06-24");
  assert.equal(parseWikiDate(""), null);
});

test("parseScorers cuenta minutos por jugador y excluye autogoles", () => {
  const s = parseScorers(
    "[[A B]] {{goal|12|66}}<br>[[C D]] {{pen|80}}<br>[[E F]] {{o.g.|30}}",
    "Spain"
  );
  assert.equal(s.length, 2); // el autogol no cuenta como goleador
  assert.equal(s[0].name, "A B");
  assert.equal(s[0].goals, 2);
  assert.equal(s[1].goals, 1);
});

test("parseFootballBoxes solo devuelve partidos finalizados", () => {
  const matches = parseFootballBoxes(WIKITEXT);
  assert.equal(matches.length, 2); // se ignora el "v" (no jugado)

  const esp = matches.find((m) => m.team1 === "Spain");
  assert.deepEqual(esp.score, { home: 3, away: 1 });
  assert.equal(esp.status, "FT");
  assert.equal(esp.date, "2026-06-24");
  // 3 goles del local repartidos en 2 jugadores, 1 del visitante
  assert.equal(esp.scorers.reduce((a, s) => a + s.goals, 0), 4);
  const yamal = esp.scorers.find((s) => s.name === "Lamine Yamal");
  assert.equal(yamal.goals, 2);

  const fra = matches.find((m) => m.team1 === "France");
  assert.deepEqual(fra.score, { home: 0, away: 0 });
});

test("fetchWorldCupMatches usa fetch inyectado y deduplica", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ parse: { wikitext: WIKITEXT } }),
  });
  const { matches, sources } = await fetchWorldCupMatches({
    pages: ["Page A", "Page B"], // misma respuesta → debe deduplicar
    fetchImpl: fakeFetch,
  });
  assert.equal(matches.length, 2); // 2 únicos pese a 2 páginas
  assert.ok(sources.length >= 1);
  assert.ok(sources[0].url.includes("wikipedia.org"));
});
