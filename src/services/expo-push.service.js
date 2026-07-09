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
    const response = await fetch(EXPO_PUSH_URL, {
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

export function buildProductPushMessages(entries, product) {
  return entries.map(({ to, language }) => {
    const copy = getPushCopy(language);

    return {
      to,
      sound: "default",
      title: copy.productTitle,
      body: copy.productBody(product.name),
      channelId: ANDROID_CHANNEL_ID,
      data: {
        type: "product",
        productId: product.id,
        productName: product.name || "",
      },
    };
  });
}

export function buildCouponPushMessages(entries, coupon) {
  return entries.map(({ to, language }) => {
    const copy = getPushCopy(language);

    return {
      to,
      sound: "default",
      title: copy.couponTitle,
      body: copy.couponBody(coupon.code),
      channelId: ANDROID_CHANNEL_ID,
      data: {
        type: "coupon",
        couponCode: coupon.code || "",
      },
    };
  });
}
