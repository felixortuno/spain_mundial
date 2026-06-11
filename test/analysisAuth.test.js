"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionToken,
  validPassword,
  validSessionToken
} = require("../lib/analysisAuth");

test("la clave configurada desbloquea el análisis", () => {
  assert.equal(validPassword("611476090"), true);
  assert.equal(validPassword("611476091"), false);
});

test("la sesión firmada caduca y no admite firmas modificadas", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");
  const token = createSessionToken(now);

  assert.equal(validSessionToken(token, now + 1000), true);
  assert.equal(validSessionToken(`${token}x`, now + 1000), false);
  assert.equal(validSessionToken(token, now + 13 * 60 * 60 * 1000), false);
});
