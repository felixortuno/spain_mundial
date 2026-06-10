"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CacheStore } = require("../lib/cache");

test("CacheStore devuelve stale si falla la actualización", async () => {
  const cache = new CacheStore(`test-${Date.now()}`);
  let calls = 0;
  const first = await cache.getOrLoad({
    key: "fixture",
    ttlMs: 0,
    staleTtlMs: 10000,
    loader: async () => {
      calls++;
      return { data: { id: 1 }, metadata: { remaining: 9 } };
    }
  });

  const stale = await cache.getOrLoad({
    key: "fixture",
    ttlMs: 0,
    staleTtlMs: 10000,
    loader: async () => {
      calls++;
      throw new Error("429");
    }
  });

  assert.equal(first.data.id, 1);
  assert.equal(stale.data.id, 1);
  assert.equal(stale.cache.status, "stale");
  assert.equal(calls, 2);
});
