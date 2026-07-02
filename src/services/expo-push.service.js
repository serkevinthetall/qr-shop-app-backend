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

export function buildProductPushMessages(tokens, product) {
  const title = "New product";
  const body = `Hello QR member, check out ${product.name || "this new product"}.`;

  return tokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    channelId: ANDROID_CHANNEL_ID,
    data: {
      type: "product",
      productId: product.id,
    },
  }));
}

export function buildCouponPushMessages(tokens, coupon) {
  const title = "New coupon for you";
  const body = `A new coupon ${coupon.code || ""} is ready for you.`.trim();

  return tokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    channelId: ANDROID_CHANNEL_ID,
    data: {
      type: "coupon",
      couponCode: coupon.code || "",
    },
  }));
}
