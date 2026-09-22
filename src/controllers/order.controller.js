import { success, error } from "../utils/response.js";
import { logServerError } from "../utils/safe-client-error.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { resolveShippingPartnerId } from "../utils/partner-scope.js";
import { normalizePartnerId } from "../utils/partner-id.js";
import {
  getPricelistPricesForProducts,
  resolvePricelistForPartner,
} from "../utils/membership-pricelist.js";
import {
  isDeliveryFeeWaived,
  isDeliveryProductName,
  isDeliveryVariant,
  resolveDeliveryFeeVariant,
} from "../utils/delivery-fee.js";
import {
  attachDeliverySummary,
  buildDeliveryBuckets,
  ORDER_DETAIL_FIELDS,
  ORDER_LINE_FIELDS,
  ORDER_LIST_FIELDS,
} from "../utils/order-delivery.js";
import { isCurrentTicketMonth } from "../utils/coupon-ticket-month.js";
import {
  ensureDeliveryMoveLines,
  listDeliveriesForOrders,
  listOrderDeliveries,
} from "../utils/stock-picking.js";

async function getProductVariant(productTemplateId) {
  const templates = await odooCall("product.template", "search_read", {
    domain: [["id", "=", productTemplateId]],
    fields: ["id", "list_price", "product_variant_id"],
    limit: 1,
  });

  const products = await odooCall("product.product", "search_read", {
    domain: [["product_tmpl_id", "=", productTemplateId]],
    fields: ["id", "name", "lst_price", "product_tmpl_id"],
    limit: 1,
  });

  const variant = products[0];

  if (!variant) {
    return null;
  }

  return {
    ...variant,
    product_variant_id: templates[0]?.product_variant_id || [variant.id, variant.name],
    list_price: templates[0]?.list_price ?? variant.lst_price,
  };
}

function getCreatedId(result) {
  if (Array.isArray(result)) return result[0];
  return result;
}

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function parseScalarId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (Array.isArray(value)) {
    return parseScalarId(value[0]);
  }

  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function formatPartnerAddress(partner) {
  if (!partner) {
    return "";
  }

  const lines = [
    partner.name,
    partner.phone,
    partner.street,
    partner.street2,
    [partner.city, partner.zip].filter(Boolean).join(" "),
    Array.isArray(partner.state_id) ? partner.state_id[1] : "",
    Array.isArray(partner.country_id) ? partner.country_id[1] : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function mapShippingAddress(partner) {
  if (!partner) {
    return null;
  }

  return {
    id: partner.id,
    name: partner.name || "",
    phone: partner.phone || "",
    street: partner.street || "",
    street2: partner.street2 || "",
    city: partner.city || "",
    zip: partner.zip || "",
    state: Array.isArray(partner.state_id) ? partner.state_id[1] : "",
    country: Array.isArray(partner.country_id) ? partner.country_id[1] : "",
    label: formatPartnerAddress(partner),
  };
}

async function attachShippingAddresses(orders) {
  if (!orders.length) {
    return orders;
  }

  const shippingIds = [
    ...new Set(
      orders
        .map((order) => order.partner_shipping_id?.[0])
        .filter((id) => typeof id === "number" && id > 0)
    ),
  ];

  if (!shippingIds.length) {
    return orders.map((order) => ({ ...order, shipping_address: null }));
  }

  const partners = await odooCall("res.partner", "read", {
    args: [
      shippingIds,
      [
        "id",
        "name",
        "phone",
        "street",
        "street2",
        "city",
        "zip",
        "state_id",
        "country_id",
      ],
    ],
  });

  const partnerMap = new Map(partners.map((partner) => [partner.id, partner]));

  return orders.map((order) => {
    const shippingId = order.partner_shipping_id?.[0];
    const partner =
      typeof shippingId === "number" ? partnerMap.get(shippingId) : null;

    return {
      ...order,
      shipping_address: mapShippingAddress(partner),
    };
  });
}

async function readShippingPartner(shippingPartnerId) {
  const partners = await odooCall("res.partner", "read", {
    args: [
      [shippingPartnerId],
      [
        "id",
        "name",
        "phone",
        "street",
        "street2",
        "city",
        "zip",
        "state_id",
        "country_id",
        "parent_id",
        "type",
      ],
    ],
  });

  return partners[0] || null;
}

async function applyOrderShippingAddress(orderId, shippingPartnerId) {
  const shippingPartner = await readShippingPartner(shippingPartnerId);

  if (!shippingPartner) {
    return null;
  }

  await odooCall("sale.order", "write", {
    ids: [orderId],
    vals: {
      partner_shipping_id: shippingPartnerId,
    },
  });

  const orders = await odooCall("sale.order", "read", {
    args: [[orderId], ["partner_shipping_id"]],
  });

  const appliedShippingId = orders[0]?.partner_shipping_id?.[0];

  if (appliedShippingId !== shippingPartnerId) {
    await odooCall("sale.order", "write", {
      ids: [orderId],
      vals: {
        partner_shipping_id: shippingPartnerId,
      },
    });
  }

  return shippingPartner;
}

function parseItems(rawItems) {
  if (Array.isArray(rawItems)) return rawItems;

  if (typeof rawItems === "string") {
    try {
      return JSON.parse(rawItems);
    } catch {
      return null;
    }
  }

  return null;
}

async function createAttachment(orderId, file) {
  if (!file) return null;

  const allowed = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
  const mimetype = String(file.mimetype || "").toLowerCase();

  if (!allowed.has(mimetype)) {
    throw new Error("INVALID_PAYMENT_SCREENSHOT_TYPE");
  }

  const base64File = file.buffer.toString("base64");

  const createdIds = await odooCall("ir.attachment", "create", {
    vals_list: [
      {
        name: file.originalname || "payment_screenshot.jpg",
        type: "binary",
        datas: base64File,
        res_model: "sale.order",
        res_id: orderId,
        mimetype,
      },
    ],
  });

  return getCreatedId(createdIds);
}

async function postOrderChatter(orderId, body, attachmentIds = []) {
  await odooCall("sale.order", "message_post", {
    ids: [orderId],
    kwargs: {
      body,
      message_type: "comment",
      subtype_xmlid: "mail.mt_note",
      attachment_ids: attachmentIds,
    },
  });
}

async function orderHasCouponDiscount(orderId) {
  const rewardLines = await odooCall("sale.order.line", "search_read", {
    domain: [
      ["order_id", "=", orderId],
      ["is_reward_line", "=", true],
    ],
    fields: ["id"],
    limit: 1,
  });

  if (Array.isArray(rewardLines) && rewardLines.length > 0) {
    return true;
  }

  // Membership-ticket fallback uses a normal negative discount line (not always
  // flagged as is_reward_line).
  const discountLines = await odooCall("sale.order.line", "search_read", {
    domain: [
      ["order_id", "=", orderId],
      ["price_unit", "<", 0],
    ],
    fields: ["id"],
    limit: 1,
  });

  return Array.isArray(discountLines) && discountLines.length > 0;
}

function rewardIdsFromAction(action) {
  const ctx = action && typeof action === "object" ? action.context || {} : {};
  const raw = ctx.default_reward_ids || ctx.reward_ids || [];
  return Array.isArray(raw) ? raw.filter((id) => Number(id) > 0) : [];
}

// Mirrors Odoo's "Enter Promotion or Coupon Code" flow. When only one reward is
// claimable, Odoo auto-applies it and returns True — do not open the reward
// wizard in that case (that was returning "No reward" and rolling back the order).
async function applyCouponToOrder(orderId, code) {
  const couponWizardId = getCreatedId(
    await odooCall("sale.loyalty.coupon.wizard", "create", {
      vals_list: [{ order_id: orderId, coupon_code: code }],
    })
  );

  const action = await odooCall("sale.loyalty.coupon.wizard", "action_apply", {
    args: [[couponWizardId]],
  });

  if (await orderHasCouponDiscount(orderId)) {
    return;
  }

  // Single-reward path: Odoo may return True after auto-apply. Only accept that
  // when a discount line actually landed — otherwise we would confirm to Sale
  // Order and burn the membership ticket with no discount.
  if (action === true) {
    if (await orderHasCouponDiscount(orderId)) {
      return;
    }
    throw new Error("Coupon applied in Odoo but no discount line was created.");
  }

  const opensRewardWizard =
    action &&
    typeof action === "object" &&
    (action.res_model === "sale.loyalty.reward.wizard" ||
      (action.type === "ir.actions.act_window" && action.context));

  if (!opensRewardWizard) {
    if (await orderHasCouponDiscount(orderId)) {
      return;
    }
    throw new Error("No reward is available for this coupon.");
  }

  let rewardIds = rewardIdsFromAction(action);
  const rewardWizardVals = { order_id: orderId };

  if (rewardIds.length) {
    rewardWizardVals.reward_ids = [[6, 0, rewardIds]];
  }

  const rewardWizardId =
    parseScalarId(action.res_id) ||
    getCreatedId(
      await odooCall("sale.loyalty.reward.wizard", "create", {
        vals_list: [rewardWizardVals],
      })
    );

  if (!rewardIds.length) {
    const wizards = await odooCall("sale.loyalty.reward.wizard", "read", {
      args: [[rewardWizardId], ["reward_ids"]],
    });
    rewardIds = (wizards && wizards[0] && wizards[0].reward_ids) || [];
  }

  if (!rewardIds.length) {
    if (await orderHasCouponDiscount(orderId)) {
      return;
    }
    throw new Error("No reward is available for this coupon.");
  }

  await odooCall("sale.loyalty.reward.wizard", "write", {
    ids: [rewardWizardId],
    vals: { selected_reward_id: rewardIds[0] },
  });

  await odooCall("sale.loyalty.reward.wizard", "action_apply", {
    args: [[rewardWizardId]],
  });

  if (!(await orderHasCouponDiscount(orderId))) {
    throw new Error("Coupon reward applied but no discount line was created.");
  }
}

// Fallback when loyalty has no matching code: put the Studio ticket amount on
// the order as a discount line, then mark the membership ticket used.
async function applyMembershipTicketDiscount(orderId, ticket) {
  const amount = Math.abs(Number(ticket.x_studio_coupon_amount) || 0);

  if (amount <= 0) {
    throw new Error("Coupon amount is zero");
  }

  let productId = parseScalarId(process.env.COUPON_DISCOUNT_PRODUCT_ID);

  if (!productId) {
    const products = await odooCall("product.product", "search_read", {
      domain: [
        "|",
        ["default_code", "=", "DISC"],
        ["name", "ilike", "Discount"],
      ],
      fields: ["id", "name"],
      limit: 1,
    });
    productId = products[0]?.id || null;
  }

  if (!productId) {
    throw new Error("No discount product configured for membership coupons");
  }

  await odooCall("sale.order", "write", {
    ids: [orderId],
    vals: {
      order_line: [
        [
          0,
          0,
          {
            product_id: productId,
            name: `Membership coupon ${ticket.x_studio_coupon_code || ""}`.trim(),
            product_uom_qty: 1,
            price_unit: -amount,
          },
        ],
      ],
    },
  });

  if (!(await orderHasCouponDiscount(orderId))) {
    throw new Error("Membership ticket discount line was not created.");
  }
}

async function markMembershipTicketUsed(ticketId, orderId) {
  await odooCall("x_membership_coupon_ti", "write", {
    ids: [ticketId],
    vals: {
      x_studio_status: "Used",
      x_studio_used_sale_order: orderId,
    },
  });
}

export async function createCheckout(req, res) {
  try {
    const user = await getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const {
      payment_method = "cod",
      order_type = "quotation_sent",
      note = "",
      preferred_delivery_date = null,
      delivery_notes = "",
      coupon_code: rawCouponCode = "",
    } = req.body;

    const coupon_code = String(rawCouponCode || "").trim();

    const address_id = req.body.address_id ?? req.body.addressId;

    const items = parseItems(req.body.items);

    if (!items || !Array.isArray(items) || !items.length) {
      return error(res, "Cart items are required", 400);
    }

    if (!["quotation", "quotation_sent", "sale_order"].includes(order_type)) {
      return error(res, "Invalid order_type. Use quotation, quotation_sent, or sale_order", 400);
    }

    if (payment_method === "wire_transfer" && !req.file) {
      return error(res, "Payment screenshot is required for wire transfer", 400);
    }

    const shippingPartnerId = await resolveShippingPartnerId(
      { partner_id: partnerId },
      address_id,
    );

    if (!shippingPartnerId) {
      return error(
        res,
        parseScalarId(address_id)
          ? "Selected delivery address is invalid"
          : "Delivery address is required",
        400
      );
    }

    const orderLines = [];
    let cartSubtotal = 0;
    const [{ pricelistId }, deliveryFeeWaived] = await Promise.all([
      resolvePricelistForPartner(partnerId),
      isDeliveryFeeWaived(partnerId),
    ]);
    const resolvedVariants = [];

    for (const item of items) {
      const templateId = Number(item.product_id);
      const quantity = Number(item.quantity || 1);

      if (!templateId || quantity <= 0) {
        return error(res, "Invalid product or quantity", 400);
      }

      const variant = await getProductVariant(templateId);

      if (!variant) {
        return error(res, `Product variant not found for product.template ID ${templateId}`, 400);
      }

      // Always drop client Delivery lines; backend adds the correct fee (or none).
      // Pro/Premium/Shop waive → no fee. Others → fee from selected branch zip.
      if (isDeliveryVariant(variant)) {
        continue;
      }

      resolvedVariants.push({ templateId, quantity, variant });
    }

    if (!resolvedVariants.length) {
      return error(res, "Cart items are required", 400);
    }

    const priceByTemplate = pricelistId
      ? await getPricelistPricesForProducts(
          pricelistId,
          resolvedVariants.map(({ templateId, variant }) => ({
            id: templateId,
            product_variant_id: variant.product_variant_id || variant.id,
          })),
          partnerId
        )
      : new Map();

    for (const { templateId, quantity, variant } of resolvedVariants) {
      const unitPrice =
        priceByTemplate.get(templateId) ??
        Number(variant.list_price) ??
        Number(variant.lst_price) ??
        0;

      cartSubtotal += unitPrice * quantity;

      orderLines.push([
        0,
        0,
        {
          product_id: variant.id,
          product_uom_qty: quantity,
          ...(pricelistId ? { price_unit: unitPrice } : {}),
        },
      ]);
    }

    // Coupon validation: order total must be at least the coupon amount, and the
    // coupon must still be available for this customer.
    let membershipTicket = null;

    if (coupon_code) {
      const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
        domain: [
          ["x_studio_coupon_code", "=", coupon_code],
          ["x_studio_customer", "=", partnerId],
        ],
        fields: [
          "id",
          "x_studio_coupon_code",
          "x_studio_coupon_amount",
          "x_studio_status",
          "x_studio_used_sale_order",
          "x_studio_ticket_month",
        ],
        limit: 1,
      });

      membershipTicket = coupons[0] || null;

      if (!membershipTicket) {
        return error(res, "Coupon not found for this account", 400);
      }

      if (
        membershipTicket.x_studio_status !== "Currently Available" ||
        membershipTicket.x_studio_used_sale_order
      ) {
        return error(res, "This coupon is no longer available", 400);
      }

      if (!isCurrentTicketMonth(membershipTicket.x_studio_ticket_month)) {
        return error(res, "This coupon is not valid for the current month", 400);
      }

      const couponAmount = Number(membershipTicket.x_studio_coupon_amount) || 0;

      if (couponAmount > 0 && cartSubtotal < couponAmount) {
        return error(
          res,
          "You can't use the price that is lower than the coupon amount",
          400
        );
      }
    }

    // Auto delivery fee from selected branch postal → x_delivery_fee.
    // Waived for Active Pro/Premium or partner tag Shop (case-insensitive).
    // Cart Delivery lines are stripped above so branch changes never keep a stale fee.
    // Coupon minimum still uses cart-only subtotal (above).
    if (!deliveryFeeWaived) {
      const shippingForFee = await readShippingPartner(shippingPartnerId);
      const deliveryFee = await resolveDeliveryFeeVariant(shippingForFee?.zip);

      if (deliveryFee?.productId) {
        orderLines.push([
          0,
          0,
          {
            product_id: deliveryFee.productId,
            product_uom_qty: 1,
            price_unit: deliveryFee.listPrice,
          },
        ]);
      }
    }

    const orderVals = {
      partner_id: partnerId,
      partner_invoice_id: partnerId,
      partner_shipping_id: shippingPartnerId,

      x_studio_preferred_delivery_date: preferred_delivery_date || false,
      x_studio_delivery_notes: delivery_notes || false,

      order_line: orderLines,
    };

    if (pricelistId) {
      orderVals.pricelist_id = pricelistId;
    }

    // Only the customer's own note is written to the order note. The
    // payment/coupon/delivery summary is intentionally not duplicated here — it
    // lives in the chatter and the dedicated delivery fields instead.
    if (note) {
      orderVals.note = note;
    }

    const createdIds = await odooCall("sale.order", "create", {
      vals_list: [orderVals],
    });

    const orderId = getCreatedId(createdIds);

    await applyOrderShippingAddress(orderId, shippingPartnerId);

    // Apply the coupon while the order is still a draft. Prefer Odoo loyalty;
    // if that fails (e.g. Studio ticket with no loyalty.card), fall back to a
    // fixed discount line from the membership ticket amount.
    // With a coupon we confirm to Sale Order + mark ticket Used so it cannot
    // be used again — but only after a real discount line exists.
    if (coupon_code) {
      try {
        await applyCouponToOrder(orderId, coupon_code);
      } catch (loyaltyErr) {
        logServerError("Loyalty coupon apply failed; trying ticket discount", loyaltyErr);

        try {
          if (!membershipTicket) {
            throw loyaltyErr;
          }
          await applyMembershipTicketDiscount(orderId, membershipTicket);
        } catch (couponErr) {
          await odooCall("sale.order", "unlink", { args: [[orderId]] }).catch(() => {});
          logServerError("Coupon could not be applied", couponErr);
          return error(res, "Coupon could not be applied", 400, { code: "COUPON_APPLY_FAILED" });
        }
      }

      if (!(await orderHasCouponDiscount(orderId))) {
        await odooCall("sale.order", "unlink", { args: [[orderId]] }).catch(() => {});
        return error(res, "Coupon could not be applied", 400, { code: "COUPON_APPLY_FAILED" });
      }

      // Confirm → Sale Order so Odoo + ticket status lock one-time use.
      await odooCall("sale.order", "action_confirm", {
        ids: [orderId],
      });
      await ensureDeliveryMoveLines(orderId).catch((err) => {
        console.log("ensureDeliveryMoveLines after coupon confirm:", err?.message || err);
      });

      if (membershipTicket?.id) {
        try {
          await markMembershipTicketUsed(membershipTicket.id, orderId);
        } catch (err) {
          logServerError("Failed to mark membership coupon ticket used", err);
          // Order is already confirmed with discount; surface so ops can fix
          // the ticket manually rather than silently allowing reuse.
          return error(
            res,
            "Order created with coupon, but ticket could not be marked used",
            500,
            { code: "COUPON_TICKET_MARK_FAILED", order_id: orderId }
          );
        }
      }
    } else if (order_type === "quotation_sent") {
      await odooCall("sale.order", "write", {
        ids: [orderId],
        vals: {
          state: "sent",
        },
      });
    } else if (order_type === "sale_order") {
      await odooCall("sale.order", "action_confirm", {
        ids: [orderId],
      });
      await ensureDeliveryMoveLines(orderId).catch((err) => {
        console.log("ensureDeliveryMoveLines after sale confirm:", err?.message || err);
      });
    }

    const shippingPartner = await applyOrderShippingAddress(orderId, shippingPartnerId);

    if (shippingPartner) {
      await postOrderChatter(
        orderId,
        `QR Shop delivery branch selected:\n${formatPartnerAddress(shippingPartner)}`
      );
    }

    const productSummary = resolvedVariants
      .map(({ quantity, variant }) => `- ${variant.name || `Product #${variant.id}`} × ${quantity}`)
      .join("\n");

    if (productSummary) {
      await postOrderChatter(orderId, `QR Shop delivery products:\n${productSummary}`);
    }

    if (payment_method === "wire_transfer") {
      const attachmentId = await createAttachment(orderId, req.file);

      await postOrderChatter(
        orderId,
        "This customer has paid their order. Payment Method: Wire Transfer / KPay. Payment screenshot is attached below.",
        attachmentId ? [attachmentId] : []
      );
    }

    if (payment_method === "cod") {
      await postOrderChatter(
        orderId,
        "Customer selected Cash on Delivery. No payment screenshot required."
      );
    }

    const orders = await attachShippingAddresses(
      await odooCall("sale.order", "search_read", {
        domain: [["id", "=", orderId]],
        fields: [
          "id",
          "name",
          "state",
          "amount_total",
          "partner_id",
          "partner_shipping_id",
          "date_order",
          "note",
          "x_studio_preferred_delivery_date",
          "x_studio_delivery_notes",
        ],
        limit: 1,
      })
    );

    return success(res, {
      message: coupon_code
        ? "Order confirmed with coupon applied"
        : order_type === "sale_order"
        ? "Sale order created"
        : order_type === "quotation_sent"
        ? "Quotation sent created"
        : "Quotation created",
      order: orders[0] || null,
    });
  } catch (err) {
    console.log("Checkout Odoo Error:", getOdooError(err));
    logServerError("Checkout failed", err);
    return error(res, "Checkout failed", 500);
  }
}

async function loadOrderLinesByOrderIds(orderIds) {
  const uniqueIds = [...new Set((orderIds || []).filter((id) => typeof id === "number" && id > 0))];

  if (!uniqueIds.length) {
    return new Map();
  }

  try {
    const lines = await odooCall("sale.order.line", "search_read", {
      domain: [["order_id", "in", uniqueIds]],
      fields: [...ORDER_LINE_FIELDS, "order_id"],
      limit: Math.max(500, uniqueIds.length * 40),
    });

    const byOrderId = new Map();

    for (const line of lines) {
      const orderId = Array.isArray(line.order_id) ? line.order_id[0] : Number(line.order_id);

      if (!orderId) {
        continue;
      }

      const bucket = byOrderId.get(orderId) || [];
      bucket.push(line);
      byOrderId.set(orderId, bucket);
    }

    return byOrderId;
  } catch (err) {
    console.log("Order delivery line enrichment failed:", getOdooError(err));
    return new Map();
  }
}

async function loadDeliveriesByOrders(orders) {
  try {
    return await listDeliveriesForOrders(orders);
  } catch (err) {
    console.log("Order delivery picking enrichment failed:", getOdooError(err));
    return new Map();
  }
}

async function readSaleOrders(domain, fields, extra = {}) {
  try {
    return await odooCall("sale.order", "search_read", {
      domain,
      fields,
      ...extra,
    });
  } catch (err) {
    // Older / stripped Odoo DBs may lack invoice_status or picking_ids; keep orders working.
    const message = String(getOdooError(err) || "");
    let nextFields = fields;

    if (fields.includes("invoice_status") && /invoice_status/i.test(message)) {
      nextFields = nextFields.filter((field) => field !== "invoice_status");
    }
    if (fields.includes("picking_ids") && /picking_ids/i.test(message)) {
      nextFields = nextFields.filter((field) => field !== "picking_ids");
    }

    if (nextFields.length !== fields.length) {
      return odooCall("sale.order", "search_read", {
        domain,
        fields: nextFields,
        ...extra,
      });
    }
    throw err;
  }
}

export async function getOrders(req, res) {
  try {
    const user = await getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const orders = await attachShippingAddresses(
      await readSaleOrders([["partner_id", "=", partnerId]], ORDER_LIST_FIELDS, {
        order: "date_order desc",
        limit: 50,
      })
    );

    const linesByOrderId = await loadOrderLinesByOrderIds(orders.map((order) => order.id));
    const deliveriesByOrderId = await loadDeliveriesByOrders(orders);
    const enrichedOrders = orders.map((order) =>
      attachDeliverySummary(
        order,
        linesByOrderId.get(order.id) || [],
        deliveriesByOrderId.get(order.id) || []
      )
    );

    return success(res, { orders: enrichedOrders });
  } catch (err) {
    logServerError("Failed to get orders", err);
    return error(res, "Failed to get orders", 500);
  }
}

export async function getOrderById(req, res) {
  try {
    const user = await getAuthUser(req);
    const orderId = Number(req.params.id);

    if (!user) return error(res, "Unauthorized", 401);
    if (!orderId) return error(res, "Invalid order ID", 400);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const orders = await attachShippingAddresses(
      await readSaleOrders(
        [
          ["id", "=", orderId],
          ["partner_id", "=", partnerId],
        ],
        ORDER_DETAIL_FIELDS,
        { limit: 1 }
      )
    );

    if (!orders.length) return error(res, "Order not found", 404);

    let lines = [];

    try {
      lines = await odooCall("sale.order.line", "search_read", {
        domain: [["order_id", "=", orderId]],
        fields: ORDER_LINE_FIELDS,
      });
    } catch (err) {
      console.log("Order line delivery fields failed, using basic lines:", getOdooError(err));
      lines = await odooCall("sale.order.line", "search_read", {
        domain: [["order_id", "=", orderId]],
        fields: ["id", "product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"],
      });
    }

    const buckets = buildDeliveryBuckets(lines);
    const enrichedLines = lines.map((line) => {
      const mapped = buckets.productLines.find((item) => item.id === line.id);

      if (!mapped) {
        return line;
      }

      return {
        ...line,
        qty_ordered: mapped.qty_ordered,
        qty_delivered: mapped.qty_delivered,
        qty_pending: mapped.qty_pending,
      };
    });

    const deliveries = await listOrderDeliveries(orderId, orders[0].name);

    return success(res, {
      order: attachDeliverySummary(orders[0], lines, deliveries),
      lines: enrichedLines,
      delivering_now: buckets.delivering_now,
      coming_later: buckets.coming_later,
      deliveries,
    });
  } catch (err) {
    logServerError("Failed to get order", err);
    return error(res, "Failed to get order", 500);
  }
}

export async function reorder(req, res) {
  try {
    const user = await getAuthUser(req);
    const oldOrderId = Number(req.params.id);

    if (!user) return error(res, "Unauthorized", 401);
    if (!oldOrderId) return error(res, "Invalid order ID", 400);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const oldOrders = await odooCall("sale.order", "search_read", {
      domain: [
        ["id", "=", oldOrderId],
        ["partner_id", "=", partnerId],
      ],
      fields: [
        "id",
        "name",
        "partner_shipping_id",
        "x_studio_preferred_delivery_date",
        "x_studio_delivery_notes",
      ],
      limit: 1,
    });

    if (!oldOrders.length) return error(res, "Previous order not found", 404);

    const oldLines = await odooCall("sale.order.line", "search_read", {
      domain: [["order_id", "=", oldOrderId]],
      fields: ["product_id", "product_uom_qty", "is_reward_line", "price_unit", "name"],
    });

    if (!oldLines.length) return error(res, "Previous order has no products", 400);

    const newLines = oldLines
      .filter((line) => {
        if (!line.product_id || !line.product_id[0]) return false;
        if (line.is_reward_line) return false;
        if (Number(line.price_unit) < 0) return false;
        const label = Array.isArray(line.product_id) ? line.product_id[1] : line.name;
        if (isDeliveryProductName(label)) return false;
        return true;
      })
      .map((line) => [
        0,
        0,
        {
          product_id: line.product_id[0],
          product_uom_qty: line.product_uom_qty,
        },
      ]);

    if (!newLines.length) {
      return error(res, "Previous order has no products to reorder", 400);
    }

    const createdIds = await odooCall("sale.order", "create", {
      vals_list: [
        {
          partner_id: partnerId,
          partner_invoice_id: partnerId,
          partner_shipping_id:
            oldOrders[0].partner_shipping_id?.[0] || partnerId,

          x_studio_preferred_delivery_date:
            oldOrders[0].x_studio_preferred_delivery_date || false,

          x_studio_delivery_notes:
            oldOrders[0].x_studio_delivery_notes || false,

          order_line: newLines,
          note: `Reorder from ${oldOrders[0].name}`,
        },
      ],
    });

    const newOrderId = getCreatedId(createdIds);

    const newOrders = await attachShippingAddresses(
      await odooCall("sale.order", "search_read", {
        domain: [["id", "=", newOrderId]],
        fields: [
          "id",
          "name",
          "state",
          "amount_total",
          "date_order",
          "partner_shipping_id",
          "x_studio_preferred_delivery_date",
          "x_studio_delivery_notes",
        ],
        limit: 1,
      })
    );

    return success(res, {
      message: "Reorder quotation created",
      order: newOrders[0] || null,
    });
  } catch (err) {
    logServerError("Reorder failed", err);
    return error(res, "Reorder failed", 500);
  }
}