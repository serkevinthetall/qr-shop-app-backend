import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { resolveShippingPartnerId } from "../utils/partner-scope.js";
import { normalizePartnerId } from "../utils/partner-id.js";

async function getProductVariant(productTemplateId) {
  const templates = await odooCall("product.template", "search_read", {
    domain: [["id", "=", productTemplateId]],
    fields: ["id", "list_price"],
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

  const base64File = file.buffer.toString("base64");

  const createdIds = await odooCall("ir.attachment", "create", {
    vals_list: [
      {
        name: file.originalname || "payment_screenshot.jpg",
        type: "binary",
        datas: base64File,
        res_model: "sale.order",
        res_id: orderId,
        mimetype: file.mimetype || "image/jpeg",
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

// Mirrors Odoo's "Enter Promotion or Coupon Code" flow: type the code, then
// claim the matching reward so the discount line lands on the order. Odoo's own
// loyalty/discount program does the actual price reduction. Throws when Odoo
// rejects the code (invalid, expired, already used, below program minimum).
async function applyCouponToOrder(orderId, code) {
  const couponWizardId = getCreatedId(
    await odooCall("sale.loyalty.coupon.wizard", "create", {
      vals_list: [{ order_id: orderId, coupon_code: code }],
    })
  );

  const action = await odooCall("sale.loyalty.coupon.wizard", "action_apply", {
    args: [[couponWizardId]],
  });

  const rewardWizardId = getCreatedId(
    await odooCall("sale.loyalty.reward.wizard", "create", {
      vals_list: [{ order_id: orderId }],
    })
  );

  let rewardIds =
    (action && action.context && action.context.default_reward_ids) || [];

  if (!rewardIds.length) {
    const wizards = await odooCall("sale.loyalty.reward.wizard", "read", {
      args: [[rewardWizardId], ["reward_ids"]],
    });
    rewardIds = (wizards && wizards[0] && wizards[0].reward_ids) || [];
  }

  if (!rewardIds.length) {
    throw new Error("No reward is available for this coupon.");
  }

  await odooCall("sale.loyalty.reward.wizard", "write", {
    ids: [rewardWizardId],
    vals: { selected_reward_id: rewardIds[0] },
  });

  await odooCall("sale.loyalty.reward.wizard", "action_apply", {
    args: [[rewardWizardId]],
  });
}

export async function createCheckout(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const {
      payment_method = "cod",
      order_type = "quotation_sent",
      note = "",
      preferred_delivery_date = null,
      delivery_notes = "",
      coupon_code = "",
    } = req.body;

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

      cartSubtotal +=
        (Number(variant.list_price) || Number(variant.lst_price) || 0) * quantity;

      orderLines.push([
        0,
        0,
        {
          product_id: variant.id,
          product_uom_qty: quantity,
        },
      ]);
    }

    // Coupon validation: order total must be at least the coupon amount, and the
    // coupon must still be available for this customer.
    if (coupon_code) {
      const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
        domain: [
          ["x_studio_coupon_code", "=", coupon_code],
          ["x_studio_customer", "=", partnerId],
        ],
        fields: [
          "id",
          "x_studio_coupon_amount",
          "x_studio_status",
          "x_studio_used_sale_order",
        ],
        limit: 1,
      });

      const coupon = coupons[0];

      if (!coupon) {
        return error(res, "Coupon not found for this account", 400);
      }

      if (coupon.x_studio_status !== "Currently Available" || coupon.x_studio_used_sale_order) {
        return error(res, "This coupon is no longer available", 400);
      }

      const couponAmount = Number(coupon.x_studio_coupon_amount) || 0;

      if (couponAmount > 0 && cartSubtotal < couponAmount) {
        return error(
          res,
          "You can't use the price that is lower than the coupon amount",
          400
        );
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

    // Apply the coupon while the order is still a draft. Odoo's loyalty program
    // adds the discount line and marks the coupon used.
    if (coupon_code) {
      try {
        await applyCouponToOrder(orderId, coupon_code);
      } catch (couponErr) {
        await odooCall("sale.order", "unlink", { args: [[orderId]] }).catch(() => {});
        return error(
          res,
          "Coupon could not be applied",
          400,
          getOdooError(couponErr)
        );
      }
    }

    if (coupon_code) {
      // A used coupon must be consumed. Confirming the order triggers the Odoo
      // automation that flips the membership coupon ticket status to "Used".
      await odooCall("sale.order", "action_confirm", {
        ids: [orderId],
      });
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
    }

    const shippingPartner = await applyOrderShippingAddress(orderId, shippingPartnerId);

    if (shippingPartner) {
      await postOrderChatter(
        orderId,
        `QR Shop delivery branch selected:\n${formatPartnerAddress(shippingPartner)}`
      );
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
    return error(res, "Checkout failed", 500, getOdooError(err));
  }
}

export async function getOrders(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const orders = await attachShippingAddresses(
      await odooCall("sale.order", "search_read", {
        domain: [["partner_id", "=", partnerId]],
        fields: [
          "id",
          "name",
          "state",
          "amount_total",
          "date_order",
          "partner_id",
          "partner_shipping_id",
          "order_line",
          "x_studio_preferred_delivery_date",
          "x_studio_delivery_notes",
        ],
        order: "date_order desc",
        limit: 50,
      })
    );

    return success(res, { orders });
  } catch (err) {
    return error(res, "Failed to get orders", 500, getOdooError(err));
  }
}

export async function getOrderById(req, res) {
  try {
    const user = getAuthUser(req);
    const orderId = Number(req.params.id);

    if (!user) return error(res, "Unauthorized", 401);
    if (!orderId) return error(res, "Invalid order ID", 400);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const orders = await attachShippingAddresses(
      await odooCall("sale.order", "search_read", {
        domain: [
          ["id", "=", orderId],
          ["partner_id", "=", partnerId],
        ],
        fields: [
          "id",
          "name",
          "state",
          "amount_total",
          "date_order",
          "partner_id",
          "partner_shipping_id",
          "order_line",
          "note",
          "x_studio_preferred_delivery_date",
          "x_studio_delivery_notes",
        ],
        limit: 1,
      })
    );

    if (!orders.length) return error(res, "Order not found", 404);

    const lines = await odooCall("sale.order.line", "search_read", {
      domain: [["order_id", "=", orderId]],
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
      order: orders[0],
      lines,
    });
  } catch (err) {
    return error(res, "Failed to get order", 500, getOdooError(err));
  }
}

export async function reorder(req, res) {
  try {
    const user = getAuthUser(req);
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
      fields: ["product_id", "product_uom_qty", "is_reward_line"],
    });

    if (!oldLines.length) return error(res, "Previous order has no products", 400);

    const newLines = oldLines
      .filter((line) => line.product_id && line.product_id[0] && !line.is_reward_line)
      .map((line) => [
        0,
        0,
        {
          product_id: line.product_id[0],
          product_uom_qty: line.product_uom_qty,
        },
      ]);

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
    return error(res, "Reorder failed", 500, getOdooError(err));
  }
}