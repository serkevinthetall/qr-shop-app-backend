/**
 * Shared Upstash Redis REST helpers (Vercel/Netlify durable state).
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

export function redisConfigured() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

export async function redisCommand(parts) {
  const base = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  const path = parts.map((part) => encodeURIComponent(String(part))).join("/");

  const response = await fetch(`${base}/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Upstash Redis HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload?.result;
}
