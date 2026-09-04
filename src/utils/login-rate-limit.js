const WARN_AFTER_FAILURES = 3;
const LOCK_AFTER_FAILURES = 6; // 3 fails + reminder, then 3 more → lock
const LOCK_DURATIONS_MS = [
  10 * 60 * 1000, // first lock: 10 minutes
  60 * 60 * 1000, // next locks: 1 hour (maximum)
];

/**
 * In-memory login attempt tracker (per serverless instance).
 * Keyed by client IP + login identifier.
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

function getState(key) {
  return (
    attemptState.get(key) || {
      count: 0,
      lockedUntil: 0,
      lockTier: 0,
    }
  );
}

function nextLockDurationMs(lockTier) {
  const index = Math.min(Math.max(lockTier, 0), LOCK_DURATIONS_MS.length - 1);
  return LOCK_DURATIONS_MS[index];
}

function nextLockMinutes(lockTier) {
  return Math.round(nextLockDurationMs(lockTier) / 60000);
}

export function getLoginAttemptKey(clientIp, loginInput) {
  const ip = String(clientIp || "unknown").trim() || "unknown";
  const login = String(loginInput || "").trim().toLowerCase() || "unknown";
  return `${ip}|${login}`;
}

export function getLoginLockStatus(key) {
  const state = getState(key);

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
    attemptState.set(key, {
      count: 0,
      lockedUntil: 0,
      lockTier: state.lockTier || 0,
    });

    return {
      locked: false,
      retryAfterSeconds: 0,
      lockTier: state.lockTier || 0,
      nextLockMinutes: nextLockMinutes(state.lockTier || 0),
    };
  }

  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    lockTier: state.lockTier || 0,
    nextLockMinutes: nextLockMinutes(state.lockTier || 0),
  };
}

export function recordLoginFailure(key) {
  const lockStatus = getLoginLockStatus(key);

  if (lockStatus.locked) {
    return lockStatus;
  }

  const current = getState(key);
  const lockTier = current.lockTier || 0;
  const count = (current.count || 0) + 1;

  if (count >= LOCK_AFTER_FAILURES) {
    const durationMs = nextLockDurationMs(lockTier);
    const nextTier = Math.min(lockTier + 1, LOCK_DURATIONS_MS.length - 1);

    attemptState.set(key, {
      count: 0,
      lockedUntil: nowMs() + durationMs,
      lockTier: nextTier,
    });

    return {
      locked: true,
      retryAfterSeconds: Math.ceil(durationMs / 1000),
      lockMinutes: Math.round(durationMs / 60000),
      lockTier: nextTier,
      nextLockMinutes: nextLockMinutes(nextTier),
    };
  }

  attemptState.set(key, {
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

export function clearLoginAttempts(key) {
  attemptState.delete(key);
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
