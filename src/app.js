import { readUpload } from './services/fileUpload.js';
import { routes } from "./routes/ragRoutes.js";

async function readJson(request) {
  if (
    !(request.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw Object.assign(new Error("Use Content-Type: application/json."), {
      status: 415,
    });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536)
      throw Object.assign(new Error("Request body exceeds 64 KB."), {
        status: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      status: 400,
    });
  }
}

export async function app(request, response) {
  const origin = request.headers.origin;
  const allowedOrigins = new Set(
    [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://127.0.0.1:8081",
      "http://localhost:8081",
      process.env.FRONTEND_ORIGIN,
    ].filter(Boolean),
  );
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  if (origin && !allowedOrigins.has(origin)) {
    response
      .writeHead(403)
      .end(JSON.stringify({ detail: "Origin is not allowed." }));
    return;
  }
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.writeHead(204).end();
    return;
  }
  try {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const handler = routes.get(`${request.method} ${path}`);
    if (!handler) {
      response
        .writeHead(404)
        .end(JSON.stringify({ detail: "Route not found." }));
      return;
    }
    const body =
      request.method === "POST" ? (path === "/api/documents/upload" ? await readUpload(request) : await readJson(request)) : undefined;
    const result = await handler(body, url);
    response.writeHead(result.status).end(JSON.stringify(result.data));
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(error.status || 500).end(
        JSON.stringify({
          detail: error.status ? error.message : "Unexpected backend error.",
        }),
      );
    }
  }
}
