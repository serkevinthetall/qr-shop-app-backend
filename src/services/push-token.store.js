import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { odooCall } from "./odoo.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "../../data/push-tokens.json");
const PARTNER_FIELD =
  process.env.PUSH_TOKEN_PARTNER_FIELD || "x_studio_expo_push_token";

function isValidExpoToken(token) {
  return String(token || "").trim().startsWith("ExponentPushToken[");
}

async function readFileStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tokens)) {
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

async function writeFileStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function writeOdooToken(partnerId, expoPushToken) {
  await odooCall("res.partner", "write", {
    ids: [partnerId],
    vals: {
      [PARTNER_FIELD]: expoPushToken || false,
    },
  });
}

async function readOdooToken(partnerId) {
  const partners = await odooCall("res.partner", "search_read", {
    domain: [["id", "=", partnerId]],
    fields: ["id", PARTNER_FIELD],
    limit: 1,
  });

  const token = String(partners[0]?.[PARTNER_FIELD] || "").trim();
  return isValidExpoToken(token) ? token : null;
}

async function readAllOdooTokens() {
  const partners = await odooCall("res.partner", "search_read", {
    domain: [[PARTNER_FIELD, "!=", false]],
    fields: ["id", PARTNER_FIELD],
  });

  return partners
    .map((partner) => String(partner[PARTNER_FIELD] || "").trim())
    .filter(isValidExpoToken);
}

async function upsertFileToken({ partnerId, uid, expoPushToken }) {
  const store = await readFileStore();
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

  await writeFileStore(store);
}

async function removeFileToken(partnerId) {
  const store = await readFileStore();
  const next = store.tokens.filter((item) => item.partner_id !== partnerId);

  if (next.length === store.tokens.length) {
    return false;
  }

  await writeFileStore({ tokens: next });
  return true;
}

function uniqueTokens(tokens) {
  return [...new Set(tokens.filter(isValidExpoToken))];
}

export async function upsertPushToken({ partnerId, uid, expoPushToken }) {
  await upsertFileToken({ partnerId, uid, expoPushToken });

  try {
    await writeOdooToken(partnerId, expoPushToken);
  } catch (err) {
    console.warn(
      "Odoo push token write failed; using local file store only:",
      err.message
    );
  }

  return true;
}

export async function removePushToken(partnerId) {
  await removeFileToken(partnerId);

  try {
    await writeOdooToken(partnerId, false);
  } catch (err) {
    console.warn(
      "Odoo push token clear failed; removed from local file store only:",
      err.message
    );
  }

  return true;
}

export async function getAllPushTokens() {
  const fileTokens = (await readFileStore()).tokens
    .map((item) => String(item.expo_push_token || "").trim())
    .filter(isValidExpoToken);

  try {
    const odooTokens = await readAllOdooTokens();
    return uniqueTokens([...odooTokens, ...fileTokens]);
  } catch (err) {
    console.warn("Odoo push token read failed; using local file store only:", err.message);
    return uniqueTokens(fileTokens);
  }
}

export async function getPushTokensForPartner(partnerId) {
  const fileTokens = (await readFileStore()).tokens
    .filter((item) => item.partner_id === partnerId)
    .map((item) => String(item.expo_push_token || "").trim())
    .filter(isValidExpoToken);

  try {
    const odooToken = await readOdooToken(partnerId);
    return uniqueTokens(odooToken ? [odooToken, ...fileTokens] : fileTokens);
  } catch (err) {
    console.warn(
      "Odoo partner push token read failed; using local file store only:",
      err.message
    );
    return uniqueTokens(fileTokens);
  }
}

export async function getPushTokenForPartner(partnerId) {
  const tokens = await getPushTokensForPartner(partnerId);
  return tokens[0] || null;
}
