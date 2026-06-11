"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clientIp, consumeRateLimit } = require("../lib/rateLimit");

test("obtiene la primera IP reenviada por Vercel", () => {
  const request = {
    headers: { "x-vercel-forwarded-for": "203.0.113.10, 10.0.0.1" }
  };
  assert.equal(clientIp(request), "203.0.113.10");
});

test("bloquea al superar el límite dentro de la ventana", () => {
  const request = {
    headers: { "x-vercel-forwarded-for": "203.0.113.11" }
  };
  const scope = `test-${Date.now()}`;
  const first = consumeRateLimit({
    request,
    scope,
    limit: 2,
    windowMs: 60_000,
    now: 1_000
  });
  const second = consumeRateLimit({
    request,
    scope,
    limit: 2,
    windowMs: 60_000,
    now: 2_000
  });
  const third = consumeRateLimit({
    request,
    scope,
    limit: 2,
    windowMs: 60_000,
    now: 3_000
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
});
