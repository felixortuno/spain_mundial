"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "mundial_analysis_session";
const SESSION_SECONDS = 12 * 60 * 60;
const DEFAULT_PASSWORD_HASH =
  "07ffe741ac34ff95fa5fa23d0ff8ed9bec1b4bc3fbef1e71417c7e23f04a1a2b";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function configuredPasswordHash() {
  if (process.env.ANALYSIS_PASSWORD_HASH) {
    return String(process.env.ANALYSIS_PASSWORD_HASH).trim().toLowerCase();
  }
  if (process.env.ANALYSIS_PASSWORD) {
    return sha256(process.env.ANALYSIS_PASSWORD);
  }
  return DEFAULT_PASSWORD_HASH;
}

function sessionSecret() {
  return (
    process.env.ANALYSIS_SESSION_SECRET ||
    sha256(`mundial-analysis:${configuredPasswordHash()}`)
  );
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validPassword(value) {
  return secureEqual(sha256(String(value || "").trim()), configuredPasswordHash());
}

function signature(expires) {
  return crypto
    .createHmac("sha256", sessionSecret())
    .update(String(expires))
    .digest("base64url");
}

function createSessionToken(now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${signature(expires)}`;
}

function validSessionToken(token, now = Date.now()) {
  const [expiresRaw, suppliedSignature, extra] = String(token || "").split(".");
  const expires = Number(expiresRaw);
  if (extra || !Number.isInteger(expires) || expires <= Math.floor(now / 1000)) {
    return false;
  }
  return secureEqual(suppliedSignature || "", signature(expires));
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
  return validSessionToken(parseCookies(request)[COOKIE_NAME]);
}

function cookieHeader(token, request, maxAge = SESSION_SECONDS) {
  const forwardedProto =
    request.headers?.["x-forwarded-proto"] || request.headers?.["X-Forwarded-Proto"];
  const secure = process.env.VERCEL || forwardedProto === "https" ? "; Secure" : "";
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ") + secure;
}

function setSessionCookie(response, request) {
  response.setHeader("Set-Cookie", cookieHeader(createSessionToken(), request));
}

function clearSessionCookie(response, request) {
  response.setHeader(
    "Set-Cookie",
    cookieHeader("", request, 0) + "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
}

function requireAnalysisAuth(request, response) {
  if (isAuthenticated(request)) return true;
  response.setHeader("Cache-Control", "private, no-store");
  response.status(401).json({ error: "Acceso al análisis no autorizado." });
  return false;
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  createSessionToken,
  isAuthenticated,
  requireAnalysisAuth,
  setSessionCookie,
  validPassword,
  validSessionToken
};
