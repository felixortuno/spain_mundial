"use strict";

const GLOBAL_RATE_LIMIT_KEY = "__SPAIN_MUNDIAL_RATE_LIMITS__";

function rateLimitStore() {
  if (!globalThis[GLOBAL_RATE_LIMIT_KEY]) {
    globalThis[GLOBAL_RATE_LIMIT_KEY] = new Map();
  }
  return globalThis[GLOBAL_RATE_LIMIT_KEY];
}

function clientIp(request) {
  const forwarded =
    request.headers?.["x-vercel-forwarded-for"] ||
    request.headers?.["x-forwarded-for"] ||
    request.socket?.remoteAddress ||
    "unknown";
  return String(forwarded).split(",")[0].trim() || "unknown";
}

function consumeRateLimit({
  request,
  scope,
  limit,
  windowMs,
  now = Date.now()
}) {
  const store = rateLimitStore();
  const key = `${scope}:${clientIp(request)}`;
  const current = store.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;

  entry.count += 1;
  store.set(key, entry);

  return {
    allowed: entry.count <= limit,
    limit,
    remaining: Math.max(0, limit - entry.count),
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    resetAt: entry.resetAt
  };
}

function applyRateLimitHeaders(response, result) {
  response.setHeader("RateLimit-Limit", String(result.limit));
  response.setHeader("RateLimit-Remaining", String(result.remaining));
  response.setHeader(
    "RateLimit-Reset",
    String(Math.ceil(result.resetAt / 1000))
  );
  if (!result.allowed) {
    response.setHeader("Retry-After", String(result.retryAfter));
  }
}

module.exports = {
  applyRateLimitHeaders,
  clientIp,
  consumeRateLimit
};
