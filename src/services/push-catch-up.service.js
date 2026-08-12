import {
  buildCouponPushMessages,
  buildProductPushMessages,
  sendExpoPushMessages,
  summarizeExpoPushTickets,
} from "./expo-push.service.js";
import { odooCall } from "./odoo.service.js";
import {
  getAppProductDomain,
  getNotifiableRibbonOdooDomain,
  getProductRibbonName,
  isNotifiableRibbonProduct,
} from "../utils/product-filters.js";

const CATCH_UP_WINDOW_MS = Number(process.env.PUSH_CATCH_UP_WINDOW_MS || 2 * 60 * 60 * 1000);
const CATCH_UP_PRODUCT_LIMIT = Number(process.env.PUSH_CATCH_UP_PRODUCT_LIMIT || 5);
const CATCH_UP_COUPON_LIMIT = Number(process.env.PUSH_CATCH_UP_COUPON_LIMIT || 3);

function toOdooDatetime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * After a device first registers its Expo token, send recent missed
 * product/coupon alerts to that device only (not every device for the partner).
 */
export async function sendCatchUpPushesForToken({
  partnerId,
  expoPushToken,
  language,
}) {
  const entry = {
    to: expoPushToken,
    language,
    partner_id: partnerId,
  };

  const since = toOdooDatetime(new Date(Date.now() - CATCH_UP_WINDOW_MS));
  let sent = 0;
  const errors = [];

  try {
    const products = await odooCall("product.template", "search_read", {
      domain: [
        ...getAppProductDomain(),
        ...getNotifiableRibbonOdooDomain(),
        ["write_date", ">=", since],
      ],
      fields: ["id", "name", "write_date", "website_ribbon_id"],
      order: "write_date desc",
      limit: CATCH_UP_PRODUCT_LIMIT,
    });

    for (const product of products) {
      if (!isNotifiableRibbonProduct(product)) {
        continue;
      }

      const result = await sendExpoPushMessages(
        buildProductPushMessages([entry], {
          id: product.id,
          name: product.name || "this product",
          ribbon_name: getProductRibbonName(product),
        })
      );

      const summary = summarizeExpoPushTickets(result.data);
      sent += summary.ok;
      errors.push(...summary.errors);
    }
  } catch (err) {
    console.warn("Catch-up product pushes failed:", err.message);
    errors.push(err.message);
  }

  try {
    const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
      domain: [
        ["x_studio_customer", "=", partnerId],
        ["create_date", ">=", since],
      ],
      fields: ["id", "x_studio_coupon_code", "create_date"],
      order: "create_date desc",
      limit: CATCH_UP_COUPON_LIMIT,
    });

    for (const coupon of coupons) {
      const result = await sendExpoPushMessages(
        buildCouponPushMessages([entry], {
          code: coupon.x_studio_coupon_code || "",
        })
      );

      const summary = summarizeExpoPushTickets(result.data);
      sent += summary.ok;
      errors.push(...summary.errors);
    }
  } catch (err) {
    console.warn("Catch-up coupon pushes failed:", err.message);
    errors.push(err.message);
  }

  return { sent, errors };
}
