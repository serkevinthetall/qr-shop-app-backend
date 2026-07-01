import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "../../data/push-tokens.json");

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return { tokens: [] };
    }

    if (!Array.isArray(parsed.tokens)) {
      return { tokens: [] };
    }

    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") {
      return { tokens: [] };
    }

    throw err;
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function upsertPushToken({ partnerId, uid, expoPushToken }) {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = store.tokens.find((item) => item.partner_id === partnerId);

  if (existing) {
    existing.uid = uid;
    existing.expo_push_token = expoPushToken;
    existing.updated_at = now;
  } else {
    store.tokens.push({
      partner_id: partnerId,
      uid,
      expo_push_token: expoPushToken,
      updated_at: now,
    });
  }

  await writeStore(store);
  return true;
}

export async function removePushToken(partnerId) {
  const store = await readStore();
  const next = store.tokens.filter((item) => item.partner_id !== partnerId);

  if (next.length === store.tokens.length) {
    return false;
  }

  await writeStore({ tokens: next });
  return true;
}

export async function getAllPushTokens() {
  const store = await readStore();
  return store.tokens
    .map((item) => String(item.expo_push_token || "").trim())
    .filter(Boolean);
}

export async function getPushTokensForPartner(partnerId) {
  const store = await readStore();
  return store.tokens
    .filter((item) => item.partner_id === partnerId)
    .map((item) => String(item.expo_push_token || "").trim())
    .filter(Boolean);
}

export async function getPushTokenForPartner(partnerId) {
  const tokens = await getPushTokensForPartner(partnerId);
  return tokens[0] || null;
}
