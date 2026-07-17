import { success, error } from "../../utils/response.js";
import { normalizePartnerId } from "../../utils/partner-id.js";
import { odooCall, odooAuthenticate } from "../../services/odoo.service.js";
import { createToken } from "../../services/token.service.js";
import { getAppAuthUser } from "../middlewares/auth.middleware.js";

export async function login(req, res) {
  try {
    const loginInput = String(req.body.login || "").trim();
    const password = String(req.body.password || "");

    if (!loginInput || !password) {
      return error(res, "Email and password are required", 400);
    }

    // Sales reps sign in with their Odoo user email (internal users).
    const user = await odooAuthenticate(loginInput, password);

    if (!user) {
      return error(res, "Wrong login or password", 401);
    }

    const partnerId = normalizePartnerId(user.partner_id);

    const token = createToken({
      uid: user.uid,
      login: loginInput,
      partner_id: partnerId,
      role: "sales_rep",
      name: user.name,
    });

    return success(res, {
      message: "Login successful",
      token,
      user: {
        id: user.uid,
        name: user.name,
        login: loginInput,
        partner_id: partnerId,
        role: "sales_rep",
      },
    });
  } catch (err) {
    return error(res, "Login failed", 500, err.message);
  }
}

export async function me(req, res) {
  const user = getAppAuthUser(req);

  if (!user) {
    return error(res, "Unauthorized", 401);
  }

  return success(res, {
    user: {
      id: user.uid,
      name: user.name || user.login,
      login: user.login,
      partner_id: user.partner_id,
      role: "sales_rep",
    },
  });
}

export async function logout(req, res) {
  return success(res, {
    message: "Logged out successfully",
  });
}
