import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import {
  buildCouponPushMessages,
  buildProductPushMessages,
  buildTestPushMessages,
  sendExpoPushMessages,
  summarizeExpoPushTickets,
} from "../services/expo-push.service.js";
import {
  getAllPushTokenEntries,
  getPushTokenEntriesForPartner,
  removePushToken,
  upsertPushToken,
} from "../services/push-token.store.js";
import {
  getAppProductDomain,
  getNotifiableRibbonOdooDomain,
  getProductRibbonName,
  isBlockedRibbonName,
  isNotifiableRibbonProduct,
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
    return { ok: false, reason: "missing_server_secret" };
  }

  const provided = String(req.query.secret || req.headers["x-webhook-secret"] || "").trim();

  if (!provided || provided !== secret) {
    return { ok: false, reason: "bad_secret" };
  }

  return { ok: true, reason: null };
}

function rejectUnauthorizedWebhook(res, reason) {
  if (reason === "missing_server_secret") {
    console.error(
      "ODOO_WEBHOOK_SECRET is not set on the server — Odoo cannot trigger background pushes"
    );
    return error(res, "Webhook secret not configured on server", 503);
  }

  console.warn("Unauthorized notification webhook:", reason);
  return error(res, "Unauthorized webhook", 401);
}

function getWebhookRecordId(body) {
  const candidates = [
    body?._id,
    body?.id,
    body?.record_id,
    body?.res_id,
    body?.["id"],
    Array.isArray(body?._id) ? body._id[0] : null,
  ];

  for (const candidate of candidates) {
    const id = Number(candidate);
    if (id > 0) {
      return id;
    }
  }

  return 0;
}

function getWebhookRibbonName(body) {
  const raw =
    body?.website_ribbon_id ??
    body?.["website_ribbon_id/id"] ??
    body?.ribbon ??
    body?.ribbon_name;

  if (Array.isArray(raw)) {
    // Odoo many2one often arrives as [id, "Arrival"] or just the display name in [1].
    return String(raw[1] || raw[0] || "").trim();
  }

  if (raw && typeof raw === "object") {
    return String(raw.display_name || raw.name || "").trim();
  }

  return String(raw || "").trim();
}

function resolveNotifiableRibbon(product, webhookBody) {
  const fromProduct = getProductRibbonName(product);
  if (fromProduct && !isBlockedRibbonName(fromProduct)) {
    return fromProduct;
  }

  // Odoo webhooks can fire slightly before search_read sees the new ribbon.
  // Prefer the ribbon value included in the webhook payload when present.
  const fromWebhook = getWebhookRibbonName(webhookBody);
  if (fromWebhook && !isBlockedRibbonName(fromWebhook)) {
    return fromWebhook;
  }

  return "";
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

export async function getPushStatus(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const tokenEntries = await getPushTokenEntriesForPartner(user.partner_id);
    const webhookSecretConfigured = Boolean(
      String(process.env.ODOO_WEBHOOK_SECRET || "").trim()
    );

    return success(res, {
      partner_id: user.partner_id,
      saved_on_server: tokenEntries.length > 0,
      token_count: tokenEntries.length,
      token_preview: tokenEntries[0]?.to
        ? `${String(tokenEntries[0].to).slice(0, 28)}…`
        : null,
      webhook_secret_configured: webhookSecretConfigured,
    });
  } catch (err) {
    return error(res, "Failed to get push status", 500, getOdooError(err));
  }
}

export async function sendTestPush(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    if (!user.partner_id) return error(res, "No partner linked to this user", 400);

    const tokenEntries = await getPushTokenEntriesForPartner(user.partner_id);

    if (!tokenEntries.length) {
      return error(
        res,
        "No Expo push token registered for this account. Open the Play Store app, allow notifications, and log in again.",
        400
      );
    }

    const result = await sendExpoPushMessages(buildTestPushMessages(tokenEntries));

    const summary = summarizeExpoPushTickets(result.data);

    if (summary.errors.length) {
      return error(res, summary.errors[0], 502, {
        tickets: result.data,
        tokens: tokenEntries.map((entry) => entry.to),
      });
    }

    return success(res, {
      message: "Test push sent",
      sent: summary.ok,
      tickets: result.data,
      tokens: tokenEntries.map((entry) => entry.to),
    });
  } catch (err) {
    return error(res, "Failed to send test push", 500, getOdooError(err));
  }
}

export async function webhookNewProduct(req, res) {
  try {
    const auth = verifyWebhookSecret(req);

    if (!auth.ok) {
      return rejectUnauthorizedWebhook(res, auth.reason);
    }

    const productId = getWebhookRecordId(req.body);
    let productName = String(req.body?.name || "").trim();

    if (!productId) {
      console.warn("Product webhook ignored: missing product id", {
        bodyKeys: Object.keys(req.body || {}),
      });
      return success(res, {
        message: "Product ignored: missing product id in webhook body",
        sent: 0,
        reason: "missing_product_id",
      });
    }

    const product = await loadAppProduct(productId);

    if (!product) {
      console.warn("Product webhook ignored: not an app-published product", {
        productId,
      });
      return success(res, {
        message:
          "Product ignored (must be QR App tagged, saleable, and website published)",
        sent: 0,
        reason: "not_app_product",
        productId,
      });
    }

    const ribbonName = resolveNotifiableRibbon(product, req.body);

    if (!ribbonName) {
      console.warn("Product webhook ignored: no notifiable ribbon", {
        productId,
        odooRibbon: getProductRibbonName(product),
        webhookRibbon: getWebhookRibbonName(req.body),
      });
      return success(res, {
        message:
          "Product ignored (ribbon empty / Sold out / Out of stock). Arrival/Sale/New should notify.",
        sent: 0,
        reason: "ribbon_not_notifiable",
        productId,
        odoo_ribbon: getProductRibbonName(product) || null,
        webhook_ribbon: getWebhookRibbonName(req.body) || null,
      });
    }

    productName = productName || product.name;

    const tokenEntries = await getAllPushTokenEntries();

    if (!tokenEntries.length) {
      console.warn("Product webhook: no registered push tokens in Odoo");
      return success(res, {
        message: "No registered push tokens",
        sent: 0,
        reason: "no_tokens",
        productId,
        ribbon: ribbonName,
      });
    }

    const result = await sendExpoPushMessages(
      buildProductPushMessages(tokenEntries, {
        id: productId,
        name: productName || "this product",
        ribbon_name: ribbonName,
      })
    );

    const summary = summarizeExpoPushTickets(result.data);

    if (summary.errors.length) {
      console.error("Product webhook Expo ticket errors:", summary.errors);
    }

    return success(res, {
      message: "Product push sent",
      sent: summary.ok,
      failed: summary.errors.length,
      productId,
      ribbon: ribbonName,
      tickets: result.data,
    });
  } catch (err) {
    return error(res, "Failed to process product webhook", 500, getOdooError(err));
  }
}

export async function webhookNewCoupon(req, res) {
  try {
    const auth = verifyWebhookSecret(req);

    if (!auth.ok) {
      return rejectUnauthorizedWebhook(res, auth.reason);
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
      console.warn("Coupon webhook: no push token for partner", partnerId);
      return success(res, { message: "No push token for this member", sent: 0 });
    }

    const result = await sendExpoPushMessages(
      buildCouponPushMessages(tokenEntries, { code: couponCode })
    );

    const summary = summarizeExpoPushTickets(result.data);

    if (summary.errors.length) {
      console.error("Coupon webhook Expo ticket errors:", summary.errors);
    }

    return success(res, {
      message: "Coupon push sent",
      sent: summary.ok,
      failed: summary.errors.length,
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

    // Product notifications: any notifiable ribbon (not Sold out / Out of stock).
    const products = await odooCall("product.template", "search_read", {
      domain: [
        ...getAppProductDomain(),
        ...getNotifiableRibbonOdooDomain(),
        ["write_date", ">=", getStartOfTodayUtc()],
      ],
      fields: ["id", "name", "write_date", "website_ribbon_id"],
      order: "write_date desc",
      limit: NEW_PRODUCT_LIMIT,
    });

    for (const product of products) {
      if (!isNotifiableRibbonProduct(product)) {
        continue;
      }

      notifications.push({
        id: `product-${product.id}`,
        type: "product",
        product_id: product.id,
        product_name: product.name,
        ribbon_name: getProductRibbonName(product),
        date: product.write_date,
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
