"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAdminToken,
  validAdminPassword,
  validAdminToken
} = require("../lib/adminAuth");

test("la contraseña de administrador se valida solo en servidor", () => {
  const previous = process.env.PRO_ADMIN_PASSWORD;
  process.env.PRO_ADMIN_PASSWORD = "una-contrasena-de-prueba";
  assert.equal(validAdminPassword("una-contrasena-de-prueba"), true);
  assert.equal(validAdminPassword("incorrecta"), false);
  if (previous === undefined) delete process.env.PRO_ADMIN_PASSWORD;
  else process.env.PRO_ADMIN_PASSWORD = previous;
});

test("el administrador queda deshabilitado si falta su contraseña", () => {
  const previous = process.env.PRO_ADMIN_PASSWORD;
  delete process.env.PRO_ADMIN_PASSWORD;
  assert.throws(
    () => validAdminPassword("cualquier-valor"),
    (error) => error.code === "MISSING_ADMIN_PASSWORD"
  );
  if (previous === undefined) delete process.env.PRO_ADMIN_PASSWORD;
  else process.env.PRO_ADMIN_PASSWORD = previous;
});

test("la sesión de administrador está firmada y caduca", () => {
  const previous = process.env.PRO_ADMIN_PASSWORD;
  process.env.PRO_ADMIN_PASSWORD = "primera-contrasena";
  const now = Date.parse("2026-06-11T12:00:00Z");
  const token = createAdminToken(now);

  assert.equal(validAdminToken(token, now + 1000), true);
  assert.equal(validAdminToken(`${token}x`, now + 1000), false);
  assert.equal(validAdminToken(token, now + 5 * 60 * 60 * 1000), false);
  process.env.PRO_ADMIN_PASSWORD = "segunda-contrasena";
  assert.equal(validAdminToken(token, now + 1000), false);
  if (previous === undefined) delete process.env.PRO_ADMIN_PASSWORD;
  else process.env.PRO_ADMIN_PASSWORD = previous;
});
