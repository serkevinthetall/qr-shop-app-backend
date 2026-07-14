const COPY = {
  en: {
    productTitleFallback: "Product update",
    productTitle: (ribbon) => `${ribbon || "Product update"} Occurred`,
    productBody: (name) =>
      `${name || "This product"} — tap to view this product.`,
    couponTitle: "New coupon for you",
    couponBody: (code) => `A new coupon ${code || ""} is ready for you.`.trim(),
  },
  my: {
    productTitleFallback: "ပစ္စည်းအပ်ဒိတ်",
    productTitle: (ribbon) => `${ribbon || "ပစ္စည်းအပ်ဒိတ်"} တွေ့ရှိ`,
    productBody: (name) =>
      `${name || "ဤပစ္စည်း"} — ဤပစ္စည်းကို ကြည့်ရှုရန် နှိပ်ပါ။`,
    couponTitle: "သင့်အတွက် ကူပွန်အသစ်",
    couponBody: (code) => `ကူပွန်အသစ် ${code || ""} အသင့်ဖြစ်ပါပြီ။`.trim(),
  },
};

export function normalizePushLanguage(value) {
  return String(value || "").trim().toLowerCase() === "en" ? "en" : "my";
}

export function getPushCopy(language) {
  return COPY[normalizePushLanguage(language)];
}
