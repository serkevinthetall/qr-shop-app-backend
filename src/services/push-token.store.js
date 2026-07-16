import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { normalizePushLanguage } from "../utils/push-i18n.js";
import { odooCall } from "./odoo.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "../../data/push-tokens.json");
const PARTNER_FIELD =
  process.env.PUSH_TOKEN_PARTNER_FIELD || "x_studio_expo_push_token";
// Vercel filesystem is ephemeral/read-only — Odoo is the source of truth there.
const FILE_STORE_ENABLED = !process.env.VERCEL;

function isValidExpoToken(token) {
  return String(token || "").trim().startsWith("ExponentPushToken[");
}

async function readFileStore() {
  if (!FILE_STORE_ENABLED) {
    return { tokens: [] };
  }

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
  if (!FILE_STORE_ENABLED) {
    return;
  }

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

async function upsertFileToken({ partnerId, uid, expoPushToken, language }) {
  const store = await readFileStore();
  const now = new Date().toISOString();
  const existing = store.tokens.find((item) => item.partner_id === partnerId);

  if (existing) {
    existing.uid = uid;
    existing.expo_push_token = expoPushToken;
    existing.language = normalizePushLanguage(language || existing.language);
    existing.updated_at = now;
  } else {
    store.tokens.push({
      partner_id: partnerId,
      uid,
      expo_push_token: expoPushToken,
      language: normalizePushLanguage(language),
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

function toTokenEntry(token, language = "my", partnerId = null) {
  const normalized = String(token || "").trim();

  if (!isValidExpoToken(normalized)) {
    return null;
  }

  return {
    to: normalized,
    language: normalizePushLanguage(language),
    partner_id: partnerId,
  };
}

function mergeTokenEntries(...lists) {
  const byToken = new Map();

  for (const list of lists) {
    for (const entry of list) {
      if (!entry?.to) {
        continue;
      }

      const existing = byToken.get(entry.to);

      if (!existing) {
        byToken.set(entry.to, entry);
        continue;
      }

      byToken.set(entry.to, {
        ...existing,
        language: entry.language || existing.language,
        partner_id: existing.partner_id ?? entry.partner_id ?? null,
      });
    }
  }

  return [...byToken.values()];
}

export async function upsertPushToken({ partnerId, uid, expoPushToken, language }) {
  await upsertFileToken({ partnerId, uid, expoPushToken, language });

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

export async function getAllPushTokenEntries() {
  const fileEntries = (await readFileStore()).tokens
    .map((item) =>
      toTokenEntry(item.expo_push_token, item.language, item.partner_id)
    )
    .filter(Boolean);

  try {
    const partners = await odooCall("res.partner", "search_read", {
      domain: [[PARTNER_FIELD, "!=", false]],
      fields: ["id", PARTNER_FIELD],
    });

    const odooEntries = partners
      .map((partner) => {
        const fileMatch = fileEntries.find(
          (entry) => entry.partner_id === partner.id
        );

        return toTokenEntry(
          partner[PARTNER_FIELD],
          fileMatch?.language,
          partner.id
        );
      })
      .filter(Boolean);

    return mergeTokenEntries(fileEntries, odooEntries);
  } catch (err) {
    console.warn("Odoo push token read failed; using local file store only:", err.message);
    return mergeTokenEntries(fileEntries);
  }
}

export async function getAllPushTokens() {
  const entries = await getAllPushTokenEntries();
  return entries.map((entry) => entry.to);
}

export async function getPushTokenEntriesForPartner(partnerId) {
  const fileEntries = (await readFileStore()).tokens
    .filter((item) => item.partner_id === partnerId)
    .map((item) =>
      toTokenEntry(item.expo_push_token, item.language, item.partner_id)
    )
    .filter(Boolean);

  try {
    const odooToken = await readOdooToken(partnerId);
    const odooEntry = toTokenEntry(
      odooToken,
      fileEntries[0]?.language,
      partnerId
    );

    return mergeTokenEntries(odooEntry ? [odooEntry] : [], fileEntries);
  } catch (err) {
    console.warn(
      "Odoo partner push token read failed; using local file store only:",
      err.message
    );
    return mergeTokenEntries(fileEntries);
  }
}

export async function getPushTokensForPartner(partnerId) {
  const entries = await getPushTokenEntriesForPartner(partnerId);
  return entries.map((entry) => entry.to);
}

export async function getPushTokenForPartner(partnerId) {
  const tokens = await getPushTokensForPartner(partnerId);
  return tokens[0] || null;
}
