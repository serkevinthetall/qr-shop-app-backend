import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import {
  buildCouponPushMessages,
  buildProductPushMessages,
  sendExpoPushMessages,
} from "../services/expo-push.service.js";
import { getPushCopy } from "../utils/push-i18n.js";
import {
  getAllPushTokenEntries,
  getPushTokenEntriesForPartner,
  removePushToken,
  upsertPushToken,
} from "../services/push-token.store.js";
import {
  getAppProductDomain,
  isNewRibbonProduct,
} from "../utils/product-filters.js";

const NEW_PRODUCT_LIMIT = 20;
const NEW_COUPON_LIMIT = 20;

// Local timezone offset used to decide what "today" means. Odoo stores
// create_date in UTC; Myanmar is UTC+6:30 (390 minutes) with no DST.
const LOCAL_TZ_OFFSET_MINUTES = Number(process.env.NOTIFY_TZ_OFFSET_MINUTES || 390);

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

// Odoo returns datetimes as "YYYY-MM-DD HH:MM:SS" (UTC). They are zero-padded,
// so a plain string comparison is enough for chronological sorting.
function compareByDateDesc(a, b) {
  return String(b.date || "").localeCompare(String(a.date || ""));
}

function toOdooDatetime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// Returns the start of "today" (in the configured local timezone) expressed as
// a UTC Odoo datetime string, so we can query products created since midnight.
function getStartOfTodayUtc() {
  const offsetMs = LOCAL_TZ_OFFSET_MINUTES * 60000;
  const local = new Date(Date.now() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return toOdooDatetime(new Date(local.getTime() - offsetMs));
}

function verifyWebhookSecret(req) {
  const secret = String(process.env.ODOO_WEBHOOK_SECRET || "").trim();

  if (!secret) {
    return false;
  }

  return String(req.query.secret || req.headers["x-webhook-secret"] || "").trim() === secret;
}

function getWebhookRecordId(body) {
  const raw = body?._id ?? body?.id ?? body?.record_id;

  return Number(raw) || 0;
}

async function loadAppProduct(productId) {
  if (!productId) {
    return null;
  }

  const products = await odooCall("product.template", "search_read", {
    domain: getAppProductDomain([["id", "=", productId]]),
    fields: ["id", "name", "website_ribbon_id"],
    limit: 1,
  });

  return products[0] || null;
}

function getWebhookPartnerId(body) {
  const raw =
    body?.x_studio_customer ??
    body?.partner_id ??
    body?.customer_id ??
    body?.["x_studio_customer/id"];

  if (Array.isArray(raw)) {
    return Number(raw[0]) || 0;
  }

  return Number(raw) || 0;
}

export async function registerPushToken(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const expoPushToken = String(req.body.expo_push_token || "").trim();
    const language = String(req.body.language || "my").trim();

    if (!expoPushToken.startsWith("ExponentPushToken[")) {
      return error(res, "Invalid Expo push token", 400);
    }

    await upsertPushToken({
      partnerId: user.partner_id,
      uid: user.uid,
      expoPushToken,
      language,
    });

    return success(res, { message: "Push token registered" });
  } catch (err) {
    return error(res, "Failed to register push token", 500, getOdooError(err));
  }
}

export async function unregisterPushToken(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    await removePushToken(user.partner_id);

    return success(res, { message: "Push token removed" });
  } catch (err) {
    return error(res, "Failed to remove push token", 500, getOdooError(err));
  }
}

export async function sendTestPush(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const tokenEntries = await getPushTokenEntriesForPartner(user.partner_id);

    if (!tokenEntries.length) {
      return error(res, "No Expo push token registered for this account", 400);
    }

    const result = await sendExpoPushMessages(
      tokenEntries.map((entry) => {
        const copy = getPushCopy(entry.language);

        return {
          to: entry.to,
          sound: "default",
          title: copy.productTitle,
          body: copy.productBody(""),
          channelId: "default",
          data: { type: "test" },
        };
      })
    );

    return success(res, {
      message: "Test push sent",
      tickets: result.data,
    });
  } catch (err) {
    return error(res, "Failed to send test push", 500, getOdooError(err));
  }
}

export async function webhookNewProduct(req, res) {
  try {
    if (!verifyWebhookSecret(req)) {
      return error(res, "Unauthorized webhook", 401);
    }

    const productId = getWebhookRecordId(req.body);
    let productName = String(req.body?.name || "").trim();

    const product = await loadAppProduct(productId);

    if (!product || !isNewRibbonProduct(product)) {
      return success(res, {
        message: "Product ignored (must be app-tagged, published, and ribbon New)",
        sent: 0,
      });
    }

    productName = productName || product.name;

    const tokenEntries = await getAllPushTokenEntries();

    if (!tokenEntries.length) {
      return success(res, { message: "No registered push tokens", sent: 0 });
    }

    const result = await sendExpoPushMessages(
      buildProductPushMessages(tokenEntries, {
        id: productId,
        name: productName || "this product",
      })
    );

    return success(res, {
      message: "Product push sent",
      sent: tokenEntries.length,
      tickets: result.data,
    });
  } catch (err) {
    return error(res, "Failed to process product webhook", 500, getOdooError(err));
  }
}

export async function webhookNewCoupon(req, res) {
  try {
    if (!verifyWebhookSecret(req)) {
      return error(res, "Unauthorized webhook", 401);
    }

    const couponId = getWebhookRecordId(req.body);
    let partnerId = getWebhookPartnerId(req.body);
    let couponCode = String(req.body?.x_studio_coupon_code || req.body?.coupon_code || "").trim();

    if (couponId && (!partnerId || !couponCode)) {
      const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
        domain: [["id", "=", couponId]],
        fields: ["id", "x_studio_coupon_code", "x_studio_customer"],
        limit: 1,
      });

      if (!coupons.length) {
        return success(res, { message: "Coupon ignored", sent: 0 });
      }

      couponCode = coupons[0].x_studio_coupon_code || couponCode;
      partnerId = Array.isArray(coupons[0].x_studio_customer)
        ? coupons[0].x_studio_customer[0]
        : partnerId;
    }

    if (!partnerId) {
      return success(res, { message: "Coupon ignored: no partner", sent: 0 });
    }

    const tokenEntries = await getPushTokenEntriesForPartner(partnerId);

    if (!tokenEntries.length) {
      return success(res, { message: "No push token for this member", sent: 0 });
    }

    const result = await sendExpoPushMessages(
      buildCouponPushMessages(tokenEntries, { code: couponCode })
    );

    return success(res, {
      message: "Coupon push sent",
      sent: tokenEntries.length,
      tickets: result.data,
    });
  } catch (err) {
    return error(res, "Failed to process coupon webhook", 500, getOdooError(err));
  }
}

export async function getNotifications(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const notifications = [];

    // New-product notifications: app-tagged, published, sellable, ribbon = New.
    const products = await odooCall("product.template", "search_read", {
      domain: [
        ...getAppProductDomain(),
        ["website_ribbon_id.name", "ilike", "new"],
        ["create_date", ">=", getStartOfTodayUtc()],
      ],
      fields: ["id", "name", "create_date"],
      order: "create_date desc",
      limit: NEW_PRODUCT_LIMIT,
    });

    for (const product of products) {
      notifications.push({
        id: `product-${product.id}`,
        type: "product",
        product_id: product.id,
        product_name: product.name,
        date: product.create_date,
      });
    }

    // New-coupon notifications (only for members linked to a partner).
    if (user.partner_id) {
      const coupons = await odooCall("x_membership_coupon_ti", "search_read", {
        domain: [["x_studio_customer", "=", user.partner_id]],
        fields: [
          "id",
          "x_studio_coupon_code",
          "x_studio_coupon_amount",
          "x_studio_status",
          "create_date",
        ],
        order: "create_date desc",
        limit: NEW_COUPON_LIMIT,
      });

      for (const coupon of coupons) {
        notifications.push({
          id: `coupon-${coupon.id}`,
          type: "coupon",
          coupon_code: coupon.x_studio_coupon_code || "",
          amount: coupon.x_studio_coupon_amount || 0,
          status: coupon.x_studio_status || "",
          date: coupon.create_date,
        });
      }
    }

    notifications.sort(compareByDateDesc);

    return success(res, { notifications });
  } catch (err) {
    return error(res, "Failed to get notifications", 500, getOdooError(err));
  }
}
