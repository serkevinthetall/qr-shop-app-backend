import { odooCall } from "../services/odoo.service.js";

/** Odoo Studio model filled by the Yangon delivery-fee cron. */
export const DELIVERY_FEE_MODEL = "x_delivery_fee";
export const DELIVERY_FEE_TOWNSHIP = "x_studio_township";
export const DELIVERY_FEE_PRODUCT = "x_studio_delivery_product";
/** Related postal on x_delivery_fee (from township). */
export const DELIVERY_FEE_POSTAL = "x_studio_related_field_2e6_1k0hknmkg";
export const TOWNSHIP_MODEL = "x_townships";
export const TOWNSHIP_POSTAL = "x_studio_postal_code";

/**
 * Kill switch: set AUTO_DELIVERY_FEE_ENABLED=false on Vercel to disable
 * without reverting code. Default is on.
 */
export function isAutoDeliveryFeeEnabled() {
  const raw = String(process.env.AUTO_DELIVERY_FEE_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function normalizePostalCode(zip) {
  if (zip === undefined || zip === null || zip === false) {
    return "";
  }
  return String(zip).trim().replace(/\s+/g, "");
}

/** True if a cart line already looks like a Delivery fee product. */
export function cartAlreadyHasDeliveryProduct(resolvedVariants) {
  return (resolvedVariants || []).some(({ variant }) => {
    const raw = String(variant?.name || "").trim();
    const withoutCode = raw.replace(/^\[[^\]]*\]\s*/, "").trim().toLowerCase();
    return withoutCode === "delivery";
  });
}

async function findFeeRowByPostal(postal) {
  const rows = await odooCall(DELIVERY_FEE_MODEL, "search_read", {
    domain: [[DELIVERY_FEE_POSTAL, "=", postal]],
    fields: ["id", DELIVERY_FEE_PRODUCT, DELIVERY_FEE_POSTAL, DELIVERY_FEE_TOWNSHIP],
    limit: 1,
  });

  if (rows[0]) {
    return rows[0];
  }

  // Fallback if related postal is not searchable: township → fee row
  const townships = await odooCall(TOWNSHIP_MODEL, "search_read", {
    domain: [[TOWNSHIP_POSTAL, "=", postal]],
    fields: ["id"],
    limit: 1,
  });

  const townshipId = townships[0]?.id;
  if (!townshipId) {
    return null;
  }

  const byTownship = await odooCall(DELIVERY_FEE_MODEL, "search_read", {
    domain: [[DELIVERY_FEE_TOWNSHIP, "=", townshipId]],
    fields: ["id", DELIVERY_FEE_PRODUCT, DELIVERY_FEE_POSTAL, DELIVERY_FEE_TOWNSHIP],
    limit: 1,
  });

  return byTownship[0] || null;
}

function templateIdFromMany2one(value) {
  if (Array.isArray(value)) {
    return Number(value[0]) || null;
  }
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Resolve Delivery product.product for the selected branch postal code.
 * Returns null when zip is missing, unknown, or lookup fails (checkout continues).
 */
export async function resolveDeliveryFeeVariant(zip) {
  if (!isAutoDeliveryFeeEnabled()) {
    return null;
  }

  const postal = normalizePostalCode(zip);
  if (!postal) {
    return null;
  }

  try {
    const feeRow = await findFeeRowByPostal(postal);
    const templateId = templateIdFromMany2one(feeRow?.[DELIVERY_FEE_PRODUCT]);
    if (!templateId) {
      return null;
    }

    const products = await odooCall("product.product", "search_read", {
      domain: [["product_tmpl_id", "=", templateId]],
      fields: ["id", "name", "lst_price", "product_tmpl_id", "default_code"],
      limit: 1,
    });

    const variant = products[0];
    if (!variant?.id) {
      return null;
    }

    const templates = await odooCall("product.template", "search_read", {
      domain: [["id", "=", templateId]],
      fields: ["id", "list_price", "name"],
      limit: 1,
    });

    const listPrice =
      Number(templates[0]?.list_price) ||
      Number(variant.lst_price) ||
      0;

    return {
      productId: variant.id,
      templateId,
      name: variant.name || templates[0]?.name || "Delivery",
      listPrice,
      postal,
    };
  } catch (err) {
    // Never block checkout if Studio fields/model are unavailable.
    console.warn(
      "[delivery-fee] lookup failed; skipping auto fee:",
      err?.message || err
    );
    return null;
  }
}
