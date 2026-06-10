"use strict";

const GLOBAL_CACHE_KEY = "__SPAIN_MUNDIAL_PROVIDER_CACHE__";

function globalCache() {
  if (!globalThis[GLOBAL_CACHE_KEY]) {
    globalThis[GLOBAL_CACHE_KEY] = new Map();
  }
  return globalThis[GLOBAL_CACHE_KEY];
}

class CacheStore {
  constructor(namespace) {
    this.namespace = namespace;
    this.entries = globalCache();
  }

  namespacedKey(key) {
    return `${this.namespace}:${key}`;
  }

  get(key) {
    return this.entries.get(this.namespacedKey(key));
  }

  set(key, data, metadata, ttlMs, staleTtlMs) {
    const now = Date.now();
    const entry = {
      data,
      metadata: metadata || {},
      storedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
      staleUntil: now + Math.max(ttlMs, staleTtlMs)
    };
    this.entries.set(this.namespacedKey(key), entry);
    return entry;
  }

  clear() {
    const prefix = `${this.namespace}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async getOrLoad({ key, ttlMs, staleTtlMs, loader }) {
    const now = Date.now();
    const cached = this.get(key);

    if (cached && cached.expiresAt > now) {
      return {
        data: cached.data,
        metadata: cached.metadata,
        cache: { status: "fresh", storedAt: cached.storedAt }
      };
    }

    try {
      const loaded = await loader();
      const entry = this.set(
        key,
        loaded.data,
        loaded.metadata,
        ttlMs,
        staleTtlMs
      );
      return {
        data: entry.data,
        metadata: entry.metadata,
        cache: { status: cached ? "refreshed" : "miss", storedAt: entry.storedAt }
      };
    } catch (error) {
      if (cached && cached.staleUntil > now) {
        console.warn(
          `[cache:${this.namespace}] Se usa una respuesta stale para ${key}:`,
          error.message
        );
        return {
          data: cached.data,
          metadata: {
            ...cached.metadata,
            staleReason: error.message
          },
          cache: { status: "stale", storedAt: cached.storedAt }
        };
      }
      throw error;
    }
  }
}

module.exports = { CacheStore };
