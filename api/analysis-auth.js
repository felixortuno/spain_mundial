"use strict";

const {
  clearSessionCookie,
  isAuthenticated,
  setSessionCookie,
  validPassword
} = require("../lib/analysisAuth");

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
    const authenticated = isAuthenticated(request);
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json({ authenticated });
  }

  if (request.method === "POST") {
    const body = await bodyFromRequest(request);
    if (!validPassword(body.password)) {
      return response.status(401).json({ error: "Clave incorrecta." });
    }
    setSessionCookie(response, request);
    return response.status(200).json({ authenticated: true });
  }

  if (request.method === "DELETE") {
    clearSessionCookie(response, request);
    return response.status(200).json({ authenticated: false });
  }

  response.setHeader("Allow", "GET, HEAD, POST, DELETE");
  return response.status(405).json({ error: "Método no permitido." });
};
