import { odooCall } from "../services/odoo.service.js";

function asId(value) {
  if (Array.isArray(value)) return Number(value[0]) || 0;
  return Number(value) || 0;
}

/** Odoo stock.picking.state → customer-facing label (Sale → Delivery style). */
export function mapPickingState(state) {
  const normalized = String(state || "").trim();

  switch (normalized) {
    case "done":
      return { state: "done", label: "Done" };
    case "cancel":
      return { state: "cancel", label: "Cancelled" };
    case "assigned":
      return { state: "assigned", label: "Ready" };
    case "confirmed":
    case "waiting":
      return { state: normalized, label: "Waiting" };
    case "draft":
    default:
      return { state: normalized || "draft", label: "Draft" };
  }
}

function formatDeliveryRow(picking, index, orderName = "") {
  const mapped = mapPickingState(picking.state);
  return {
    id: picking.id,
    name: String(picking.name || `Delivery ${index + 1}`),
    sequence: index + 1,
    state: mapped.state,
    state_label: mapped.label,
    scheduled_date: picking.scheduled_date || null,
    date_done: picking.date_done || null,
    origin: picking.origin || orderName || null,
  };
}

function isOutgoingPicking(picking) {
  const code = String(picking.picking_type_code || "");
  return !code || code === "outgoing";
}

/**
 * Same documents as the Sale Order "Delivery" smart button in Odoo.
 * Returns outgoing pickings linked to the SO (picking_ids / sale_id / origin).
 */
export async function listOrderDeliveries(orderId, orderName = "") {
  const id = Number(orderId);
  if (!id) return [];

  let pickingIds = [];

  try {
    const orders = await odooCall("sale.order", "search_read", {
      domain: [["id", "=", id]],
      fields: ["id", "name", "picking_ids"],
      limit: 1,
    });
    const order = orders?.[0];
    if (order) {
      orderName = order.name || orderName;
      pickingIds = Array.isArray(order.picking_ids) ? order.picking_ids.filter(Boolean) : [];
    }
  } catch (err) {
    console.log("listOrderDeliveries order read:", err?.message || err);
  }

  if (!pickingIds.length) {
    const domain = orderName
      ? ["|", ["sale_id", "=", id], ["origin", "=", orderName]]
      : [["sale_id", "=", id]];

    try {
      const found = await odooCall("stock.picking", "search_read", {
        domain,
        fields: ["id"],
        limit: 20,
      });
      pickingIds = (found || []).map((row) => row.id).filter(Boolean);
    } catch (err) {
      console.log("listOrderDeliveries picking search:", err?.message || err);
      return [];
    }
  }

  if (!pickingIds.length) {
    return [];
  }

  try {
    const pickings = await odooCall("stock.picking", "search_read", {
      domain: [["id", "in", pickingIds]],
      fields: [
        "id",
        "name",
        "state",
        "scheduled_date",
        "date_done",
        "origin",
        "picking_type_code",
      ],
      order: "id asc",
      limit: 20,
    });

    return (pickings || [])
      .filter(isOutgoingPicking)
      .map((picking, index) => formatDeliveryRow(picking, index, orderName));
  } catch (err) {
    console.log("listOrderDeliveries picking read:", err?.message || err);
    return [];
  }
}

/**
 * Batch-load outgoing deliveries for an order list (Sale Delivery smart-button docs).
 * Uses each order's picking_ids to avoid N+1 Odoo reads.
 */
export async function listDeliveriesForOrders(orders) {
  const byOrderId = new Map();
  const list = Array.isArray(orders) ? orders : [];

  for (const order of list) {
    byOrderId.set(order.id, []);
  }

  const pickingIds = [];
  const orderIdsByPickingId = new Map();

  for (const order of list) {
    const ids = Array.isArray(order.picking_ids) ? order.picking_ids.filter(Boolean) : [];
    for (const pickingId of ids) {
      pickingIds.push(pickingId);
      const linked = orderIdsByPickingId.get(pickingId) || [];
      linked.push(order.id);
      orderIdsByPickingId.set(pickingId, linked);
    }
  }

  const uniqueIds = [...new Set(pickingIds)];
  if (!uniqueIds.length) {
    return byOrderId;
  }

  try {
    const pickings = await odooCall("stock.picking", "search_read", {
      domain: [["id", "in", uniqueIds]],
      fields: [
        "id",
        "name",
        "state",
        "scheduled_date",
        "date_done",
        "origin",
        "picking_type_code",
      ],
      order: "id asc",
      limit: 200,
    });

    const counters = new Map();

    for (const picking of pickings || []) {
      if (!isOutgoingPicking(picking)) continue;

      const orderIds = orderIdsByPickingId.get(picking.id) || [];
      for (const orderId of orderIds) {
        const order = list.find((row) => row.id === orderId);
        const sequence = (counters.get(orderId) || 0) + 1;
        counters.set(orderId, sequence);
        const rows = byOrderId.get(orderId) || [];
        rows.push(formatDeliveryRow(picking, sequence - 1, order?.name || ""));
        byOrderId.set(orderId, rows);
      }
    }
  } catch (err) {
    console.log("listDeliveriesForOrders picking read:", err?.message || err);
  }

  return byOrderId;
}

/**
 * After sale.order confirm, Odoo creates stock.move on the delivery.
 * The SO "Delivery" popup shows stock.move.line ("move lines").
 * Those lines are often missing until reservation — so the popup says
 * "No move lines" with no product name / qty even when Operations has moves.
 *
 * Force-assign the picking, then create any missing move lines from moves
 * so PRODUCT + DEMAND/QTY are visible and Validate can work.
 */
export async function ensureDeliveryMoveLines(orderId) {
  const id = Number(orderId);
  if (!id) return { ok: false, reason: "invalid_order_id" };

  const orders = await odooCall("sale.order", "search_read", {
    domain: [["id", "=", id]],
    fields: ["id", "name", "picking_ids", "state"],
    limit: 1,
  });

  const order = orders?.[0];
  if (!order) return { ok: false, reason: "order_not_found" };

  let pickingIds = Array.isArray(order.picking_ids) ? order.picking_ids.filter(Boolean) : [];

  if (!pickingIds.length) {
    const found = await odooCall("stock.picking", "search_read", {
      domain: [
        "|",
        ["sale_id", "=", id],
        ["origin", "=", order.name],
      ],
      fields: ["id"],
      limit: 20,
    });
    pickingIds = (found || []).map((row) => row.id).filter(Boolean);
  }

  if (!pickingIds.length) {
    return { ok: false, reason: "no_pickings" };
  }

  try {
    await odooCall("stock.picking", "action_assign", {
      args: [pickingIds],
    });
  } catch (err) {
    console.log(
      "ensureDeliveryMoveLines action_assign:",
      err?.response?.data || err?.message || err
    );
  }

  const pickings = await odooCall("stock.picking", "search_read", {
    domain: [["id", "in", pickingIds]],
    fields: ["id", "name", "state", "move_ids", "move_line_ids"],
  });

  let createdLines = 0;

  for (const picking of pickings || []) {
    const moveIds = Array.isArray(picking.move_ids) ? picking.move_ids : [];
    const existingLineIds = Array.isArray(picking.move_line_ids) ? picking.move_line_ids : [];

    if (!moveIds.length) {
      console.log(
        `ensureDeliveryMoveLines: picking ${picking.name || picking.id} has no stock.move (product may not be storable)`
      );
      continue;
    }

    if (existingLineIds.length) {
      continue;
    }

    const moves = await odooCall("stock.move", "search_read", {
      domain: [["id", "in", moveIds]],
      fields: [
        "id",
        "name",
        "product_id",
        "product_uom_qty",
        "product_uom",
        "location_id",
        "location_dest_id",
        "company_id",
        "move_line_ids",
        "picking_id",
      ],
    });

    for (const move of moves || []) {
      if (Array.isArray(move.move_line_ids) && move.move_line_ids.length) {
        continue;
      }

      const productId = asId(move.product_id);
      const uomId = asId(move.product_uom);
      const locationId = asId(move.location_id);
      const locationDestId = asId(move.location_dest_id);
      const companyId = asId(move.company_id);
      const qty = Number(move.product_uom_qty) || 0;

      if (!productId || !uomId || !locationId || !locationDestId || qty <= 0) {
        continue;
      }

      const lineVals = {
        picking_id: picking.id,
        move_id: move.id,
        product_id: productId,
        product_uom_id: uomId,
        location_id: locationId,
        location_dest_id: locationDestId,
        quantity: qty,
      };

      if (companyId) {
        lineVals.company_id = companyId;
      }

      try {
        await odooCall("stock.move.line", "create", {
          vals_list: [lineVals],
        });
        createdLines += 1;
      } catch (createErr) {
        // Odoo 16 and some DBs still use qty_done instead of quantity.
        try {
          const { quantity: _quantity, ...legacyVals } = lineVals;
          await odooCall("stock.move.line", "create", {
            vals_list: [
              {
                ...legacyVals,
                qty_done: qty,
                product_uom_qty: qty,
              },
            ],
          });
          createdLines += 1;
        } catch (legacyErr) {
          console.log(
            "ensureDeliveryMoveLines create move line failed:",
            legacyErr?.response?.data || legacyErr?.message || legacyErr
          );
        }
      }
    }
  }

  return {
    ok: true,
    pickingIds,
    createdLines,
  };
}
