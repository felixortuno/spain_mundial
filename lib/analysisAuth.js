"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "mundial_pro_session";
const DEVICE_COOKIE_NAME = "mundial_pro_device";
const SESSION_SECONDS = 30 * 60;
const DEVICE_SECONDS = 180 * 24 * 60 * 60;

function sessionSecret() {
  if (process.env.ANALYSIS_SESSION_SECRET) {
    return process.env.ANALYSIS_SESSION_SECRET;
  }
  if (process.env.VERCEL) {
    const error = new Error("Falta ANALYSIS_SESSION_SECRET.");
    error.code = "MISSING_SESSION_SECRET";
    throw error;
  }
  return "local-development-pro-session-secret";
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(scope, userId, expires) {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(`${scope}.${userId}.${expires}`)
    .digest("base64url");
}

function createToken(scope, userId, seconds, now = Date.now()) {
  const expires = Math.floor(now / 1000) + seconds;
  return `${scope}.${userId}.${expires}.${signature(scope, userId, expires)}`;
}

function userIdFromToken(token, scope, now = Date.now()) {
  const [suppliedScope, userId, expiresRaw, suppliedSignature, extra] =
    String(token || "").split(".");
  const expires = Number(expiresRaw);
  if (
    extra ||
    suppliedScope !== scope ||
    !/^[a-f0-9]{64}$/.test(userId || "") ||
    !Number.isInteger(expires) ||
    expires <= Math.floor(now / 1000)
  ) {
    return null;
  }
  return secureEqual(
    suppliedSignature || "",
    signature(scope, userId, expires)
  ) ? userId : null;
}

function createSessionToken(userId, now = Date.now()) {
  return createToken("session", userId, SESSION_SECONDS, now);
}

function createDeviceToken(userId, now = Date.now()) {
  return createToken("device", userId, DEVICE_SECONDS, now);
}

function validSessionToken(token, now = Date.now()) {
  return Boolean(userIdFromToken(token, "session", now));
}

function parseCookies(request) {
  const raw = request.headers?.cookie || request.headers?.Cookie || "";
  return Object.fromEntries(
    String(raw)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, index)),
          decodeURIComponent(part.slice(index + 1))
        ];
      })
  );
}

function isAuthenticated(request) {
  return Boolean(authenticatedUserId(request));
}

function authenticatedUserId(request) {
  return userIdFromToken(
    parseCookies(request)[COOKIE_NAME],
    "session"
  );
}

function deviceUserId(request) {
  return userIdFromToken(
    parseCookies(request)[DEVICE_COOKIE_NAME],
    "device"
  );
}

function cookieHeader(name, token, request, maxAge) {
  const forwardedProto =
    request.headers?.["x-forwarded-proto"] || request.headers?.["X-Forwarded-Proto"];
  const secure = process.env.VERCEL || forwardedProto === "https" ? "; Secure" : "";
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ") + secure;
}

function appendCookie(response, value) {
  const current = response.getHeader?.("Set-Cookie");
  if (!current) {
    response.setHeader("Set-Cookie", value);
    return;
  }
  response.setHeader(
    "Set-Cookie",
    Array.isArray(current) ? [...current, value] : [current, value]
  );
}

function setSessionCookie(response, request, userId) {
  appendCookie(
    response,
    cookieHeader(
      COOKIE_NAME,
      createSessionToken(userId),
      request,
      SESSION_SECONDS
    )
  );
}

function setDeviceCookie(response, request, userId) {
  appendCookie(
    response,
    cookieHeader(
      DEVICE_COOKIE_NAME,
      createDeviceToken(userId),
      request,
      DEVICE_SECONDS
    )
  );
}

function clearSessionCookie(response, request) {
  appendCookie(
    response,
    cookieHeader(COOKIE_NAME, "", request, 0) +
      "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
}

async function requireAnalysisAuth(request, response, store) {
  const userId = authenticatedUserId(request);
  if (userId) {
    const activeStore = store || new (require("./proUserStore").ProUserStore)();
    if (await activeStore.isActive(userId)) return userId;
  }
  response.setHeader("Cache-Control", "private, no-store");
  response.status(401).json({ error: "Acceso al análisis no autorizado." });
  return null;
}

module.exports = {
  COOKIE_NAME,
  DEVICE_COOKIE_NAME,
  authenticatedUserId,
  clearSessionCookie,
  createDeviceToken,
  createSessionToken,
  deviceUserId,
  isAuthenticated,
  requireAnalysisAuth,
  setDeviceCookie,
  setSessionCookie,
  userIdFromToken,
  validSessionToken
};
