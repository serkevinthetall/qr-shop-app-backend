import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { normalizePhone } from "../utils/phone.js";

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

export async function getMembership(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const memberships = await odooCall("x_membership", "search_read", {
      domain: [["x_studio_customer", "=", user.partner_id]],
      fields: [
        "id",
        "x_name",
        "x_studio_customer",
        "x_studio_membership_level",
        "x_studio_start_date",
        "x_studio_end_date",
        "x_studio_status",
        "x_studio_monthly_coupon_amount",
        "x_studio_total_tickets",
        "x_studio_used_tickets",
        "x_studio_missed_tickets",
        "x_studio_remaining_tickets",
        "x_studio_benefits_summary",
      ],
      order: "x_studio_start_date desc",
      limit: 1,
    });

    const partners = await odooCall("res.partner", "search_read", {
      domain: [["id", "=", user.partner_id]],
      fields: ["id", "x_studio_member_code"],
      limit: 1,
    });

    const memberCode = String(partners[0]?.x_studio_member_code || "").trim();

    return success(res, {
      membership: memberships[0] || null,
      member_code: memberCode,
    });
  } catch (err) {
    return error(res, "Failed to get membership", 500, getOdooError(err));
  }
}

export async function getMembershipCoupons(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
      domain: [["x_studio_customer", "=", user.partner_id]],
      fields: [
        "id",
        "x_studio_coupon_code",
        "x_studio_status",
        "x_studio_coupon_amount",
        "x_studio_ticket_month",
        "x_studio_customer",
        "x_studio_used_sale_order",
        "x_studio_membership",
      ],
      order: "x_studio_ticket_month desc",
      limit: 50,
    });

    return success(res, {
      coupons,
    });
  } catch (err) {
    return error(res, "Failed to get membership coupons", 500, getOdooError(err));
  }
}

export async function checkMembership(req, res) {
  try {
    const phone = normalizePhone(req.body.phone);
    const memberCode = String(req.body.member_code || "").trim();

    if (!phone || !memberCode) {
      return error(res, "Phone and member code are required", 400);
    }

    const partners = await odooCall("res.partner", "search_read", {
      domain: [
        ["x_studio_member_code", "=", memberCode],
        ["phone", "=", phone],
      ],
      fields: [
        "id",
        "name",
        "phone",
        "x_studio_member_code",
        "x_studio_membership_level",
      ],
      limit: 1,
    });

    if (!partners.length) {
      return error(res, "Membership not found", 404);
    }

    const partner = partners[0];

    const memberships = await odooCall("x_membership", "search_read", {
      domain: [
        ["x_studio_customer", "=", partner.id],
        ["x_studio_status", "=", "Active"],
      ],
      fields: [
        "id",
        "x_name",
        "x_studio_membership_level",
        "x_studio_start_date",
        "x_studio_end_date",
        "x_studio_status",
        "x_studio_remaining_tickets",
        "x_studio_benefits_summary",
      ],
      limit: 1,
    });

    return success(res, {
      customer: partner,
      membership: memberships[0] || null,
    });
  } catch (err) {
    return error(res, "Failed to check membership", 500, getOdooError(err));
  }
}