import { APP_PRODUCT_TAG } from "./product-filters.js";
import { odooCall } from "../services/odoo.service.js";

export function normalizeTagName(name) {
  return String(name || "").trim();
}

/** Personalization tags exclude the app visibility gate tag. */
export function isPersonalizationTag(name) {
  const normalized = normalizeTagName(name);
  return normalized.length > 0 && normalized.toLowerCase() !== APP_PRODUCT_TAG.toLowerCase();
}

export function toPersonalizationTagNames(names) {
  const seen = new Set();
  const result = [];

  for (const name of names || []) {
    const normalized = normalizeTagName(name);

    if (!isPersonalizationTag(normalized)) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

export async function getPartnerTagNames(partnerId) {
  if (!partnerId) {
    return [];
  }

  const partners = await odooCall("res.partner", "search_read", {
    domain: [["id", "=", partnerId]],
    fields: ["id", "category_id"],
    limit: 1,
  });

  const categoryIds = Array.isArray(partners[0]?.category_id)
    ? partners[0].category_id.filter((id) => typeof id === "number" && id > 0)
    : [];

  if (!categoryIds.length) {
    return [];
  }

  const categories = await odooCall("res.partner.category", "search_read", {
    domain: [["id", "in", categoryIds]],
    fields: ["id", "name"],
    limit: 200,
  });

  return toPersonalizationTagNames(categories.map((category) => category.name));
}

export async function resolveProductTagNamesByIds(tagIds) {
  const uniqueIds = [
    ...new Set((tagIds || []).filter((id) => typeof id === "number" && id > 0)),
  ];

  if (!uniqueIds.length) {
    return new Map();
  }

  const tags = await odooCall("product.tag", "search_read", {
    domain: [["id", "in", uniqueIds]],
    fields: ["id", "name"],
    limit: uniqueIds.length,
  });

  return new Map(tags.map((tag) => [tag.id, normalizeTagName(tag.name)]));
}

/**
 * Resolve product.tag IDs by name (case-insensitive).
 * Prefer IDs in domains — do NOT add another product_tag_ids.name leaf next to
 * the existing "QR App" gate, or Odoo ANDs both name checks on the same join
 * and Just-for-you always returns empty.
 */
export async function resolveProductTagIdsByNames(names) {
  const wanted = toPersonalizationTagNames(names);

  if (!wanted.length) {
    return [];
  }

  // =ilike without % is case-insensitive equality in Odoo.
  const nameDomain =
    wanted.length === 1
      ? [["name", "=ilike", wanted[0]]]
      : [
          ...Array.from({ length: wanted.length - 1 }, () => "|"),
          ...wanted.map((name) => ["name", "=ilike", name]),
        ];

  const tags = await odooCall("product.tag", "search_read", {
    domain: nameDomain,
    fields: ["id", "name"],
    limit: wanted.length * 3,
  });

  const wantedSet = new Set(wanted.map((name) => name.toLowerCase()));

  return tags
    .filter((tag) => wantedSet.has(normalizeTagName(tag.name).toLowerCase()))
    .map((tag) => tag.id)
    .filter((id) => typeof id === "number" && id > 0);
}

export async function attachProductTagNames(products) {
  const allIds = products.flatMap((product) =>
    Array.isArray(product.product_tag_ids) ? product.product_tag_ids : []
  );
  const nameById = await resolveProductTagNamesByIds(allIds);

  return products.map((product) => {
    const ids = Array.isArray(product.product_tag_ids) ? product.product_tag_ids : [];
    const tags = toPersonalizationTagNames(ids.map((id) => nameById.get(id) || ""));

    return {
      ...product,
      tags,
    };
  });
}
