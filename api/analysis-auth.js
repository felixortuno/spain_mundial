"use strict";

const {
  authenticatedUserId,
  clearSessionCookie,
  deviceUserId,
  setDeviceCookie,
  setSessionCookie
} = require("../lib/analysisAuth");
const { firebaseConfigured } = require("../lib/firebaseAdmin");
const { ProAuthError, ProUserStore } = require("../lib/proUserStore");
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
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

module.exports = async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store");

  if (request.method === "GET" || request.method === "HEAD") {
    if (request.method === "HEAD") return response.status(200).end();
    if (!firebaseConfigured()) {
      return response.status(200).json({
        authenticated: false,
        firebaseConfigured: false
      });
    }

    try {
      const store = new ProUserStore();
      const sessionUserId = authenticatedUserId(request);
      const rememberedUserId = deviceUserId(request);
      const userId = sessionUserId || rememberedUserId;
      const user = userId ? await store.getById(userId) : null;
      const authenticated = user?.active === true;

      if (authenticated && !sessionUserId) {
        setSessionCookie(response, request, user.userId);
      } else if (sessionUserId && !authenticated) {
        clearSessionCookie(response, request);
      }

      return response.status(200).json({
        authenticated,
        pending: Boolean(user && !user.active),
        firebaseConfigured: true,
        user: user ? {
          phoneMasked: user.phoneMasked,
          status: user.status
        } : null
      });
    } catch (error) {
      console.error("[analysis-auth:get]", error);
      return response.status(502).json({
        authenticated: false,
        error: "No se pudo comprobar el acceso PRO."
      });
    }
  }

  if (request.method === "POST") {
    const body = await bodyFromRequest(request);
    const isRegistration = body.action === "register";
    const rateLimit = consumeRateLimit({
      request,
      scope: isRegistration ? "pro-register" : "pro-login",
      limit: isRegistration ? 3 : 10,
      windowMs: isRegistration ? 60 * 60 * 1000 : 15 * 60 * 1000
    });
    applyRateLimitHeaders(response, rateLimit);
    if (!rateLimit.allowed) {
      return response.status(429).json({
        error: isRegistration
          ? "Demasiadas solicitudes desde este dispositivo. Prueba más tarde."
          : "Demasiados intentos de acceso. Prueba de nuevo más tarde.",
        code: "RATE_LIMITED"
      });
    }

    if (!firebaseConfigured()) {
      return response.status(503).json({
        error: "El acceso PRO todavía no está conectado a Firebase.",
        code: "FIREBASE_NOT_CONFIGURED"
      });
    }

    const store = new ProUserStore();
    try {
      if (body.action === "register") {
        const user = await store.register({
          phone: body.phone,
          pin: body.pin
        });
        setDeviceCookie(response, request, user.userId);
        return response.status(201).json({
          authenticated: false,
          pending: true,
          user
        });
      }

      if (body.action !== "login") {
        return response.status(400).json({
          error: "Acción de acceso no válida.",
          code: "INVALID_ACTION"
        });
      }

      const user = await store.authenticate({
        phone: body.phone,
        pin: body.pin
      });
      setSessionCookie(response, request, user.userId);
      setDeviceCookie(response, request, user.userId);
      return response.status(200).json({
        authenticated: true,
        user: { phoneMasked: user.phoneMasked }
      });
    } catch (error) {
      if (error instanceof ProAuthError) {
        return response.status(error.status).json({
          error: error.message,
          code: error.code
        });
      }
      console.error("[analysis-auth]", error);
      return response.status(502).json({
        error: "No se pudo conectar con Firebase.",
        code: "FIREBASE_ERROR"
      });
    }
  }

  if (request.method === "DELETE") {
    clearSessionCookie(response, request);
    return response.status(200).json({ authenticated: false });
  }

  response.setHeader("Allow", "GET, HEAD, POST, DELETE");
  return response.status(405).json({ error: "Método no permitido." });
};
