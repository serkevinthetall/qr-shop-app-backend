import { getPushCopy } from "../utils/push-i18n.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const ANDROID_CHANNEL_ID = "default";

function chunk(items, size) {
  const batches = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

export async function sendExpoPushMessages(messages) {
  const valid = messages.filter((message) => message && message.to);

  if (!valid.length) {
    return { data: [] };
  }

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/json",
  };

  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }

  const results = [];

  for (const batch of chunk(valid, 100)) {
    // FCM V1 is required for Android delivery via Expo Push.
    const response = await fetch(`${EXPO_PUSH_URL}?useFcmV1=true`, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.errors?.[0]?.message || "Expo push request failed");
    }

    if (Array.isArray(payload?.data)) {
      results.push(...payload.data);
    }
  }

  return { data: results };
}

export function summarizeExpoPushTickets(tickets = []) {
  const errors = [];
  let ok = 0;

  for (const ticket of tickets) {
    if (!ticket || ticket.status === "ok") {
      ok += 1;
      continue;
    }

    const detail =
      ticket.message ||
      ticket.details?.error ||
      ticket.details?.fault ||
      "Push ticket error";

    errors.push(String(detail));
  }

  return { ok, errors };
}

function withAndroidDeliveryDefaults(message) {
  return {
    ...message,
    // High priority + explicit channel keeps Android banners working in background.
    priority: "high",
    channelId: message.channelId || ANDROID_CHANNEL_ID,
    sound: message.sound || "default",
    ttl: message.ttl ?? 3600,
    expiration: message.expiration ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

export function buildProductPushMessages(entries, product) {
  const ribbonName = String(product.ribbon_name || "").trim();

  return entries.map(({ to, language }) => {
    const copy = getPushCopy(language);

    return withAndroidDeliveryDefaults({
      to,
      sound: "default",
      title: copy.productTitle(ribbonName),
      body: copy.productBody(product.name),
      channelId: ANDROID_CHANNEL_ID,
      data: {
        type: "product",
        productId: product.id,
        productName: product.name || "",
        ribbonName,
      },
    });
  });
}

export function buildCouponPushMessages(entries, coupon) {
  return entries.map(({ to, language }) => {
    const copy = getPushCopy(language);

    return withAndroidDeliveryDefaults({
      to,
      sound: "default",
      title: copy.couponTitle,
      body: copy.couponBody(coupon.code),
      channelId: ANDROID_CHANNEL_ID,
      data: {
        type: "coupon",
        couponCode: coupon.code || "",
      },
    });
  });
}

export function buildTestPushMessages(entries) {
  return entries.map(({ to, language }) => {
    const copy = getPushCopy(language);

    return withAndroidDeliveryDefaults({
      to,
      sound: "default",
      title: copy.productTitle(""),
      body: copy.productBody(""),
      channelId: ANDROID_CHANNEL_ID,
      data: { type: "test" },
    });
  });
}
