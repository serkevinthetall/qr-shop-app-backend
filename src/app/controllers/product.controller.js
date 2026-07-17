import { success, error } from "../../utils/response.js";
import { odooCall } from "../../services/odoo.service.js";
import {
  APP_PRODUCT_FIELDS,
  APP_PRODUCT_LIST_FIELDS,
  getAppProductDomain,
  getImageUrl,
} from "../../utils/product-filters.js";
import {
  resolveProductRibbonFast,
  resolveProductRibbonsForList,
} from "../../utils/product-ribbon.js";

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function formatProduct(product, ribbon = null) {
  const writeDate = product.write_date || "";

  return {
    id: product.id,
    name: product.name,
    list_price: product.list_price || 0,
    description_sale: product.description_sale || "",
    description: product.description || "",
    categ_id: product.categ_id || false,
    write_date: writeDate,
    image_url: getImageUrl(product.id, writeDate),
    ribbon,
  };
}

export async function getProducts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit || 40), 100);
    const offset = Number(req.query.offset || 0);
    const q = String(req.query.q || "").trim();

    const domain = getAppProductDomain();

    if (q) {
      domain.push(["name", "ilike", q]);
    }

    const products = await odooCall("product.template", "search_read", {
      domain,
      fields: APP_PRODUCT_LIST_FIELDS,
      limit,
      offset,
      order: "name asc",
    });

    const ribbons = await resolveProductRibbonsForList(odooCall, products);

    return success(res, {
      products: products.map((product, index) => formatProduct(product, ribbons[index])),
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

    if (!id) {
      return error(res, "Invalid product ID", 400);
    }

    const products = await odooCall("product.template", "search_read", {
      domain: getAppProductDomain([["id", "=", id]]),
      fields: APP_PRODUCT_FIELDS,
      limit: 1,
    });

    if (!products.length) {
      return error(res, "Product not found", 404);
    }

    const ribbon = await resolveProductRibbonFast(odooCall, products[0]);

    return success(res, {
      product: formatProduct(products[0], ribbon),
    });
  } catch (err) {
    return error(res, "Failed to get product", 500, getOdooError(err));
  }
}
