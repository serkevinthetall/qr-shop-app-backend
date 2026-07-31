import { odooCall } from "../services/odoo.service.js";

const PRICELIST_CACHE_TTL_MS = 5 * 60 * 1000;
const PRICELIST_ITEMS_CACHE_TTL_MS = 2 * 60 * 1000;

/** Map membership level labels to Odoo pricelist names. */
const MEMBERSHIP_PRICELIST_NAMES = {
  premium: "Premium Membership",
  pro: "Pro Membership",
};

let pricelistIdByName = null;
let pricelistCacheTime = 0;
const pricelistItemsCache = new Map();

function membershipLevelLabel(level) {
  if (Array.isArray(level)) {
    return String(level[1] || "").trim();
  }

  return String(level || "").trim();
}

function normalizeLevel(level) {
  return membershipLevelLabel(level).toLowerCase();
}

export function resolveMembershipTier(level) {
  const normalized = normalizeLevel(level);

  if (normalized.includes("premium")) {
    return "premium";
  }

  if (normalized.includes("pro")) {
    return "pro";
  }

  return "default";
}

function getVariantId(product) {
  const variant = product?.product_variant_id;

  if (Array.isArray(variant) && typeof variant[0] === "number") {
    return variant[0];
  }

  if (typeof variant === "number" && variant > 0) {
    return variant;
  }

  return null;
}

function getTemplateId(product) {
  if (typeof product?.id === "number" && product.id > 0) {
    return product.id;
  }

  return null;
}

function getCategoryId(product) {
  const categ = product?.categ_id;

  if (Array.isArray(categ) && typeof categ[0] === "number") {
    return categ[0];
  }

  if (typeof categ === "number" && categ > 0) {
    return categ;
  }

  return null;
}

function pickPricelistId(idsByName, targetName) {
  const wanted = String(targetName || "")
    .trim()
    .toLowerCase();

  if (!wanted) {
    return null;
  }

  if (idsByName.has(wanted)) {
    return idsByName.get(wanted);
  }

  for (const [name, id] of idsByName.entries()) {
    if (name.includes(wanted) || wanted.includes(name)) {
      return id;
    }
  }

  return null;
}

async function loadPricelistIdsByName() {
  const now = Date.now();

  if (pricelistIdByName && now - pricelistCacheTime < PRICELIST_CACHE_TTL_MS) {
    return pricelistIdByName;
  }

  const lists = await odooCall("product.pricelist", "search_read", {
    domain: [
      "|",
      ["name", "ilike", "Premium Membership"],
      ["name", "ilike", "Pro Membership"],
    ],
    fields: ["id", "name"],
    limit: 20,
  });

  const map = new Map();

  for (const list of lists || []) {
    map.set(String(list.name || "").trim().toLowerCase(), list.id);
  }

  pricelistIdByName = map;
  pricelistCacheTime = now;
  return map;
}

async function getActiveMembershipLevel(partnerId) {
  if (!partnerId) {
    return null;
  }

  const memberships = await odooCall("x_membership", "search_read", {
    domain: [
      ["x_studio_customer", "=", partnerId],
      ["x_studio_status", "=", "Active"],
    ],
    fields: ["id", "x_studio_membership_level", "x_studio_status"],
    order: "x_studio_start_date desc",
    limit: 1,
  });

  return memberships[0]?.x_studio_membership_level || null;
}

/**
 * Resolve the Odoo pricelist for a partner from active membership.
 * Premium → Premium Membership, Pro → Pro Membership.
 * Everyone else keeps the product's normal list_price (no Default pricelist).
 */
export async function resolvePricelistForPartner(partnerId) {
  if (!partnerId) {
    return {
      pricelistId: null,
      tier: "default",
      level: null,
      pricelistName: null,
    };
  }

  const [level, idsByName] = await Promise.all([
    getActiveMembershipLevel(partnerId),
    loadPricelistIdsByName(),
  ]);

  const tier = resolveMembershipTier(level);

  if (tier !== "premium" && tier !== "pro") {
    return {
      pricelistId: null,
      tier: "default",
      level: membershipLevelLabel(level) || null,
      pricelistName: null,
    };
  }

  const targetName = MEMBERSHIP_PRICELIST_NAMES[tier];
  const pricelistId = pickPricelistId(idsByName, targetName);

  return {
    pricelistId,
    tier,
    level: membershipLevelLabel(level) || null,
    pricelistName: targetName,
  };
}

function computePriceFromItem(item, listPrice) {
  const compute = String(item.compute_price || "");

  if (compute === "fixed") {
    const value = Number(item.fixed_price);
    return Number.isFinite(value) ? value : null;
  }

  const base = Number(listPrice) || 0;

  if (compute === "percentage") {
    const percent = Number(item.percent_price) || 0;
    return base * (1 - percent / 100);
  }

  // formula
  const discount = Number(item.price_discount) || 0;
  const surcharge = Number(item.price_surcharge) || 0;
  return base * (1 - discount / 100) + surcharge;
}

function itemSpecificity(item, product) {
  const variantId = getVariantId(product);
  const templateId = getTemplateId(product);
  const categoryId = getCategoryId(product);
  const appliedOn = String(item.applied_on || "");

  const itemProductId = Array.isArray(item.product_id)
    ? item.product_id[0]
    : item.product_id;
  const itemTemplateId = Array.isArray(item.product_tmpl_id)
    ? item.product_tmpl_id[0]
    : item.product_tmpl_id;
  const itemCategId = Array.isArray(item.categ_id)
    ? item.categ_id[0]
    : item.categ_id;

  if (
    (appliedOn === "0_product_variant" || itemProductId) &&
    variantId &&
    itemProductId === variantId
  ) {
    return 400;
  }

  if (
    (appliedOn === "1_product" || itemTemplateId) &&
    templateId &&
    itemTemplateId === templateId
  ) {
    return 300;
  }

  if (
    (appliedOn === "2_product_category" || itemCategId) &&
    categoryId &&
    itemCategId === categoryId
  ) {
    return 200;
  }

  if (appliedOn === "3_global") {
    return 100;
  }

  return 0;
}

function resolvePriceFromItems(items, product, quantity = 1) {
  let best = null;

  for (const item of items) {
    const minQty = Number(item.min_quantity) || 0;
    if (minQty > quantity) {
      continue;
    }

    const score = itemSpecificity(item, product);
    if (score <= 0) {
      continue;
    }

    const price = computePriceFromItem(item, product.list_price);
    if (price == null || !Number.isFinite(price)) {
      continue;
    }

    const candidate = {
      score,
      minQty,
      id: item.id || 0,
      price,
    };

    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.minQty > best.minQty) ||
      (candidate.score === best.score &&
        candidate.minQty === best.minQty &&
        candidate.id > best.id)
    ) {
      best = candidate;
    }
  }

  return best?.price ?? null;
}

async function loadPricelistItems(pricelistId, products) {
  const cacheKey = String(pricelistId);
  const cached = pricelistItemsCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.time < PRICELIST_ITEMS_CACHE_TTL_MS) {
    return cached.items;
  }

  const templateIds = [
    ...new Set(products.map(getTemplateId).filter((id) => typeof id === "number")),
  ];
  const variantIds = [
    ...new Set(products.map(getVariantId).filter((id) => typeof id === "number")),
  ];

  const domain = [
    ["pricelist_id", "=", pricelistId],
    "|",
    "|",
    "|",
    ["applied_on", "=", "3_global"],
    ["applied_on", "=", "2_product_category"],
    ["product_tmpl_id", "in", templateIds.length ? templateIds : [0]],
    ["product_id", "in", variantIds.length ? variantIds : [0]],
  ];

  const items = await odooCall("product.pricelist.item", "search_read", {
    domain,
    fields: [
      "id",
      "applied_on",
      "compute_price",
      "fixed_price",
      "percent_price",
      "price_discount",
      "price_surcharge",
      "product_tmpl_id",
      "product_id",
      "categ_id",
      "min_quantity",
      "base",
    ],
    limit: 5000,
  });

  pricelistItemsCache.set(cacheKey, { time: now, items: items || [] });
  return items || [];
}

/**
 * This Odoo build blocks private pricelist helpers over RPC and has no
 * product.product `price` field. Resolve from public pricelist items instead.
 */
export async function getPricelistPricesForProducts(pricelistId, products, _partnerId) {
  const prices = new Map();

  if (!pricelistId || !products?.length) {
    return prices;
  }

  try {
    const items = await loadPricelistItems(pricelistId, products);

    for (const product of products) {
      const price = resolvePriceFromItems(items, product, 1);
      if (price != null) {
        prices.set(product.id, price);
      }
    }

    if (prices.size) {
      return prices;
    }
  } catch (err) {
    console.log("PRICELIST item resolve failed:", err.message);
  }

  // Last resort: lst_price with pricelist context (works on some Odoo builds).
  try {
    const pairs = products
      .map((product) => ({
        templateId: product.id,
        variantId: getVariantId(product),
      }))
      .filter((pair) => pair.variantId);

    if (!pairs.length) {
      return prices;
    }

    const variantIds = [...new Set(pairs.map((pair) => pair.variantId))];
    const rows = await odooCall("product.product", "read", {
      args: [variantIds, ["id", "lst_price"]],
      kwargs: {
        context: {
          pricelist: pricelistId,
          partner: _partnerId || false,
        },
      },
    });

    const byVariant = new Map();
    for (const row of rows || []) {
      const value = Number(row.lst_price);
      if (Number.isFinite(value)) {
        byVariant.set(row.id, value);
      }
    }

    for (const { templateId, variantId } of pairs) {
      if (byVariant.has(variantId)) {
        prices.set(templateId, byVariant.get(variantId));
      }
    }
  } catch (err) {
    console.log("PRICELIST lst_price context failed:", err.message);
  }

  return prices;
}

export async function applyMembershipPricesToProducts(products, partnerId) {
  if (!products?.length) {
    return products;
  }

  const { pricelistId, tier, pricelistName } = await resolvePricelistForPartner(
    partnerId
  );

  if (!pricelistId) {
    console.log("PRICELIST unresolved", { partnerId, tier, pricelistName });
    return products;
  }

  const prices = await getPricelistPricesForProducts(
    pricelistId,
    products,
    partnerId
  );

  if (!prices.size) {
    return products;
  }

  return products.map((product) => {
    const nextPrice = prices.get(product.id);

    if (nextPrice == null) {
      return product;
    }

    return {
      ...product,
      list_price: nextPrice,
    };
  });
}
