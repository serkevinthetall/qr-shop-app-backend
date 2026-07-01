import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { normalizePhone } from "../utils/phone.js";

export async function getProfile(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    if (!user.partner_id) {
      return error(res, "No partner linked to this user", 400);
    }

    const partners = await odooCall("res.partner", "search_read", {
      domain: [["id", "=", user.partner_id]],
      fields: [
        "id",
        "name",
        "email",
        "phone",
        "street",
        "street2",
        "city",
        "zip",
        "state_id",
        "country_id",
      ],
      limit: 1,
    });

    return success(res, {
      profile: partners[0] || null,
    });
  } catch (err) {
    return error(res, "Failed to get profile", 500, err.message);
  }
}

export async function updateProfile(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    if (!user.partner_id) {
      return error(res, "No partner linked to this user", 400);
    }

    const values = {};

    if (req.body.name !== undefined) {
      values.name = String(req.body.name).trim();
    }

    if (req.body.email !== undefined) {
      values.email = String(req.body.email).trim();
    }

    if (req.body.phone !== undefined) {
      values.phone = normalizePhone(req.body.phone);
    }

    if (req.body.street !== undefined) {
      values.street = String(req.body.street).trim();
    }

    if (req.body.street2 !== undefined) {
      values.street2 = String(req.body.street2).trim();
    }

    if (req.body.city !== undefined) {
      values.city = String(req.body.city).trim();
    }

    if (req.body.zip !== undefined) {
      values.zip = String(req.body.zip).trim();
    }

    if (!Object.keys(values).length) {
      return error(res, "No fields to update", 400);
    }

    await odooCall("res.partner", "write", {
      ids: [user.partner_id],
      vals: values,
    });

    return success(res, {
      message: "Profile updated successfully",
    });
  } catch (err) {
    return error(res, "Failed to update profile", 500, err.message);
  }
}