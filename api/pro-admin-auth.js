"use strict";

const {
  clearAdminCookie,
  isAdmin,
  setAdminCookie,
  validAdminPassword
} = require("../lib/adminAuth");
const {
  applyRateLimitHeaders,
  consumeRateLimit
} = require("../lib/rateLimit");

async function bodyFromRequest(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
  } catch {
    return {};
  }
}

module.exports = async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store");

  if (request.method === "GET" || request.method === "HEAD") {
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json({ authenticated: isAdmin(request) });
  }

  if (request.method === "POST") {
    const rateLimit = consumeRateLimit({
      request,
      scope: "admin-login",
      limit: 5,
      windowMs: 15 * 60 * 1000
    });
    applyRateLimitHeaders(response, rateLimit);
    if (!rateLimit.allowed) {
      return response.status(429).json({
        error: "Demasiados intentos. Prueba de nuevo dentro de 15 minutos."
      });
    }

    const body = await bodyFromRequest(request);
    try {
      if (!validAdminPassword(body.password)) {
        return response.status(401).json({
          error: "Contraseña de administrador incorrecta."
        });
      }
      setAdminCookie(response, request);
      return response.status(200).json({ authenticated: true });
    } catch (error) {
      if (
        error.code === "MISSING_ADMIN_PASSWORD" ||
        error.code === "MISSING_SESSION_SECRET"
      ) {
        return response.status(503).json({
          error: "Falta configurar el acceso de administrador en Vercel."
        });
      }
      throw error;
    }
  }

  if (request.method === "DELETE") {
    clearAdminCookie(response, request);
    return response.status(200).json({ authenticated: false });
  }

  response.setHeader("Allow", "GET, HEAD, POST, DELETE");
  return response.status(405).json({ error: "Método no permitido." });
};
