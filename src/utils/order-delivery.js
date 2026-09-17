import { isDeliveryProductName } from "./delivery-fee.js";

/**
 * Customer-facing delivery status for QR Shop.
 * Inspired by Odoo Sale → Delivery smart button + qty_delivered.
 *
 * pending           → quotation
 * preparing         → confirmed, delivery not ready yet
 * out_for_delivery  → Odoo picking Ready (assigned) — like Delivery Out
 * partial           → some delivered, some still waiting
 * delivered         → all product qty delivered, not fully invoiced
 * completed         → invoice_status = invoiced
 * cancelled         → cancelled
 */
export function resolveDeliveryStatus({ state, invoiceStatus, productLines, deliveries }) {
  const normalizedState = String(state || "").trim();
  const normalizedInvoice = String(invoiceStatus || "").trim();
  const pickingList = Array.isArray(deliveries) ? deliveries : [];

  if (normalizedState === "cancel") {
    return "cancelled";
  }

  if (normalizedInvoice === "invoiced") {
    return "completed";
  }

  if (normalizedState === "draft" || normalizedState === "sent") {
    return "pending";
  }

  const lines = Array.isArray(productLines) ? productLines : [];
  let ordered = 0;
  let delivered = 0;

  for (const line of lines) {
    const qtyOrdered = Number(line.qty_ordered ?? line.product_uom_qty) || 0;
    const qtyDelivered = Math.min(Number(line.qty_delivered) || 0, qtyOrdered);
    ordered += qtyOrdered;
    delivered += qtyDelivered;
  }

  if (ordered > 0 && delivered + 1e-9 >= ordered) {
    return "delivered";
  }

  if (delivered > 0 && delivered + 1e-9 < ordered) {
    return "partial";
  }

  // Mirror Odoo: Ready picking = goods reserved / out for delivery.
  const hasReadyPicking = pickingList.some((picking) => String(picking.state) === "assigned");
  if (hasReadyPicking && delivered <= 0) {
    return "out_for_delivery";
  }

  if (ordered <= 0) {
    return normalizedState === "sale" || normalizedState === "done" ? "preparing" : "pending";
  }

  return "preparing";
}

export function isProductDeliveryLine(line) {
  if (!line) {
    return false;
  }

  if (line.display_type) {
    return false;
  }

  if (line.is_reward_line) {
    return false;
  }

  if (line.price_subtotal < 0) {
    return false;
  }

  const productName = Array.isArray(line.product_id) ? line.product_id[1] : line.name;
  if (isDeliveryProductName(productName) || isDeliveryProductName(line.name)) {
    return false;
  }

  const qtyOrdered = Number(line.product_uom_qty) || 0;
  return qtyOrdered > 0;
}

export function mapDeliveryLine(line) {
  const qtyOrdered = Number(line.product_uom_qty) || 0;
  const qtyDelivered = Math.max(0, Math.min(Number(line.qty_delivered) || 0, qtyOrdered));
  const qtyPending = Math.max(0, qtyOrdered - qtyDelivered);
  const productName = Array.isArray(line.product_id)
    ? String(line.product_id[1] || line.name || "")
    : String(line.name || "");

  return {
    id: line.id,
    product_id: line.product_id,
    name: line.name || productName,
    product_uom_qty: qtyOrdered,
    qty_ordered: qtyOrdered,
    qty_delivered: qtyDelivered,
    qty_pending: qtyPending,
    price_unit: line.price_unit,
    price_subtotal: line.price_subtotal,
  };
}

export function buildDeliveryBuckets(lines) {
  const productLines = (lines || []).filter(isProductDeliveryLine).map(mapDeliveryLine);

  const deliveringNow = productLines
    .filter((line) => line.qty_delivered > 0)
    .map((line) => ({
      id: line.id,
      product_id: line.product_id,
      name: line.name,
      qty: line.qty_delivered,
    }));

  const comingLater = productLines
    .filter((line) => line.qty_pending > 0)
    .map((line) => ({
      id: line.id,
      product_id: line.product_id,
      name: line.name,
      qty: line.qty_pending,
    }));

  return {
    productLines,
    delivering_now: deliveringNow,
    coming_later: comingLater,
    delivering_now_count: deliveringNow.length,
    coming_later_count: comingLater.length,
  };
}

export function attachDeliverySummary(order, lines, deliveries = []) {
  const buckets = buildDeliveryBuckets(lines);
  const deliveryList = Array.isArray(deliveries) ? deliveries : [];
  const deliveryStatus = resolveDeliveryStatus({
    state: order?.state,
    invoiceStatus: order?.invoice_status,
    productLines: buckets.productLines,
    deliveries: deliveryList,
  });

  const productPreview = buckets.productLines.slice(0, 5).map((line) => ({
    id: line.id,
    name: line.name,
    qty: line.qty_ordered,
  }));

  return {
    ...order,
    delivery_status: deliveryStatus,
    delivering_now_count: buckets.delivering_now_count,
    coming_later_count: buckets.coming_later_count,
    product_preview: productPreview,
    product_preview_count: buckets.productLines.length,
    delivery_count: deliveryList.length,
    deliveries: deliveryList,
  };
}

export const ORDER_LIST_FIELDS = [
  "id",
  "name",
  "state",
  "invoice_status",
  "amount_total",
  "date_order",
  "partner_id",
  "partner_shipping_id",
  "order_line",
  "picking_ids",
  "x_studio_preferred_delivery_date",
  "x_studio_delivery_notes",
];

export const ORDER_DETAIL_FIELDS = [
  ...ORDER_LIST_FIELDS,
  "note",
];

export const ORDER_LINE_FIELDS = [
  "id",
  "product_id",
  "name",
  "product_uom_qty",
  "qty_delivered",
  "price_unit",
  "price_subtotal",
  "is_reward_line",
  "display_type",
];
