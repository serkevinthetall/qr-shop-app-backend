import { success, error } from "../utils/response.js";
import { normalizePartnerId } from "../utils/partner-id.js";
import { normalizePhone } from "../utils/phone.js";
import { odooCall, odooAuthenticate } from "../services/odoo.service.js";
import { createToken } from "../services/token.service.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";

export async function login(req, res) {
  try {
    const loginInput = String(req.body.login || "").trim();
    const password = String(req.body.password || "");

    if (!loginInput || !password) {
      return error(res, "Email/phone and password are required", 400);
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
        return error(res, "Phone number not found", 404);
      }

      partner = partners[0];

      if (!partner.email) {
        return error(res, "This customer has no email login in Odoo", 400);
      }

      odooLogin = partner.email;
    }

    const user = await odooAuthenticate(odooLogin, password);

    if (!user) {
      return error(res, "Wrong login or password", 401);
    }

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
    return error(res, "Login failed", 500, err.message);
  }
}

export async function me(req, res) {
  const user = getAuthUser(req);

  if (!user) {
    return error(res, "Unauthorized", 401);
  }

  return success(res, { user });
}

export async function logout(req, res) {
  return success(res, {
    message: "Logged out successfully",
  });
}

export async function changePassword(req, res) {
  try {
    const authUser = getAuthUser(req);

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
    return error(res, "Failed to change password", 500, err.message);
  }
}