export const APP_PRODUCT_TAG = "QR App";

export const APP_PRODUCT_LIST_FIELDS = [
  "id",
  "name",
  "list_price",
  "compare_list_price",
  "categ_id",
  "public_categ_ids",
  "product_tag_ids",
  "product_variant_id",
  "write_date",
  "website_ribbon_id",
  "allow_out_of_stock_order",
  "publish_date",
];

export const APP_PRODUCT_FIELDS = [
  ...APP_PRODUCT_LIST_FIELDS,
  "description_sale",
  "description",
  "description_ecommerce",
  "website_description",
  "uom_id",
];

export function getAppProductDomain(extra = []) {
  return [
    ["sale_ok", "=", true],
    ["website_published", "=", true],
    ["product_tag_ids.name", "=", APP_PRODUCT_TAG],
    ...extra,
  ];
}

// Push + notification list: any website ribbon notifies, EXCEPT these.
// Empty ribbon also does not notify.
const BLOCKED_RIBBON_SUBSTRINGS = [
  "sold out",
  "soldout",
  "out of stock",
  "outofstock",
  "out-of-stock",
];

export function getProductRibbonName(product) {
  const ribbon = product?.website_ribbon_id;

  if (!Array.isArray(ribbon) || !ribbon[1]) {
    return "";
  }

  return String(ribbon[1]).trim();
}

export function isBlockedRibbonName(name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) {
    return true;
  }

  return BLOCKED_RIBBON_SUBSTRINGS.some((blocked) => {
    const needle = blocked.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    return normalized.includes(needle) || normalized.replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""));
  });
}

/** Any ribbon except empty / Sold out / Out of stock. */
export function isNotifiableRibbonProduct(product) {
  const ribbonName = getProductRibbonName(product);
  return ribbonName.length > 0 && !isBlockedRibbonName(ribbonName);
}

export function isNewRibbonName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .includes("new");
}

export function isNewRibbonProduct(product) {
  return isNotifiableRibbonProduct(product) && isNewRibbonName(getProductRibbonName(product));
}

/** Odoo domain mirror of isNotifiableRibbonProduct (for list queries). */
export function getNotifiableRibbonOdooDomain() {
  return [
    ["website_ribbon_id", "!=", false],
    ["website_ribbon_id.name", "not ilike", "sold out"],
    ["website_ribbon_id.name", "not ilike", "soldout"],
    ["website_ribbon_id.name", "not ilike", "out of stock"],
    ["website_ribbon_id.name", "not ilike", "outofstock"],
  ];
}

export function getImageVersion(writeDate) {
  if (!writeDate) {
    return "0";
  }

  return encodeURIComponent(String(writeDate).replace(/[^0-9]/g, "") || "0");
}

export function getImageUrl(productId, writeDate) {
  return `/api/products/${productId}/image?v=${getImageVersion(writeDate)}`;
}
