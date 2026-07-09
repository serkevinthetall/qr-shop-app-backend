const RIBBON_FIELDS = [
  "id",
  "name",
  "bg_color",
  "text_color",
  "position",
  "style",
  "assign",
  "new_period",
];

let autoRibbonsCache = null;
let autoRibbonsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function formatRibbonRecord(ribbon) {
  if (!ribbon?.id) {
    return null;
  }

  return {
    name: ribbon.name,
    bg_color: ribbon.bg_color,
    text_color: ribbon.text_color,
    position: ribbon.position || "left",
    style: ribbon.style || "ribbon",
  };
}

function normalizeRibbonId(result) {
  if (!result) {
    return null;
  }

  if (Array.isArray(result)) {
    if (!result.length) {
      return null;
    }

    return typeof result[0] === "number" ? result[0] : null;
  }

  if (typeof result === "number") {
    return result;
  }

  if (typeof result === "object" && result.id) {
    return result.id;
  }

  return null;
}

function getMany2oneId(value) {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  if (typeof value === "number") {
    return value;
  }

  return null;
}

function buildFallbackPriceVals(product) {
  const listPrice = Number(product.list_price || 0);
  const comparePrice = Number(product.compare_list_price || 0);
  const priceVals = { price_reduce: listPrice };

  if (comparePrice > listPrice) {
    priceVals.base_price = comparePrice;
  }

  return priceVals;
}

function daysSinceOdooDatetime(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(String(value).replace(" ", "T") + "Z");

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const diffMs = Date.now() - parsed.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function isSoldOut(variant, template) {
  if (!variant?.is_storable || template?.allow_out_of_stock_order) {
    return false;
  }

  const qty = Number(variant.free_qty ?? variant.qty_available ?? 0);
  return qty <= 0;
}

function isRibbonApplicable(ribbon, variant, template, priceVals) {
  if (!ribbon || ribbon.assign === "manual") {
    return false;
  }

  if (ribbon.assign === "sale" && priceVals) {
    if (
      ("base_price" in priceVals &&
        Number(priceVals.base_price) > Number(priceVals.price_reduce)) ||
      ("compare_list_price" in priceVals &&
        Number(priceVals.compare_list_price) > Number(priceVals.price)) ||
      priceVals.has_discounted_price
    ) {
      return true;
    }
  }

  if (ribbon.assign === "new") {
    const publishDate = variant?.publish_date || template?.publish_date;
    const days = daysSinceOdooDatetime(publishDate);

    if (days !== null && Number(ribbon.new_period || 0) >= days) {
      return true;
    }
  }

  if (ribbon.assign === "out_of_stock" && isSoldOut(variant, template)) {
    return true;
  }

  return false;
}

async function readRibbonsByIds(odooCall, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];

  if (!uniqueIds.length) {
    return new Map();
  }

  const ribbons = await odooCall("product.ribbon", "search_read", {
    domain: [["id", "in", uniqueIds]],
    fields: RIBBON_FIELDS,
    limit: uniqueIds.length,
  });

  return new Map(ribbons.map((ribbon) => [ribbon.id, ribbon]));
}

async function getAutoAssignRibbons(odooCall) {
  if (autoRibbonsCache && Date.now() - autoRibbonsCacheTime < CACHE_TTL_MS) {
    return autoRibbonsCache;
  }

  autoRibbonsCache = await odooCall("product.ribbon", "search_read", {
    domain: [["assign", "!=", "manual"]],
    fields: RIBBON_FIELDS,
    order: "sequence asc, id asc",
    limit: 50,
  });
  autoRibbonsCacheTime = Date.now();

  return autoRibbonsCache;
}

async function loadVariantMap(odooCall, products) {
  const variantIds = [
    ...new Set(
      products
        .map((product) => getMany2oneId(product.product_variant_id))
        .filter(Boolean)
    ),
  ];

  if (!variantIds.length) {
    return new Map();
  }

  const variants = await odooCall("product.product", "search_read", {
    domain: [["id", "in", variantIds]],
    fields: [
      "id",
      "variant_ribbon_id",
      "qty_available",
      "free_qty",
      "is_storable",
      "publish_date",
    ],
    limit: variantIds.length,
  });

  return new Map(variants.map((variant) => [variant.id, variant]));
}

function resolveRibbonLocally(product, variant, autoRibbons, ribbonMap, priceVals) {
  const manualRibbonId =
    getMany2oneId(variant?.variant_ribbon_id) ||
    getMany2oneId(product.website_ribbon_id);

  if (manualRibbonId) {
    return formatRibbonRecord(ribbonMap.get(manualRibbonId));
  }

  for (const ribbon of autoRibbons) {
    if (isRibbonApplicable(ribbon, variant, product, priceVals)) {
      return formatRibbonRecord(ribbon);
    }
  }

  return null;
}

async function resolveRibbonsViaOdoo(odooCall, products, priceValsMap) {
  let rpcFailed = false;

  const ribbonIds = await Promise.all(
    products.map(async (product) => {
      try {
        const result = await odooCall("product.template", "_get_ribbon", {
          args: [[product.id]],
          kwargs: {
            price_vals: priceValsMap[product.id] || {},
          },
        });

        return normalizeRibbonId(result);
      } catch (err) {
        console.log(
          `RIBBON: _get_ribbon failed for product ${product.id}:`,
          err.message
        );
        rpcFailed = true;
        return undefined;
      }
    })
  );

  if (rpcFailed) {
    return null;
  }

  const ribbonMap = await readRibbonsByIds(odooCall, ribbonIds);

  return ribbonIds.map((ribbonId) =>
    formatRibbonRecord(ribbonId ? ribbonMap.get(ribbonId) : null)
  );
}

async function buildPriceValsMap(odooCall, products) {
  const websiteId = Number(process.env.ODOO_WEBSITE_ID || 1);
  const templateIds = products.map((product) => product.id);

  try {
    const priceValsMap = await odooCall("product.template", "_get_sales_prices", {
      args: [templateIds, websiteId],
    });

    if (priceValsMap && typeof priceValsMap === "object") {
      return priceValsMap;
    }
  } catch (err) {
    console.log("RIBBON: _get_sales_prices failed:", err.message);
  }

  return Object.fromEntries(
    products.map((product) => [product.id, buildFallbackPriceVals(product)])
  );
}

export async function resolveProductRibbonFast(odooCall, product) {
  const manualRibbonId = getMany2oneId(product.website_ribbon_id);

  if (manualRibbonId) {
    const ribbonMap = await readRibbonsByIds(odooCall, [manualRibbonId]);
    const ribbon = formatRibbonRecord(ribbonMap.get(manualRibbonId));

    if (ribbon) {
      return ribbon;
    }
  }

  const [ribbon] = await resolveProductRibbons(odooCall, [product]);
  return ribbon || null;
}

export async function resolveProductRibbons(odooCall, products) {
  if (!products.length) {
    return [];
  }

  const priceValsMap = await buildPriceValsMap(odooCall, products);
  const odooRibbons = await resolveRibbonsViaOdoo(
    odooCall,
    products,
    priceValsMap
  );

  if (odooRibbons) {
    return odooRibbons;
  }

  const [autoRibbons, variantMap] = await Promise.all([
    getAutoAssignRibbons(odooCall),
    loadVariantMap(odooCall, products),
  ]);

  const manualRibbonIds = products.flatMap((product) => {
    const variant = variantMap.get(getMany2oneId(product.product_variant_id));
    return [
      getMany2oneId(variant?.variant_ribbon_id),
      getMany2oneId(product.website_ribbon_id),
    ];
  });

  const ribbonMap = await readRibbonsByIds(odooCall, [
    ...manualRibbonIds,
    ...autoRibbons.map((ribbon) => ribbon.id),
  ]);

  return products.map((product) => {
    const variant = variantMap.get(getMany2oneId(product.product_variant_id));
    return resolveRibbonLocally(
      product,
      variant,
      autoRibbons,
      ribbonMap,
      priceValsMap[product.id] || buildFallbackPriceVals(product)
    );
  });
}
