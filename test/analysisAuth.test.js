"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDeviceToken,
  createSessionToken,
  setDeviceCookie,
  setSessionCookie,
  userIdFromToken,
  validSessionToken
} = require("../lib/analysisAuth");

test("la sesión firmada caduca y no admite firmas modificadas", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");
  const userId = "a".repeat(64);
  const token = createSessionToken(userId, now);

  assert.equal(validSessionToken(token, now + 1000), true);
  assert.equal(validSessionToken(`${token}x`, now + 1000), false);
  assert.equal(validSessionToken(token, now + 31 * 60 * 1000), false);
});

test("el dispositivo recordado usa una credencial distinta y duradera", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");
  const userId = "b".repeat(64);
  const token = createDeviceToken(userId, now);

  assert.equal(userIdFromToken(token, "device", now + 1000), userId);
  assert.equal(userIdFromToken(token, "session", now + 1000), null);
  assert.equal(
    userIdFromToken(token, "device", now + 181 * 24 * 60 * 60 * 1000),
    null
  );
});

test("el login puede enviar juntas la sesión corta y la del dispositivo", () => {
  const headers = new Map();
  const response = {
    getHeader: (name) => headers.get(name),
    setHeader: (name, value) => headers.set(name, value)
  };
  const request = { headers: {} };
  const userId = "c".repeat(64);

  setSessionCookie(response, request, userId);
  setDeviceCookie(response, request, userId);

  const cookies = headers.get("Set-Cookie");
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^mundial_pro_session=/);
  assert.match(cookies[1], /^mundial_pro_device=/);
});
