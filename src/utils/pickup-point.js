import { odooCall } from "../services/odoo.service.js";
import { normalizePartnerId } from "./partner-id.js";

export const PICKUP_POINT_MODEL = "x_pickup_point";

/** Sale order Studio fields (optional — never required). */
export const SO_FULFILLMENT_FIELD = "x_studio_fulfillment";
export const SO_PICKUP_POINT_FIELD = "x_studio_pickup_point";

const PICKUP_POINT_FIELDS = [
  "id",
  "x_name",
  "x_studio_address",
  "x_studio_township",
  "x_studio_sequence_1",
  "x_active",
];

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function normalizeFulfillmentMethod(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();

  if (value === "pickup" || value === "self_pickup" || value === "self-pickup") {
    return "pickup";
  }

  if (value === "delivery" || value === "") {
    return "delivery";
  }

  return null;
}

export function formatPickupPointAddress(point) {
  if (!point) return "";

  return firstNonEmpty(
    point.x_studio_address,
    point.address,
    [point.x_studio_township, point.township].filter(Boolean).join(", ")
  );
}

export function formatPickupPointName(point) {
  if (!point) return "";
  return firstNonEmpty(point.x_name, point.name, point.display_name);
}

export function buildPickupNote(point) {
  const name = formatPickupPointName(point) || "pickup point";
  const address = formatPickupPointAddress(point);
  const where = address ? `${name} (${address})` : name;

  return [
    `လာယူမည် — ဖောက်သည်သည် ဤအော်ဒါကို ${where} တွင် လာယူမည်။`,
    `Self pickup — Customer will collect this order at ${where}.`,
  ].join("\n");
}

export function serializePickupPoint(point) {
  if (!point?.id) return null;

  const name = formatPickupPointName(point);
  const address = formatPickupPointAddress(point);
  const township = firstNonEmpty(point.x_studio_township, point.township);

  return {
    id: Number(point.id),
    name,
    address,
    township: township || null,
    sequence: Number(point.x_studio_sequence_1) || 0,
  };
}

export async function listActivePickupPoints() {
  const rows = await odooCall(PICKUP_POINT_MODEL, "search_read", {
    domain: [["x_active", "=", true]],
    fields: PICKUP_POINT_FIELDS,
    order: "x_studio_sequence_1 asc, x_name asc",
    limit: 100,
  });

  return (rows || [])
    .map(serializePickupPoint)
    .filter((point) => point && point.name);
}

export async function getActivePickupPointById(pickupPointId) {
  const id = normalizePartnerId(pickupPointId);

  if (!id) return null;

  const rows = await odooCall(PICKUP_POINT_MODEL, "search_read", {
    domain: [
      ["id", "=", id],
      ["x_active", "=", true],
    ],
    fields: PICKUP_POINT_FIELDS,
    limit: 1,
  });

  return rows?.[0] ? serializePickupPoint(rows[0]) : null;
}

/**
 * Load raw Odoo pickup point records by id for order enrichment.
 * Missing / inactive ids are skipped (never throws for empty list).
 */
export async function readPickupPointsByIds(ids) {
  const uniqueIds = [
    ...new Set(
      (ids || [])
        .map((id) => normalizePartnerId(id))
        .filter((id) => typeof id === "number" && id > 0)
    ),
  ];

  if (!uniqueIds.length) {
    return new Map();
  }

  try {
    const rows = await odooCall(PICKUP_POINT_MODEL, "search_read", {
      domain: [["id", "in", uniqueIds]],
      fields: PICKUP_POINT_FIELDS,
      limit: uniqueIds.length,
    });

    const map = new Map();
    for (const row of rows || []) {
      const serialized = serializePickupPoint(row);
      if (serialized) {
        map.set(serialized.id, serialized);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export function parsePickupPointIdFromOrder(order) {
  const raw = order?.[SO_PICKUP_POINT_FIELD];
  if (Array.isArray(raw) && raw[0]) {
    return normalizePartnerId(raw[0]);
  }
  return normalizePartnerId(raw);
}

export function parseFulfillmentFromOrder(order) {
  return normalizeFulfillmentMethod(order?.[SO_FULFILLMENT_FIELD]) || "delivery";
}
