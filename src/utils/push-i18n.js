const COPY = {
  en: {
    productTitle: "New product",
    productBody: (name) =>
      `Hello QR member, check out ${name || "this new product"}.`,
    couponTitle: "New coupon for you",
    couponBody: (code) => `A new coupon ${code || ""} is ready for you.`.trim(),
  },
  my: {
    productTitle: "ပစ္စည်းအသစ်",
    productBody: (name) =>
      `${name || "ဤပစ္စည်းအသစ်"} — မင်္ဂလာပါ QR အဖွဲ့ဝင်၊ ဤပစ္စည်းအသစ်ကို ကြည့်ရှုပါ။`,
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
