"use strict";

const { requireAdmin } = require("../lib/adminAuth");
const { firebaseConfigured } = require("../lib/firebaseAdmin");
const { ProAuthError, ProUserStore } = require("../lib/proUserStore");

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
  if (!requireAdmin(request, response)) return;

  if (!firebaseConfigured()) {
    return response.status(503).json({
      error: "Firebase todavía no está configurado."
    });
  }

  const store = new ProUserStore();
  try {
    if (request.method === "GET" || request.method === "HEAD") {
      if (request.method === "HEAD") return response.status(200).end();
      return response.status(200).json({ users: await store.listUsers() });
    }

    if (request.method === "PATCH") {
      const body = await bodyFromRequest(request);
      if (typeof body.active !== "boolean") {
        return response.status(400).json({
          error: "El estado de acceso no es válido."
        });
      }
      const user = await store.setAccess(body.userId, body.active);
      return response.status(200).json({ user });
    }
  } catch (error) {
    if (error instanceof ProAuthError) {
      return response.status(error.status).json({
        error: error.message,
        code: error.code
      });
    }
    console.error("[pro-users]", error);
    return response.status(502).json({
      error: "No se pudo actualizar Firebase."
    });
  }

  response.setHeader("Allow", "GET, HEAD, PATCH");
  return response.status(405).json({ error: "Método no permitido." });
};
