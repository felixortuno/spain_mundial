"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAdminToken,
  validAdminPassword,
  validAdminToken
} = require("../lib/adminAuth");

test("la contraseña de administrador se valida solo en servidor", () => {
  assert.equal(validAdminPassword("elonmusk"), true);
  assert.equal(validAdminPassword("incorrecta"), false);
});

test("la sesión de administrador está firmada y caduca", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");
  const token = createAdminToken(now);

  assert.equal(validAdminToken(token, now + 1000), true);
  assert.equal(validAdminToken(`${token}x`, now + 1000), false);
  assert.equal(validAdminToken(token, now + 5 * 60 * 60 * 1000), false);
});
