import { odooCall } from "../services/odoo.service.js";

function asId(value) {
  if (Array.isArray(value)) return Number(value[0]) || 0;
  return Number(value) || 0;
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
