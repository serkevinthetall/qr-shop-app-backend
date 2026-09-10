import { redisCommand, redisConfigured } from "./upstash-redis.js";

const WARN_AFTER_FAILURES = 3;
const LOCK_AFTER_FAILURES = 6; // 3 fails + reminder, then 3 more → lock
const LOCK_DURATIONS_MS = [
  10 * 60 * 1000, // first lock: 10 minutes
  60 * 60 * 1000, // next locks: 1 hour (maximum)
];
const STATE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Login attempt tracker keyed by client IP + login identifier.
 *
 * Uses in-memory Map as L1 cache, and Upstash Redis REST as durable L2 so
 * locks survive across Vercel/Netlify serverless instances.
 *
 * Env (optional but required for effective serverless lockout):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Flow:
 * - After 3 failures → warn about the next 3 attempts
 * - After 6 failures → 10-minute lock
 * - Later lock cycles → 1-hour lock (max)
 */
const attemptState = new Map();

function nowMs() {
  return Date.now();
}

function nextLockDurationMs(lockTier) {
  const index = Math.min(Math.max(lockTier, 0), LOCK_DURATIONS_MS.length - 1);
  return LOCK_DURATIONS_MS[index];
}

function nextLockMinutes(lockTier) {
  return Math.round(nextLockDurationMs(lockTier) / 60000);
}

function emptyState() {
  return {
    count: 0,
    lockedUntil: 0,
    lockTier: 0,
  };
}

function redisKey(key) {
  return `qrshop:login:${key}`;
}

async function readDurableState(key) {
  if (!redisConfigured()) {
    return null;
  }

  try {
    const raw = await redisCommand(["GET", redisKey(key)]);
    if (!raw) {
      return null;
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      count: Number(parsed.count) || 0,
      lockedUntil: Number(parsed.lockedUntil) || 0,
      lockTier: Number(parsed.lockTier) || 0,
    };
  } catch (err) {
    console.warn("Login rate-limit Redis read failed:", err.message);
    return null;
  }
}

async function writeDurableState(key, state) {
  attemptState.set(key, state);

  if (!redisConfigured()) {
    return;
  }

  try {
    await redisCommand([
      "SET",
      redisKey(key),
      JSON.stringify(state),
      "EX",
      String(STATE_TTL_SECONDS),
    ]);
  } catch (err) {
    console.warn("Login rate-limit Redis write failed:", err.message);
  }
}

async function deleteDurableState(key) {
  attemptState.delete(key);

  if (!redisConfigured()) {
    return;
  }

  try {
    await redisCommand(["DEL", redisKey(key)]);
  } catch (err) {
    console.warn("Login rate-limit Redis delete failed:", err.message);
  }
}

async function getState(key) {
  const local = attemptState.get(key);
  if (local) {
    return local;
  }

  const durable = await readDurableState(key);
  if (durable) {
    attemptState.set(key, durable);
    return durable;
  }

  return emptyState();
}

export function getLoginAttemptKey(clientIp, loginInput) {
  const ip = String(clientIp || "unknown").trim() || "unknown";
  const login = String(loginInput || "").trim().toLowerCase() || "unknown";
  return `${ip}|${login}`;
}

export async function getLoginLockStatus(key) {
  const state = await getState(key);

  if (!state.lockedUntil) {
    return {
      locked: false,
      retryAfterSeconds: 0,
      lockTier: state.lockTier || 0,
      nextLockMinutes: nextLockMinutes(state.lockTier || 0),
    };
  }

  const remainingMs = state.lockedUntil - nowMs();

  if (remainingMs <= 0) {
    // Lock expired — keep escalation tier, reset attempt count for the next cycle.
    const next = {
      count: 0,
      lockedUntil: 0,
      lockTier: state.lockTier || 0,
    };
    await writeDurableState(key, next);

    return {
      locked: false,
      retryAfterSeconds: 0,
      lockTier: next.lockTier,
      nextLockMinutes: nextLockMinutes(next.lockTier),
    };
  }

  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    lockTier: state.lockTier || 0,
    nextLockMinutes: nextLockMinutes(state.lockTier || 0),
  };
}

export async function recordLoginFailure(key) {
  const lockStatus = await getLoginLockStatus(key);

  if (lockStatus.locked) {
    return lockStatus;
  }

  const current = await getState(key);
  const lockTier = current.lockTier || 0;
  const count = (current.count || 0) + 1;

  if (count >= LOCK_AFTER_FAILURES) {
    const durationMs = nextLockDurationMs(lockTier);
    const nextTier = Math.min(lockTier + 1, LOCK_DURATIONS_MS.length - 1);
    const next = {
      count: 0,
      lockedUntil: nowMs() + durationMs,
      lockTier: nextTier,
    };
    await writeDurableState(key, next);

    return {
      locked: true,
      retryAfterSeconds: Math.ceil(durationMs / 1000),
      lockMinutes: Math.round(durationMs / 60000),
      lockTier: nextTier,
      nextLockMinutes: nextLockMinutes(nextTier),
    };
  }

  await writeDurableState(key, {
    count,
    lockedUntil: 0,
    lockTier,
  });

  const remainingBeforeLock = LOCK_AFTER_FAILURES - count;
  const warn = count >= WARN_AFTER_FAILURES;

  return {
    locked: false,
    retryAfterSeconds: 0,
    failedAttempts: count,
    remainingAttemptsBeforeLock: remainingBeforeLock,
    warn,
    nextLockMinutes: nextLockMinutes(lockTier),
    lockTier,
  };
}

export async function clearLoginAttempts(key) {
  await deleteDurableState(key);
}

export function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  if (forwarded) {
    return forwarded;
  }

  return String(req.socket?.remoteAddress || req.ip || "unknown");
}
