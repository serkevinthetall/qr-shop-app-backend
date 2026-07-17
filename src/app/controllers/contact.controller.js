import { success, error } from "../../utils/response.js";
import { odooCall } from "../../services/odoo.service.js";
import { normalizePhone, getPhoneSearchTail } from "../../utils/phone.js";

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function formatContact(partner) {
  return {
    id: partner.id,
    name: partner.name || "",
    phone: partner.phone || "",
    email: partner.email || "",
    member_code: String(partner.x_studio_member_code || "").trim(),
    street: partner.street || "",
    street2: partner.street2 || "",
    city: partner.city || "",
  };
}

export async function searchContacts(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 30), 50);

    if (!q) {
      return success(res, { contacts: [], count: 0 });
    }

    const phoneTail = getPhoneSearchTail(q);
    const odooDomain = [
      "|",
      "|",
      ["name", "ilike", q],
      ["x_studio_member_code", "ilike", q],
      ["phone", "ilike", phoneTail || normalizePhone(q) || q],
    ];

    const partners = await odooCall("res.partner", "search_read", {
      domain: odooDomain,
      fields: [
        "id",
        "name",
        "phone",
        "email",
        "x_studio_member_code",
        "street",
        "street2",
        "city",
      ],
      limit,
      order: "name asc",
    });

    return success(res, {
      contacts: partners.map(formatContact),
      count: partners.length,
    });
  } catch (err) {
    return error(res, "Failed to search contacts", 500, getOdooError(err));
  }
}

export async function listContacts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit || 40), 100);
    const offset = Number(req.query.offset || 0);
    const q = String(req.query.q || "").trim();

    let domain = [["customer_rank", ">", 0]];

    if (q) {
      const phoneTail = getPhoneSearchTail(q);
      domain = [
        "&",
        ["customer_rank", ">", 0],
        "|",
        "|",
        ["name", "ilike", q],
        ["x_studio_member_code", "ilike", q],
        ["phone", "ilike", phoneTail || q],
      ];
    }

    const partners = await odooCall("res.partner", "search_read", {
      domain,
      fields: [
        "id",
        "name",
        "phone",
        "email",
        "x_studio_member_code",
        "street",
        "street2",
        "city",
      ],
      limit,
      offset,
      order: "name asc",
    });

    return success(res, {
      contacts: partners.map(formatContact),
      limit,
      offset,
      count: partners.length,
    });
  } catch (err) {
    return error(res, "Failed to list contacts", 500, getOdooError(err));
  }
}

export async function getContactById(req, res) {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return error(res, "Invalid contact ID", 400);
    }

    const partners = await odooCall("res.partner", "search_read", {
      domain: [["id", "=", id]],
      fields: [
        "id",
        "name",
        "phone",
        "email",
        "x_studio_member_code",
        "street",
        "street2",
        "city",
      ],
      limit: 1,
    });

    if (!partners.length) {
      return error(res, "Contact not found", 404);
    }

    let membership = null;

    try {
      const memberships = await odooCall("x_membership", "search_read", {
        domain: [["x_studio_customer", "=", id]],
        fields: [
          "id",
          "x_name",
          "x_studio_membership_level",
          "x_studio_status",
          "x_studio_end_date",
        ],
        order: "x_studio_start_date desc",
        limit: 1,
      });
      membership = memberships[0] || null;
    } catch {
      membership = null;
    }

    return success(res, {
      contact: formatContact(partners[0]),
      membership,
    });
  } catch (err) {
    return error(res, "Failed to get contact", 500, getOdooError(err));
  }
}
