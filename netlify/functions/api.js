import serverless from "serverless-http";
import app from "../../src/server.js";

// Same Express app as Vercel — Netlify is a second host, not a proxy.
export const handler = serverless(app, {
  binary: ["multipart/form-data", "image/*", "application/octet-stream"],
});
