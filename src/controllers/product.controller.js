import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import {
  APP_PRODUCT_FIELDS,
  APP_PRODUCT_LIST_FIELDS,
  APP_PRODUCT_ORDER,
  getAppProductDomain,
  getImageUrl,
  resolveAppProductOrder,
} from "../utils/product-filters.js";
import {
  attachProductTagNames,
  getPartnerTagNames,
  resolveProductTagIdsByNames,
} from "../utils/partner-tags.js";
import {
  resolveProductRibbonFast,
  resolveProductRibbons,
  resolveProductRibbonsForList,
} from "../utils/product-ribbon.js";
import {
  applyMembershipPricesToProducts,
  getMembershipProductPriceSnapshot,
} from "../utils/membership-pricelist.js";

let categoriesCache = null;
let categoriesCacheTime = 0;
const CATEGORIES_CACHE_TTL_MS = 5 * 60 * 1000;

function getOdooBaseUrl() {
  return String(process.env.ODOO_URL || "").trim().replace(/\/$/, "");
}

function wantsJustForYou(req) {
  const raw = String(req.query.just_for_you || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function applyJustForYouDomain(req, domain) {
  if (!wantsJustForYou(req)) {
    return { ok: true, domain };
  }

  const user = getAuthUser(req);

  if (!user) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  if (!user.partner_id) {
    return { ok: false, status: 400, message: "No partner linked to this user" };
  }

  const partnerTags = await getPartnerTagNames(user.partner_id);

  if (!partnerTags.length) {
    return { ok: true, domain: null, empty: true };
  }

  // Use tag IDs (not another .name leaf) so this AND the "QR App" gate both work.
  const productTagIds = await resolveProductTagIdsByNames(partnerTags);

  if (!productTagIds.length) {
    return { ok: true, domain: null, empty: true };
  }

  return {
    ok: true,
    domain: [...domain, ["product_tag_ids", "in", productTagIds]],
  };
}

function formatProduct(product, ribbon = null) {
  const writeDate = product.write_date || "";

  return {
    id: product.id,
    name: product.name,
    list_price: product.list_price || 0,
    description_sale: product.description_sale || "",
    description: product.description || "",
    description_ecommerce: product.description_ecommerce || "",
    website_description: product.website_description || "",
    categ_id: product.categ_id || false,
    public_categ_ids: Array.isArray(product.public_categ_ids)
      ? product.public_categ_ids
      : [],
    tags: Array.isArray(product.tags) ? product.tags : [],
    uom_id: product.uom_id || false,
    product_variant_id: product.product_variant_id || false,
    write_date: writeDate,
    image_url: getImageUrl(product.id, writeDate),
    ribbon,
  };
}

async function formatProducts(products, { fastRibbons = false, partnerId = null } = {}) {
  const [withTags, ribbons] = await Promise.all([
    attachProductTagNames(products),
    fastRibbons
      ? resolveProductRibbonsForList(odooCall, products)
      : resolveProductRibbons(odooCall, products),
  ]);

  const priced = await applyMembershipPricesToProducts(withTags, partnerId);

  return priced.map((product, index) => formatProduct(product, ribbons[index]));
}

function getRequestPartnerId(req) {
  const user = getAuthUser(req);
  return user?.partner_id || null;
}

function formatSimilarProduct(product) {
  const writeDate = product.write_date || "";

  return {
    id: product.id,
    name: product.name,
    list_price: product.list_price || 0,
    description_sale: product.description_sale || "",
    categ_id: product.categ_id || false,
    write_date: writeDate,
    image_url: getImageUrl(product.id, writeDate),
  };
}

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

export async function getProductImage(req, res) {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return error(res, "Invalid product ID", 400);
    }

    const products = await odooCall("product.template", "search_read", {
      domain: getAppProductDomain([["id", "=", id]]),
      fields: ["id", "write_date"],
      limit: 1,
    });

    if (!products.length) {
      return error(res, "Product image not found", 404);
    }

    const odooBaseUrl = getOdooBaseUrl();

    if (!odooBaseUrl) {
      return error(res, "ODOO_URL is not configured", 500);
    }

    const imageResponse = await fetch(
      `${odooBaseUrl}/web/image/product.template/${id}/image_1920`
    );

    if (!imageResponse.ok) {
      return error(res, "Product image not found", imageResponse.status);
    }

    const contentType =
      imageResponse.headers.get("content-type") || "image/jpeg";

    const buffer = Buffer.from(await imageResponse.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");

    return res.send(buffer);
  } catch (err) {
    return error(res, "Failed to load product image", 500, getOdooError(err));
  }
}

export async function getProducts(req, res) {
  try {
    const limit = Number(req.query.limit || 20);
    const offset = Number(req.query.offset || 0);
    const categoryId = Number(req.query.category_id || 0);
    const sort = String(req.query.sort || "").trim();
    const order = resolveAppProductOrder(sort);

    let domain = getAppProductDomain();

    if (categoryId) {
      domain.push(["public_categ_ids", "in", [categoryId]]);
    }

    const justForYou = await applyJustForYouDomain(req, domain);

    if (!justForYou.ok) {
      return error(res, justForYou.message, justForYou.status);
    }

    if (justForYou.empty) {
      return success(res, {
        products: [],
        limit,
        offset,
        count: 0,
        sort: sort || "default",
      });
    }

    domain = justForYou.domain;

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: APP_PRODUCT_LIST_FIELDS,
      limit,
      offset,
      order,
    });

    return success(res, {
      products: await formatProducts(products, {
        fastRibbons: true,
        partnerId: getRequestPartnerId(req),
      }),
      limit,
      offset,
      count: products.length,
      sort: sort || "default",
    });
  } catch (err) {
    return error(res, "Failed to get products", 500, getOdooError(err));
  }
}

export async function getProductById(req, res) {
  try {
    const id = Number(req.params.id);
    const similarLimit = Number(req.query.similar_limit || 8);

    if (!id) {
      return error(res, "Invalid product ID", 400);
    }

    const products = await odooCall("product.template", "search_read", {
      domain: getAppProductDomain([["id", "=", id]]),
      fields: APP_PRODUCT_FIELDS,
      limit: 1,
    });

    const product = products[0] || null;

    if (!product) {
      return success(res, {
        product: null,
        similar_products: [],
      });
    }

    let similarProducts = [];

    const similarPromise =
      product.categ_id && product.categ_id[0]
        ? odooCall("product.template", "search_read", {
            domain: getAppProductDomain([
              ["categ_id", "=", product.categ_id[0]],
              ["id", "!=", product.id],
            ]),
            fields: [
              "id",
              "name",
              "list_price",
              "description_sale",
              "categ_id",
              "write_date",
            ],
            limit: similarLimit,
            order: APP_PRODUCT_ORDER,
          })
        : Promise.resolve([]);

    const [ribbon, similarProductsResult, withTags] = await Promise.all([
      resolveProductRibbonFast(odooCall, product),
      similarPromise,
      attachProductTagNames([product]),
    ]);

    similarProducts = similarProductsResult;

    const partnerId = getRequestPartnerId(req);
    const [pricedMain] = await applyMembershipPricesToProducts(
      [withTags[0] || product],
      partnerId
    );
    const pricedSimilar = await applyMembershipPricesToProducts(
      similarProducts,
      partnerId
    );

    return success(res, {
      product: formatProduct(pricedMain || withTags[0] || product, ribbon),
      similar_products: pricedSimilar.map((similarProduct) =>
        formatSimilarProduct(similarProduct)
      ),
    });
  } catch (err) {
    return error(res, "Failed to get product", 500, getOdooError(err));
  }
}

export async function searchProducts(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const categoryId = Number(req.query.category_id || 0);
    const sort = String(req.query.sort || "").trim();
    const order = resolveAppProductOrder(sort);

    if (!q) {
      return error(res, "Search query is required", 400);
    }

    let domain = getAppProductDomain([["name", "ilike", q]]);

    if (categoryId) {
      domain.push(["public_categ_ids", "in", [categoryId]]);
    }

    const justForYou = await applyJustForYouDomain(req, domain);

    if (!justForYou.ok) {
      return error(res, justForYou.message, justForYou.status);
    }

    if (justForYou.empty) {
      return success(res, {
        products: [],
        count: 0,
        sort: sort || "default",
      });
    }

    domain = justForYou.domain;

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: APP_PRODUCT_LIST_FIELDS,
      limit: 30,
      order,
    });

    return success(res, {
      products: await formatProducts(products, {
        fastRibbons: true,
        partnerId: getRequestPartnerId(req),
      }),
      count: products.length,
      sort: sort || "default",
    });
  } catch (err) {
    return error(res, "Failed to search products", 500, getOdooError(err));
  }
}

const EXCLUDED_CATEGORY_NAMES = new Set([
  "Deliveries",
  "Expenses",
  "Goods",
  "Services",
]);

async function loadCategoriesFromOdoo() {
  // Prefer a cheap aggregation over scanning thousands of product rows.
  let categoryIds = [];

  try {
    const grouped = await odooCall("product.template", "read_group", {
      args: [getAppProductDomain(), ["public_categ_ids"], ["public_categ_ids"]],
      kwargs: { lazy: false },
    });

    categoryIds = [
      ...new Set(
        (grouped || [])
          .map((row) => {
            const value = row.public_categ_ids;
            if (Array.isArray(value)) return value[0];
            if (typeof value === "number") return value;
            return null;
          })
          .filter((id) => typeof id === "number" && id > 0)
      ),
    ];
  } catch (err) {
    console.log("CATEGORIES: read_group failed, falling back:", err.message);
  }

  if (!categoryIds.length) {
    const products = await odooCall("product.template", "search_read", {
      domain: getAppProductDomain(),
      fields: ["public_categ_ids"],
      limit: 800,
    });

    categoryIds = [
      ...new Set(products.flatMap((product) => product.public_categ_ids || [])),
    ];
  }

  if (!categoryIds.length) {
    return [];
  }

  const categories = await odooCall("product.public.category", "search_read", {
    domain: [["id", "in", categoryIds]],
    fields: ["id", "name", "parent_id"],
    order: "name asc",
    limit: 500,
  });

  const filtered = categories.filter(
    (category) => !EXCLUDED_CATEGORY_NAMES.has(category.name)
  );

  return filtered.sort((a, b) => {
    const aParent = Array.isArray(a.parent_id) ? a.parent_id[0] || 0 : 0;
    const bParent = Array.isArray(b.parent_id) ? b.parent_id[0] || 0 : 0;

    if (!aParent && bParent) return -1;
    if (aParent && !bParent) return 1;
    if (aParent !== bParent) return aParent - bParent;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

export async function getProductPrices(req, res) {
  try {
    const partnerId = getRequestPartnerId(req);
    const sinceVersion = String(req.query.version || "").trim();
    const snapshot = await getMembershipProductPriceSnapshot(
      partnerId,
      sinceVersion
    );

    return success(res, snapshot);
  } catch (err) {
    return error(res, "Failed to get product prices", 500, getOdooError(err));
  }
}

export async function getCategories(req, res) {
  try {
    if (
      categoriesCache &&
      Date.now() - categoriesCacheTime < CATEGORIES_CACHE_TTL_MS
    ) {
      return success(res, {
        categories: categoriesCache,
        count: categoriesCache.length,
        cached: true,
      });
    }

    const filteredCategories = await loadCategoriesFromOdoo();

    categoriesCache = filteredCategories;
    categoriesCacheTime = Date.now();

    return success(res, {
      categories: filteredCategories,
      count: filteredCategories.length,
    });
  } catch (err) {
    return error(res, "Failed to get categories", 500, getOdooError(err));
  }
}

