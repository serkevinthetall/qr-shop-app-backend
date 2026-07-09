import { success, error } from "../utils/response.js";
import { odooCall } from "../services/odoo.service.js";
import {
  APP_PRODUCT_FIELDS,
  getAppProductDomain,
  getImageUrl,
} from "../utils/product-filters.js";
import { resolveProductRibbons } from "../utils/product-ribbon.js";

function getOdooBaseUrl() {
  return String(process.env.ODOO_URL || "").trim().replace(/\/$/, "");
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
    uom_id: product.uom_id || false,
    product_variant_id: product.product_variant_id || false,
    write_date: writeDate,
    image_url: getImageUrl(product.id, writeDate),
    ribbon,
  };
}

async function formatProducts(products) {
  const ribbons = await resolveProductRibbons(odooCall, products);

  return products.map((product, index) => formatProduct(product, ribbons[index]));
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

    const domain = getAppProductDomain();

    if (categoryId) {
      domain.push(["public_categ_ids", "in", [categoryId]]);
    }

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: APP_PRODUCT_FIELDS,
      limit,
      offset,
      order: "name asc",
    });

    return success(res, {
      products: await formatProducts(products),
      limit,
      offset,
      count: products.length,
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

    if (product.categ_id && product.categ_id[0]) {
      similarProducts = await odooCall("product.template", "search_read", {
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
        order: "name asc",
      });
    }

    const [productWithRibbon] = await formatProducts([product]);

    return success(res, {
      product: productWithRibbon,
      similar_products: similarProducts.map((similarProduct) => formatSimilarProduct(similarProduct)),
    });
  } catch (err) {
    return error(res, "Failed to get product", 500, getOdooError(err));
  }
}

export async function searchProducts(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const categoryId = Number(req.query.category_id || 0);

    if (!q) {
      return error(res, "Search query is required", 400);
    }

    const domain = getAppProductDomain([["name", "ilike", q]]);

    if (categoryId) {
      domain.push(["public_categ_ids", "in", [categoryId]]);
    }

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: APP_PRODUCT_FIELDS,
      limit: 30,
      order: "name asc",
    });

    return success(res, {
      products: await formatProducts(products),
      count: products.length,
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

export async function getCategories(req, res) {
  try {
    const products = await odooCall("product.template", "search_read", {
      domain: getAppProductDomain(),
      fields: ["public_categ_ids"],
      limit: 1000,
    });

    const categoryIds = [
      ...new Set(products.flatMap((product) => product.public_categ_ids || [])),
    ];

    if (!categoryIds.length) {
      return success(res, {
        categories: [],
        count: 0,
      });
    }

    const categories = await odooCall("product.public.category", "search_read", {
      domain: [["id", "in", categoryIds]],
      fields: ["id", "name", "parent_id"],
      order: "name asc",
      limit: 200,
    });

    const filteredCategories = categories.filter(
      (category) => !EXCLUDED_CATEGORY_NAMES.has(category.name)
    );

    return success(res, {
      categories: filteredCategories,
      count: filteredCategories.length,
    });
  } catch (err) {
    return error(res, "Failed to get categories", 500, getOdooError(err));
  }
}
