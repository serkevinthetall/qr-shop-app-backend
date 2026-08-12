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
const MAX_TOKENS_PER_PARTNER = Number(process.env.PUSH_TOKEN_MAX_PER_PARTNER || 5);

function isValidExpoToken(token) {
  return String(token || "").trim().startsWith("ExponentPushToken[");
}

function normalizeDevice(device) {
  const token = String(device?.token || device?.expo_push_token || device?.t || "").trim();

  if (!isValidExpoToken(token)) {
    return null;
  }

  return {
    token,
    language: normalizePushLanguage(device?.language || device?.l),
    updated_at: String(device?.updated_at || device?.u || new Date().toISOString()),
  };
}

/** Parse Odoo Char field: legacy single token OR JSON device list. */
export function parseStoredDevices(raw) {
  const value = String(raw || "").trim();

  if (!value) {
    return [];
  }

  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map(normalizeDevice).filter(Boolean);
    } catch {
      return [];
    }
  }

  if (isValidExpoToken(value)) {
    return [
      {
        token: value,
        language: "my",
        updated_at: new Date().toISOString(),
      },
    ];
  }

  return [];
}

function serializeDevices(devices) {
  const normalized = devices.map(normalizeDevice).filter(Boolean);

  if (!normalized.length) {
    return false;
  }

  // Compact JSON keeps Char fields under typical 255–512 limits for a few devices.
  return JSON.stringify(
    normalized.map((device) => ({
      t: device.token,
      l: device.language,
      u: device.updated_at,
    }))
  );
}

function upsertDeviceList(devices, { expoPushToken, language }) {
  const now = new Date().toISOString();
  const next = devices.filter((device) => device.token !== expoPushToken);

  next.push({
    token: expoPushToken,
    language: normalizePushLanguage(language),
    updated_at: now,
  });

  next.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));

  while (next.length > MAX_TOKENS_PER_PARTNER) {
    next.shift();
  }

  return next;
}

async function readFileStore() {
  if (!FILE_STORE_ENABLED) {
    return { partners: {} };
  }

  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    // Migrate legacy { tokens: [{ partner_id, expo_push_token, ... }] }.
    if (parsed && Array.isArray(parsed.tokens)) {
      const partners = {};

      for (const item of parsed.tokens) {
        const partnerId = Number(item.partner_id);
        const device = normalizeDevice(item);

        if (!partnerId || !device) {
          continue;
        }

        partners[partnerId] = upsertDeviceList(partners[partnerId] || [], {
          expoPushToken: device.token,
          language: device.language,
        });
      }

      return { partners };
    }

    if (parsed && parsed.partners && typeof parsed.partners === "object") {
      const partners = {};

      for (const [partnerId, devices] of Object.entries(parsed.partners)) {
        partners[partnerId] = (Array.isArray(devices) ? devices : [])
          .map(normalizeDevice)
          .filter(Boolean);
      }

      return { partners };
    }

    return { partners: {} };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { partners: {} };
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

async function writeOdooDevices(partnerId, devices) {
  await odooCall("res.partner", "write", {
    ids: [partnerId],
    vals: {
      [PARTNER_FIELD]: serializeDevices(devices),
    },
  });
}

async function readOdooDevices(partnerId) {
  const partners = await odooCall("res.partner", "search_read", {
    domain: [["id", "=", partnerId]],
    fields: ["id", PARTNER_FIELD],
    limit: 1,
  });

  return parseStoredDevices(partners[0]?.[PARTNER_FIELD]);
}

function toTokenEntry(device, partnerId = null) {
  const normalized = normalizeDevice(device);

  if (!normalized) {
    return null;
  }

  return {
    to: normalized.token,
    language: normalized.language,
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

/**
 * @returns {{ isNewToken: boolean, tokenCount: number }}
 */
export async function upsertPushToken({ partnerId, uid, expoPushToken, language }) {
  void uid;

  const store = await readFileStore();
  const key = String(partnerId);
  const beforeFile = store.partners[key] || [];
  const wasKnownInFile = beforeFile.some((device) => device.token === expoPushToken);

  let odooDevices = [];
  let wasKnownInOdoo = false;

  try {
    odooDevices = await readOdooDevices(partnerId);
    wasKnownInOdoo = odooDevices.some((device) => device.token === expoPushToken);
  } catch (err) {
    console.warn("Odoo push token read failed before upsert:", err.message);
  }

  const merged = upsertDeviceList(
    mergeDeviceLists(beforeFile, odooDevices),
    { expoPushToken, language }
  );

  store.partners[key] = merged;
  await writeFileStore(store);

  try {
    await writeOdooDevices(partnerId, merged);
  } catch (err) {
    if (!FILE_STORE_ENABLED) {
      throw err;
    }

    console.warn(
      "Odoo push token write failed; using local file store only:",
      err.message
    );
  }

  return {
    isNewToken: !wasKnownInFile && !wasKnownInOdoo,
    tokenCount: merged.length,
  };
}

function mergeDeviceLists(...lists) {
  const byToken = new Map();

  for (const list of lists) {
    for (const device of list || []) {
      const normalized = normalizeDevice(device);

      if (!normalized) {
        continue;
      }

      const existing = byToken.get(normalized.token);

      if (!existing || String(normalized.updated_at) > String(existing.updated_at)) {
        byToken.set(normalized.token, normalized);
      }
    }
  }

  return [...byToken.values()];
}

export async function removePushToken(partnerId, expoPushToken = null) {
  const store = await readFileStore();
  const key = String(partnerId);
  const existing = store.partners[key] || [];
  const target = String(expoPushToken || "").trim();

  let next;

  if (target && isValidExpoToken(target)) {
    next = existing.filter((device) => device.token !== target);
  } else {
    next = [];
  }

  if (next.length) {
    store.partners[key] = next;
  } else {
    delete store.partners[key];
  }

  await writeFileStore(store);

  try {
    let odooDevices = [];

    try {
      odooDevices = await readOdooDevices(partnerId);
    } catch {
      odooDevices = [];
    }

    let odooNext;

    if (target && isValidExpoToken(target)) {
      odooNext = mergeDeviceLists(odooDevices, existing).filter(
        (device) => device.token !== target
      );
    } else {
      odooNext = [];
    }

    await writeOdooDevices(partnerId, odooNext);
  } catch (err) {
    console.warn(
      "Odoo push token clear failed; removed from local file store only:",
      err.message
    );
  }

  return true;
}

export async function getAllPushTokenEntries() {
  const store = await readFileStore();
  const fileEntries = [];

  for (const [partnerId, devices] of Object.entries(store.partners || {})) {
    for (const device of devices) {
      const entry = toTokenEntry(device, Number(partnerId));
      if (entry) {
        fileEntries.push(entry);
      }
    }
  }

  try {
    const partners = await odooCall("res.partner", "search_read", {
      domain: [[PARTNER_FIELD, "!=", false]],
      fields: ["id", PARTNER_FIELD],
    });

    const odooEntries = [];

    for (const partner of partners) {
      for (const device of parseStoredDevices(partner[PARTNER_FIELD])) {
        const entry = toTokenEntry(device, partner.id);
        if (entry) {
          odooEntries.push(entry);
        }
      }
    }

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
  const store = await readFileStore();
  const fileEntries = (store.partners[String(partnerId)] || [])
    .map((device) => toTokenEntry(device, partnerId))
    .filter(Boolean);

  try {
    const odooEntries = (await readOdooDevices(partnerId))
      .map((device) => toTokenEntry(device, partnerId))
      .filter(Boolean);

    return mergeTokenEntries(odooEntries, fileEntries);
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
