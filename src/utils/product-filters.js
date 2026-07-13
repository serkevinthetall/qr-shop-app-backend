export const APP_PRODUCT_TAG = "QR App";

export const APP_PRODUCT_LIST_FIELDS = [
  "id",
  "name",
  "list_price",
  "compare_list_price",
  "categ_id",
  "public_categ_ids",
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

const BLOCKED_RIBBON_SUBSTRINGS = ["sold out", "out of stock"];

export function getProductRibbonName(product) {
  const ribbon = product?.website_ribbon_id;

  if (!Array.isArray(ribbon) || !ribbon[1]) {
    return "";
  }

  return String(ribbon[1]).trim();
}

export function isBlockedRibbonName(name) {
  const normalized = String(name || "").trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return BLOCKED_RIBBON_SUBSTRINGS.some((blocked) => normalized.includes(blocked));
}

/** Any manual ribbon except Sold out / Out of stock (and empty). */
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

export function getNotifiableRibbonOdooDomain() {
  return [
    ["website_ribbon_id", "!=", false],
    ["website_ribbon_id.name", "not ilike", "sold out"],
    ["website_ribbon_id.name", "not ilike", "out of stock"],
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
