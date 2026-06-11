"use strict";

const crypto = require("node:crypto");

const ADMIN_COOKIE_NAME = "mundial_pro_admin";
const ADMIN_SESSION_SECONDS = 4 * 60 * 60;

function secret() {
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

function configuredPassword() {
  if (process.env.PRO_ADMIN_PASSWORD) {
    return process.env.PRO_ADMIN_PASSWORD;
  }
  if (process.env.VERCEL) {
    const error = new Error("Falta PRO_ADMIN_PASSWORD.");
    error.code = "MISSING_ADMIN_PASSWORD";
    throw error;
  }
  return "elonmusk";
}

function secureEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function signature(expires) {
  const passwordFingerprint = crypto
    .createHash("sha256")
    .update(configuredPassword())
    .digest("base64url");
  return crypto
    .createHmac("sha256", secret())
    .update(`admin.${expires}.${passwordFingerprint}`)
    .digest("base64url");
}

function createAdminToken(now = Date.now()) {
  const expires = Math.floor(now / 1000) + ADMIN_SESSION_SECONDS;
  return `${expires}.${signature(expires)}`;
}

function validAdminToken(token, now = Date.now()) {
  const [expiresRaw, suppliedSignature, extra] = String(token || "").split(".");
  const expires = Number(expiresRaw);
  return !extra &&
    Number.isInteger(expires) &&
    expires > Math.floor(now / 1000) &&
    secureEqual(suppliedSignature || "", signature(expires));
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

function isAdmin(request) {
  return validAdminToken(parseCookies(request)[ADMIN_COOKIE_NAME]);
}

function cookieHeader(token, request, maxAge = ADMIN_SESSION_SECONDS) {
  const forwardedProto =
    request.headers?.["x-forwarded-proto"] || request.headers?.["X-Forwarded-Proto"];
  const secure = process.env.VERCEL || forwardedProto === "https" ? "; Secure" : "";
  return [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict"
  ].join("; ") + secure;
}

function setAdminCookie(response, request) {
  response.setHeader(
    "Set-Cookie",
    cookieHeader(createAdminToken(), request)
  );
}

function clearAdminCookie(response, request) {
  response.setHeader(
    "Set-Cookie",
    cookieHeader("", request, 0) +
      "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
}

function requireAdmin(request, response) {
  if (isAdmin(request)) return true;
  response.setHeader("Cache-Control", "private, no-store");
  response.status(401).json({ error: "Sesión de administrador no válida." });
  return false;
}

function validAdminPassword(password) {
  return secureEqual(password, configuredPassword());
}

module.exports = {
  ADMIN_COOKIE_NAME,
  clearAdminCookie,
  createAdminToken,
  isAdmin,
  requireAdmin,
  setAdminCookie,
  validAdminPassword,
  validAdminToken
};
