import serverless from "serverless-http";
import app from "../../src/server.js";

const soft = serverless(app, {
  binary: ["multipart/form-data", "image/*", "application/octet-stream"],
});

function normalizePath(event) {
  // Netlify rewrites /api/foo → /.netlify/functions/api/foo (splat).
  // Express routes are /api/foo and /, so normalize before handing off.
  let path = event.path || event.rawPath || "/";

  if (path.startsWith("/.netlify/functions/api")) {
    path = path.slice("/.netlify/functions/api".length) || "/";
  }

  if (path === "/" || path.startsWith("/api")) {
    event.path = path;
    if (event.rawPath) event.rawPath = path;
    return;
  }

  // Splat-only path like /app-config → /api/app-config
  event.path = `/api${path.startsWith("/") ? path : `/${path}`}`;
  if (event.rawPath) event.rawPath = event.path;
}

export async function handler(event, context) {
  normalizePath(event);
  return soft(event, context);
}
