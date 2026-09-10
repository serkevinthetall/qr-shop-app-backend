import { createHash, randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import { redisCommand, redisConfigured } from "../utils/upstash-redis.js";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** L1 denylist for this instance (covers local / same warm lambda). */
const localRevoked = new Map();

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function redisKey(tokenHash) {
  return `qrshop:revoked:${tokenHash}`;
}

function pruneLocal() {
  const now = Date.now();
  if (localRevoked.size < 200) {
    return;
  }
  for (const [key, expiresAt] of localRevoked) {
    if (expiresAt <= now) {
      localRevoked.delete(key);
    }
  }
}

function ttlSecondsForToken(token) {
  try {
    const decoded = jwt.decode(token);
    const exp = Number(decoded?.exp);
    if (Number.isFinite(exp) && exp > 0) {
      const remaining = exp - Math.floor(Date.now() / 1000);
      if (remaining > 0) {
        return remaining;
      }
    }
  } catch {
    // fall through
  }
  return DEFAULT_TTL_SECONDS;
}

/**
 * Mark a JWT as revoked until its natural expiry (or 30d fallback).
 */
export async function revokeAccessToken(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return false;
  }

  const tokenHash = hashToken(raw);
  const ttlSec = ttlSecondsForToken(raw);
  const expiresAt = Date.now() + ttlSec * 1000;

  pruneLocal();
  localRevoked.set(tokenHash, expiresAt);

  if (redisConfigured()) {
    try {
      await redisCommand(["SET", redisKey(tokenHash), "1", "EX", String(ttlSec)]);
    } catch (err) {
      console.warn("Token revoke Redis write failed:", err.message);
    }
  }

  return true;
}

/**
 * Returns true when this bearer token was revoked via logout.
 */
export async function isAccessTokenRevoked(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return false;
  }

  const tokenHash = hashToken(raw);
  const localExpiry = localRevoked.get(tokenHash);

  if (localExpiry) {
    if (localExpiry > Date.now()) {
      return true;
    }
    localRevoked.delete(tokenHash);
  }

  if (!redisConfigured()) {
    return false;
  }

  try {
    const value = await redisCommand(["GET", redisKey(tokenHash)]);
    if (value) {
      localRevoked.set(tokenHash, Date.now() + 60_000);
      return true;
    }
  } catch (err) {
    console.warn("Token revoke Redis read failed:", err.message);
  }

  return false;
}

export function newTokenId() {
  return randomUUID();
}
