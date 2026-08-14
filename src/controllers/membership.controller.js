import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { filterCouponsForCurrentMonth } from "../utils/coupon-ticket-month.js";
import { normalizePhone } from "../utils/phone.js";

/** Studio model for membership Apply requests (client contacts customer). */
const MEMBERSHIP_APPLICATION_MODEL = "x_membership_applicati";
const PLAN_FIELD = "x_studio_selection_field_2c0_1jvv3u0te";

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function formatOdooDatetime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function mapPlanToOdoo(plan) {
  const normalized = String(plan || "")
    .trim()
    .toLowerCase();

  if (normalized === "pro") {
    return "Pro";
  }

  if (normalized === "premium") {
    return "Premium";
  }

  return null;
}

function asText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
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

    // App shows coupons[0]. Only return this calendar month so last month's
    // ticket never appears as the active code in Account / Checkout.
    return success(res, {
      coupons: filterCouponsForCurrentMonth(coupons),
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

/**
 * Latest membership Apply for the logged-in partner (Odoo Studio model).
 * App maps Status "Requested" → Processing UI.
 */
export async function getMembershipApplication(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const rows = await odooCall(MEMBERSHIP_APPLICATION_MODEL, "search_read", {
      domain: [["x_studio_customer", "=", user.partner_id]],
      fields: [
        "id",
        "x_name",
        "x_studio_customer",
        PLAN_FIELD,
        "x_studio_name",
        "x_studio_phone",
        "x_studio_email",
        "x_studio_status",
        "x_studio_requested_at",
        "x_studio_notes_1",
      ],
      order: "id desc",
      limit: 1,
    });

    const row = rows[0] || null;

    return success(res, {
      application: row
        ? {
            id: row.id,
            plan: row[PLAN_FIELD] || null,
            name: row.x_studio_name || "",
            phone: row.x_studio_phone || "",
            email: row.x_studio_email || "",
            status: row.x_studio_status || null,
            requested_at: row.x_studio_requested_at || null,
          }
        : null,
    });
  } catch (err) {
    return error(res, "Failed to get membership application", 500, getOdooError(err));
  }
}

/**
 * Create (or reuse) a Requested membership application for Apply.
 */
export async function createMembershipApplication(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const odooPlan = mapPlanToOdoo(req.body?.plan);
    const name = asText(req.body?.name);
    const phone = asText(req.body?.phone);
    const email = asText(req.body?.email);

    if (!odooPlan) {
      return error(res, "Plan must be pro or premium", 400);
    }

    if (!name) {
      return error(res, "Name is required", 400);
    }

    // Reuse open Requested row so spam Apply does not flood Odoo.
    const existing = await odooCall(MEMBERSHIP_APPLICATION_MODEL, "search_read", {
      domain: [
        ["x_studio_customer", "=", user.partner_id],
        ["x_studio_status", "=", "Requested"],
      ],
      fields: ["id", PLAN_FIELD, "x_studio_status"],
      order: "id desc",
      limit: 1,
    });

    if (existing[0]) {
      await odooCall(MEMBERSHIP_APPLICATION_MODEL, "write", {
        ids: [existing[0].id],
        vals: {
          [PLAN_FIELD]: odooPlan,
          x_studio_name: name,
          x_studio_phone: phone || false,
          x_studio_email: email || false,
          x_studio_requested_at: formatOdooDatetime(),
        },
      });

      return success(res, {
        message: "Membership application updated",
        application_id: existing[0].id,
        status: "Requested",
        plan: odooPlan,
        reused: true,
      });
    }

    const displayName = `Membership Apply - ${odooPlan} - ${name}`.slice(0, 120);

    const createdIds = await odooCall(MEMBERSHIP_APPLICATION_MODEL, "create", {
      vals_list: [
        {
          x_name: displayName,
          x_studio_customer: user.partner_id,
          [PLAN_FIELD]: odooPlan,
          x_studio_name: name,
          x_studio_phone: phone || false,
          x_studio_email: email || false,
          x_studio_status: "Requested",
          x_studio_requested_at: formatOdooDatetime(),
        },
      ],
    });

    const applicationId = Array.isArray(createdIds) ? createdIds[0] : createdIds;

    return success(res, {
      message: "Membership application created",
      application_id: applicationId,
      status: "Requested",
      plan: odooPlan,
      reused: false,
    });
  } catch (err) {
    return error(res, "Failed to create membership application", 500, getOdooError(err));
  }
}
