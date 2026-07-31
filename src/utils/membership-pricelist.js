import { odooCall } from "../services/odoo.service.js";

const PRICELIST_CACHE_TTL_MS = 5 * 60 * 1000;

/** Map membership level labels to Odoo pricelist names. */
const MEMBERSHIP_PRICELIST_NAMES = {
  premium: "Premium Membership",
  pro: "Pro Membership",
};

let pricelistIdByName = null;
let pricelistCacheTime = 0;

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
      "|",
      ["name", "ilike", "Premium Membership"],
      ["name", "ilike", "Pro Membership"],
      ["name", "ilike", "Default"],
    ],
    fields: ["id", "name"],
    limit: 50,
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
 * Premium → Premium Membership, Pro → Pro Membership, else Default.
 * Guests (no partner) also get Default so catalog prices are not stuck at list_price 0.
 */
export async function resolvePricelistForPartner(partnerId) {
  const idsByName = await loadPricelistIdsByName();

  if (!partnerId) {
    return {
      pricelistId: pickPricelistId(idsByName, "Default"),
      tier: "default",
      level: null,
      pricelistName: "Default",
    };
  }

  const [level, partners] = await Promise.all([
    getActiveMembershipLevel(partnerId),
    odooCall("res.partner", "search_read", {
      domain: [["id", "=", partnerId]],
      fields: ["id", "property_product_pricelist"],
      limit: 1,
    }),
  ]);

  const tier = resolveMembershipTier(level);
  const targetName =
    tier === "premium" || tier === "pro"
      ? MEMBERSHIP_PRICELIST_NAMES[tier]
      : "Default";

  let pricelistId = pickPricelistId(idsByName, targetName);

  const partnerPricelist = partners[0]?.property_product_pricelist;
  const partnerPricelistId = Array.isArray(partnerPricelist)
    ? partnerPricelist[0]
    : typeof partnerPricelist === "number"
      ? partnerPricelist
      : null;

  if (!pricelistId && partnerPricelistId) {
    pricelistId = partnerPricelistId;
  }

  if (!pricelistId) {
    pricelistId = pickPricelistId(idsByName, "Default");
  }

  return {
    pricelistId,
    tier,
    level: membershipLevelLabel(level) || null,
    pricelistName: targetName,
  };
}

/**
 * Preferred path: product.product `price` with pricelist in context.
 * Works across Odoo 14–18 without relying on shifting method signatures.
 */
async function getPricesViaProductContext(pricelistId, products, partnerId) {
  const prices = new Map();
  const pairs = [];

  for (const product of products) {
    const variantId = getVariantId(product);
    if (variantId) {
      pairs.push({ templateId: product.id, variantId });
    }
  }

  if (!pairs.length) {
    return prices;
  }

  const variantIds = [...new Set(pairs.map((pair) => pair.variantId))];
  const rows = await odooCall("product.product", "read", {
    args: [variantIds, ["id", "price", "lst_price"]],
    kwargs: {
      context: {
        pricelist: pricelistId,
        partner: partnerId || false,
      },
    },
  });

  const byVariant = new Map();

  for (const row of rows || []) {
    const value = Number(row.price);
    if (Number.isFinite(value)) {
      byVariant.set(row.id, value);
      continue;
    }

    const fallback = Number(row.lst_price);
    if (Number.isFinite(fallback)) {
      byVariant.set(row.id, fallback);
    }
  }

  for (const { templateId, variantId } of pairs) {
    if (byVariant.has(variantId)) {
      prices.set(templateId, byVariant.get(variantId));
    }
  }

  return prices;
}

async function getPricesViaComputePriceRule(pricelistId, products) {
  const prices = new Map();
  const pairs = [];

  for (const product of products) {
    const variantId = getVariantId(product);
    if (variantId) {
      pairs.push({ templateId: product.id, variantId });
    }
  }

  if (!pairs.length) {
    return prices;
  }

  const variantIds = [...new Set(pairs.map((pair) => pair.variantId))];

  // Odoo 16+: (products, quantity, currency=None, ...)
  // Older: (products, qty, partner, ...) — quantity=1.0 is safe either way.
  const result = await odooCall("product.pricelist", "_compute_price_rule", {
    args: [[pricelistId], variantIds, 1.0],
  });

  if (!result || typeof result !== "object") {
    return prices;
  }

  for (const { templateId, variantId } of pairs) {
    const entry = result[variantId] ?? result[String(variantId)];
    const value = Array.isArray(entry) ? Number(entry[0]) : Number(entry);

    if (Number.isFinite(value)) {
      prices.set(templateId, value);
    }
  }

  return prices;
}

async function getSingleProductPrice(pricelistId, productId) {
  // Do not pass partner as a 4th positional arg — on Odoo 16+ that becomes `currency`.
  const attempts = [
    {
      method: "_get_product_price",
      params: { args: [[pricelistId], productId, 1.0] },
    },
    {
      method: "get_product_price",
      params: { args: [[pricelistId], productId, 1.0] },
    },
  ];

  for (const attempt of attempts) {
    try {
      const price = await odooCall("product.pricelist", attempt.method, attempt.params);
      const value = Number(price);
      if (Number.isFinite(value)) {
        return value;
      }
    } catch {
      // try next shape
    }
  }

  return null;
}

/**
 * Return Map<templateId, price> using the given pricelist.
 */
export async function getPricelistPricesForProducts(pricelistId, products, partnerId) {
  if (!pricelistId || !products?.length) {
    return new Map();
  }

  try {
    const viaContext = await getPricesViaProductContext(
      pricelistId,
      products,
      partnerId
    );
    if (viaContext.size) {
      return viaContext;
    }
  } catch (err) {
    console.log("PRICELIST context price failed:", err.message);
  }

  try {
    const viaRule = await getPricesViaComputePriceRule(pricelistId, products);
    if (viaRule.size) {
      return viaRule;
    }
  } catch (err) {
    console.log("PRICELIST _compute_price_rule failed:", err.message);
  }

  const prices = new Map();

  await Promise.all(
    products.map(async (product) => {
      const variantId = getVariantId(product);
      if (!variantId) {
        return;
      }

      const price = await getSingleProductPrice(pricelistId, variantId);
      if (price != null) {
        prices.set(product.id, price);
      }
    })
  );

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
    console.log("PRICELIST prices empty", {
      partnerId,
      pricelistId,
      tier,
      pricelistName,
      productCount: products.length,
    });
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
