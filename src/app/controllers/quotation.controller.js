import { success, error } from "../../utils/response.js";
import { odooCall } from "../../services/odoo.service.js";
import { getAppAuthUser } from "../middlewares/auth.middleware.js";

const QUOTATION_RETENTION_DAYS = 7;

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function getCreatedId(result) {
  if (Array.isArray(result)) return result[0];
  return result;
}

function parseItems(rawItems) {
  if (Array.isArray(rawItems)) return rawItems;

  if (typeof rawItems === "string") {
    try {
      const parsed = JSON.parse(rawItems);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function mapStatus(state) {
  switch (state) {
    case "draft":
      return { key: "draft", label: "Draft" };
    case "sent":
      return { key: "sent", label: "Sent" };
    case "sale":
      return { key: "confirmed", label: "Confirmed" };
    case "done":
      return { key: "done", label: "Done" };
    case "cancel":
      return { key: "cancelled", label: "Cancelled" };
    default:
      return { key: state || "unknown", label: state || "Unknown" };
  }
}

function formatQuotation(order) {
  const status = mapStatus(order.state);

  return {
    id: order.id,
    name: order.name,
    state: order.state,
    status_key: status.key,
    status_label: status.label,
    amount_total: order.amount_total || 0,
    date_order: order.date_order,
    partner_id: order.partner_id,
    partner_name: Array.isArray(order.partner_id) ? order.partner_id[1] : "",
    note: order.note || "",
  };
}

function getRetentionCutoffUtc() {
  const cutoff = new Date(Date.now() - QUOTATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 19).replace("T", " ");
}

async function getProductVariant(productTemplateId) {
  const products = await odooCall("product.product", "search_read", {
    domain: [["product_tmpl_id", "=", productTemplateId]],
    fields: ["id", "name", "lst_price", "product_tmpl_id"],
    limit: 1,
  });

  return products[0] || null;
}

export async function listQuotations(req, res) {
  try {
    const user = getAppAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    const limit = Math.min(Number(req.query.limit || 50), 100);
    const cutoff = getRetentionCutoffUtc();

    const orders = await odooCall("sale.order", "search_read", {
      domain: [
        ["user_id", "=", user.uid],
        ["date_order", ">=", cutoff],
      ],
      fields: [
        "id",
        "name",
        "state",
        "amount_total",
        "date_order",
        "partner_id",
        "note",
      ],
      limit,
      order: "date_order desc",
    });

    return success(res, {
      quotations: orders.map(formatQuotation),
      retention_days: QUOTATION_RETENTION_DAYS,
      count: orders.length,
    });
  } catch (err) {
    return error(res, "Failed to list quotations", 500, getOdooError(err));
  }
}

export async function getQuotationById(req, res) {
  try {
    const user = getAppAuthUser(req);
    const id = Number(req.params.id);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    if (!id) {
      return error(res, "Invalid quotation ID", 400);
    }

    const orders = await odooCall("sale.order", "search_read", {
      domain: [
        ["id", "=", id],
        ["user_id", "=", user.uid],
      ],
      fields: [
        "id",
        "name",
        "state",
        "amount_total",
        "date_order",
        "partner_id",
        "note",
      ],
      limit: 1,
    });

    if (!orders.length) {
      return error(res, "Quotation not found", 404);
    }

    const lines = await odooCall("sale.order.line", "search_read", {
      domain: [["order_id", "=", id]],
      fields: [
        "id",
        "product_id",
        "name",
        "product_uom_qty",
        "price_unit",
        "price_subtotal",
      ],
    });

    return success(res, {
      quotation: formatQuotation(orders[0]),
      lines: lines.map((line) => ({
        id: line.id,
        product_id: line.product_id,
        name: line.name,
        quantity: line.product_uom_qty,
        price_unit: line.price_unit,
        price_subtotal: line.price_subtotal,
      })),
    });
  } catch (err) {
    return error(res, "Failed to get quotation", 500, getOdooError(err));
  }
}

export async function createQuotation(req, res) {
  try {
    const user = getAppAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    const partnerId = Number(req.body.partner_id || req.body.customer_id || 0);
    const note = String(req.body.note || "").trim();
    const items = parseItems(req.body.items);

    if (!partnerId) {
      return error(res, "Customer (partner_id) is required", 400);
    }

    if (!items || !items.length) {
      return error(res, "At least one product is required", 400);
    }

    const partners = await odooCall("res.partner", "search_read", {
      domain: [["id", "=", partnerId]],
      fields: ["id", "name"],
      limit: 1,
    });

    if (!partners.length) {
      return error(res, "Customer not found", 404);
    }

    const orderLines = [];

    for (const item of items) {
      const templateId = Number(item.product_id);
      const quantity = Number(item.quantity || 1);

      if (!templateId || quantity <= 0) {
        return error(res, "Invalid product or quantity", 400);
      }

      const variant = await getProductVariant(templateId);

      if (!variant) {
        return error(res, `Product variant not found for ID ${templateId}`, 400);
      }

      orderLines.push([
        0,
        0,
        {
          product_id: variant.id,
          product_uom_qty: quantity,
        },
      ]);
    }

    const createdIds = await odooCall("sale.order", "create", {
      vals_list: [
        {
          partner_id: partnerId,
          partner_invoice_id: partnerId,
          partner_shipping_id: partnerId,
          user_id: user.uid,
          order_line: orderLines,
          note: note || `Created by sales rep ${user.login} via QR POS`,
        },
      ],
    });

    const orderId = getCreatedId(createdIds);

    // Keep as New Quotation (draft) — do not send or confirm.
    const orders = await odooCall("sale.order", "search_read", {
      domain: [["id", "=", orderId]],
      fields: [
        "id",
        "name",
        "state",
        "amount_total",
        "date_order",
        "partner_id",
        "note",
      ],
      limit: 1,
    });

    return success(
      res,
      {
        message: "Quotation created",
        quotation: orders[0] ? formatQuotation(orders[0]) : null,
      },
      201
    );
  } catch (err) {
    return error(res, "Failed to create quotation", 500, getOdooError(err));
  }
}
