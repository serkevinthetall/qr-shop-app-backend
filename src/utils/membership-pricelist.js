import { odooCall } from "../services/odoo.service.js";

const PRICELIST_CACHE_TTL_MS = 5 * 60 * 1000;

/** Map membership level labels to Odoo pricelist names. */
const MEMBERSHIP_PRICELIST_NAMES = {
  premium: "Premium Membership",
  pro: "Pro Membership",
};

let pricelistIdByName = null;
let pricelistCacheTime = 0;

function normalizeLevel(level) {
  return String(level || "")
    .trim()
    .toLowerCase();
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

async function loadPricelistIdsByName() {
  const now = Date.now();

  if (pricelistIdByName && now - pricelistCacheTime < PRICELIST_CACHE_TTL_MS) {
    return pricelistIdByName;
  }

  const wantedNames = [
    ...Object.values(MEMBERSHIP_PRICELIST_NAMES),
    "Default",
  ];

  const lists = await odooCall("product.pricelist", "search_read", {
    domain: [["name", "in", wantedNames]],
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
 * Premium → Premium Membership, Pro → Pro Membership, else Default (or null).
 */
export async function resolvePricelistForPartner(partnerId) {
  if (!partnerId) {
    return { pricelistId: null, tier: "default", level: null };
  }

  const [level, idsByName, partners] = await Promise.all([
    getActiveMembershipLevel(partnerId),
    loadPricelistIdsByName(),
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

  let pricelistId = idsByName.get(targetName.toLowerCase()) || null;

  // Prefer partner-assigned pricelist when it matches membership, otherwise
  // fall back to the membership-mapped list, then partner property, then Default.
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
    pricelistId = idsByName.get("default") || null;
  }

  return {
    pricelistId,
    tier,
    level,
    pricelistName: targetName,
  };
}

async function getSingleProductPrice(pricelistId, productId, partnerId) {
  try {
    const price = await odooCall("product.pricelist", "get_product_price", {
      args: [[pricelistId], productId, 1.0, partnerId || false],
    });
    const value = Number(price);
    return Number.isFinite(value) ? value : null;
  } catch {
    try {
      const price = await odooCall("product.pricelist", "_get_product_price", {
        args: [[pricelistId], productId, 1.0],
        kwargs: partnerId ? { partner: partnerId } : {},
      });
      const value = Number(price);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
}

/**
 * Return Map<templateId, price> using the given pricelist.
 */
export async function getPricelistPricesForProducts(pricelistId, products, partnerId) {
  const prices = new Map();

  if (!pricelistId || !products?.length) {
    return prices;
  }

  const variantIds = products
    .map((product) => getVariantId(product))
    .filter((id) => typeof id === "number" && id > 0);

  // Prefer one batch call when available.
  if (variantIds.length) {
    try {
      const quantities = variantIds.map(() => 1.0);
      const batch = await odooCall("product.pricelist", "_get_products_price", {
        args: [[pricelistId], variantIds, quantities, partnerId || false],
      });

      if (batch && typeof batch === "object" && !Array.isArray(batch)) {
        for (const product of products) {
          const variantId = getVariantId(product);
          const value = Number(batch[variantId] ?? batch[String(variantId)]);
          if (Number.isFinite(value)) {
            prices.set(product.id, value);
          }
        }

        if (prices.size) {
          return prices;
        }
      }
    } catch (err) {
      console.log("PRICELIST batch failed, falling back:", err.message);
    }
  }

  await Promise.all(
    products.map(async (product) => {
      const variantId = getVariantId(product) || product.id;
      const price = await getSingleProductPrice(pricelistId, variantId, partnerId);

      if (price != null) {
        prices.set(product.id, price);
      }
    })
  );

  return prices;
}

export async function applyMembershipPricesToProducts(products, partnerId) {
  if (!partnerId || !products?.length) {
    return products;
  }

  const { pricelistId } = await resolvePricelistForPartner(partnerId);

  if (!pricelistId) {
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
