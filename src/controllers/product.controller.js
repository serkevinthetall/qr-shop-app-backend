import { success, error } from "../utils/response.js";
import { odooCall } from "../services/odoo.service.js";

function getOdooBaseUrl() {
  return String(process.env.ODOO_URL || "").trim().replace(/\/$/, "");
}

function getImageUrl(productId) {
  return `/api/products/${productId}/image`;
}

function formatProduct(product) {
  return {
    id: product.id,
    name: product.name,
    list_price: product.list_price || 0,
    description_sale: product.description_sale || "",
    description: product.description || "",
    categ_id: product.categ_id || false,
    uom_id: product.uom_id || false,
    product_variant_id: product.product_variant_id || false,
    image_url: getImageUrl(product.id),
  };
}

function formatSimilarProduct(product) {
  return {
    id: product.id,
    name: product.name,
    list_price: product.list_price || 0,
    description_sale: product.description_sale || "",
    categ_id: product.categ_id || false,
    image_url: getImageUrl(product.id),
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
    res.setHeader("Cache-Control", "public, max-age=3600");

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

    const domain = [
      ["sale_ok", "=", true],
      ["website_published", "=", true],
    ];

    if (categoryId) {
      domain.push(["categ_id", "=", categoryId]);
    }

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: [
        "id",
        "name",
        "list_price",
        "description_sale",
        "description",
        "categ_id",
        "uom_id",
        "product_variant_id",
      ],
      limit,
      offset,
      order: "name asc",
    });

    return success(res, {
      products: products.map(formatProduct),
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
      domain: [["id", "=", id]],
      fields: [
        "id",
        "name",
        "list_price",
        "description_sale",
        "description",
        "categ_id",
        "uom_id",
        "product_variant_id",
      ],
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
        domain: [
          ["sale_ok", "=", true],
          ["website_published", "=", true],
          ["categ_id", "=", product.categ_id[0]],
          ["id", "!=", product.id],
        ],
        fields: [
          "id",
          "name",
          "list_price",
          "description_sale",
          "categ_id",
        ],
        limit: similarLimit,
        order: "name asc",
      });
    }

    return success(res, {
      product: formatProduct(product),
      similar_products: similarProducts.map(formatSimilarProduct),
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

    const domain = [
      ["sale_ok", "=", true],
      ["website_published", "=", true],
      ["name", "ilike", q],
    ];

    if (categoryId) {
      domain.push(["categ_id", "=", categoryId]);
    }

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: [
        "id",
        "name",
        "list_price",
        "description_sale",
        "description",
        "categ_id",
        "uom_id",
        "product_variant_id",
      ],
      limit: 30,
      order: "name asc",
    });

    return success(res, {
      products: products.map(formatProduct),
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
      domain: [
        ["sale_ok", "=", true],
        ["website_published", "=", true],
      ],
      fields: ["categ_id"],
      limit: 1000,
    });

    const categoryIds = [
      ...new Set(
        products
          .map((product) => product.categ_id?.[0])
          .filter((id) => typeof id === "number")
      ),
    ];

    if (!categoryIds.length) {
      return success(res, {
        categories: [],
        count: 0,
      });
    }

    const categories = await odooCall("product.category", "search_read", {
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