import { success, error } from "../utils/response.js";
import { normalizePartnerId } from "../utils/partner-id.js";
import { normalizePhone } from "../utils/phone.js";
import { odooCall, odooAuthenticate } from "../services/odoo.service.js";
import { createToken, extractBearerToken } from "../services/token.service.js";
import { revokeAccessToken } from "../services/token-revoke.store.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import {
  clearLoginAttempts,
  getClientIp,
  getLoginAttemptKey,
  getLoginLockStatus,
  recordLoginFailure,
} from "../utils/login-rate-limit.js";

const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

function rejectLocked(res, result) {
  const retryAfterSeconds = result.retryAfterSeconds || 60;
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return error(res, GENERIC_LOGIN_ERROR, 429, {
    code: "LOGIN_LOCKED",
    retry_after_seconds: retryAfterSeconds,
    lock_minutes: result.lockMinutes || Math.ceil(retryAfterSeconds / 60),
    next_lock_minutes: result.nextLockMinutes || 60,
  });
}

async function rejectInvalidLogin(res, attemptKey) {
  const result = await recordLoginFailure(attemptKey);

  if (result.locked) {
    return rejectLocked(res, result);
  }

  if (result.warn) {
    return error(res, GENERIC_LOGIN_ERROR, 401, {
      code: "LOGIN_WARNING",
      remaining_attempts_before_lock: result.remainingAttemptsBeforeLock,
      next_lock_minutes: result.nextLockMinutes,
    });
  }

  return error(res, GENERIC_LOGIN_ERROR, 401, {
    code: "INVALID_CREDENTIALS",
  });
}

export async function login(req, res) {
  try {
    const loginInput = String(req.body.login || "").trim();
    const password = String(req.body.password || "");

    if (!loginInput || !password) {
      return error(res, "Email/phone and password are required", 400);
    }

    const attemptKey = getLoginAttemptKey(getClientIp(req), loginInput);
    const lockStatus = await getLoginLockStatus(attemptKey);

    if (lockStatus.locked) {
      return rejectLocked(res, lockStatus);
    }

    let odooLogin = loginInput;
    let partner = null;

    if (!loginInput.includes("@")) {
      const phone = normalizePhone(loginInput);

      const partners = await odooCall("res.partner", "search_read", {
        domain: [["phone", "=", phone]],
        fields: ["id", "name", "email", "phone"],
        limit: 1,
      });

      if (!partners.length) {
        return rejectInvalidLogin(res, attemptKey);
      }

      partner = partners[0];

      if (!partner.email) {
        return rejectInvalidLogin(res, attemptKey);
      }

      odooLogin = partner.email;
    }

    const user = await odooAuthenticate(odooLogin, password);

    if (!user) {
      return rejectInvalidLogin(res, attemptKey);
    }

    await clearLoginAttempts(attemptKey);

    const partnerId =
      normalizePartnerId(user.partner_id) ??
      normalizePartnerId(partner?.id) ??
      null;

    const token = createToken({
      uid: user.uid,
      login: odooLogin,
      partner_id: partnerId,
    });

    return success(res, {
      message: "Login successful",
      token,
      user: {
        id: user.uid,
        name: user.name,
        login: odooLogin,
        partner_id: partnerId,
      },
    });
  } catch (err) {
    console.error("Login failed:", err.message);
    return error(res, "Login failed", 500);
  }
}

export async function me(req, res) {
  const user = await getAuthUser(req);

  if (!user) {
    return error(res, "Unauthorized", 401);
  }

  return success(res, { user });
}

export async function logout(req, res) {
  const token = extractBearerToken(req);

  if (!token) {
    return error(res, "Unauthorized", 401);
  }

  // Must be a currently valid session to revoke (prevents anonymous denylist spam).
  const user = await getAuthUser(req);

  if (!user) {
    return error(res, "Unauthorized", 401);
  }

  await revokeAccessToken(token);

  return success(res, {
    message: "Logged out successfully",
  });
}

export async function changePassword(req, res) {
  try {
    const authUser = await getAuthUser(req);

    if (!authUser) {
      return error(res, "Unauthorized", 401);
    }

    const currentPassword = String(req.body.current_password || "");
    const newPassword = String(req.body.new_password || "");

    if (!currentPassword || !newPassword) {
      return error(res, "Current and new password are required", 400);
    }

    if (newPassword.length < 6) {
      return error(res, "New password must be at least 6 characters", 400);
    }

    if (newPassword === currentPassword) {
      return error(
        res,
        "New password must be different from the current password",
        400
      );
    }

    // Verify the current password by re-authenticating as the user.
    const verified = await odooAuthenticate(authUser.login, currentPassword);

    if (!verified) {
      return error(res, "Current password is incorrect", 401);
    }

    await odooCall("res.users", "write", {
      ids: [authUser.uid],
      vals: { password: newPassword },
    });

    return success(res, {
      message: "Password changed successfully",
    });
  } catch (err) {
    console.error("Failed to change password:", err.message);
    return error(res, "Failed to change password", 500);
  }
}
