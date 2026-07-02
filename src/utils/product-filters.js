export const APP_PRODUCT_TAG = "app";

export const APP_PRODUCT_FIELDS = [
  "id",
  "name",
  "list_price",
  "description_sale",
  "description",
  "description_ecommerce",
  "website_description",
  "categ_id",
  "uom_id",
  "product_variant_id",
  "write_date",
  "website_ribbon_id",
];

export function getAppProductDomain(extra = []) {
  return [
    ["sale_ok", "=", true],
    ["website_published", "=", true],
    ["product_tag_ids.name", "=", APP_PRODUCT_TAG],
    ...extra,
  ];
}

export function isNewRibbonName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .includes("new");
}

export function isNewRibbonProduct(product) {
  const ribbon = product?.website_ribbon_id;

  if (!Array.isArray(ribbon) || !ribbon[1]) {
    return false;
  }

  return isNewRibbonName(ribbon[1]);
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
