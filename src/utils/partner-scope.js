import { odooCall } from "../services/odoo.service.js";
import { normalizePartnerId } from "./partner-id.js";

const ADDRESS_FIELDS = [
  "id",
  "name",
  "phone",
  "street",
  "street2",
  "city",
  "zip",
  "state_id",
  "country_id",
  "parent_id",
  "type",
  "commercial_partner_id",
];

const ADDRESS_TYPES = new Set(["delivery", "invoice", "other", "contact"]);

function sortAddresses(addresses) {
  return [...addresses].sort((left, right) => {
    const leftParent = Array.isArray(left.parent_id) ? left.parent_id[0] : 0;
    const rightParent = Array.isArray(right.parent_id) ? right.parent_id[0] : 0;

    if (leftParent !== rightParent) {
      return leftParent - rightParent;
    }

    return left.id - right.id;
  });
}

function dedupeAddresses(addresses) {
  const byId = new Map();

  for (const address of addresses) {
    if (!address?.id) {
      continue;
    }

    byId.set(address.id, address);
  }

  return sortAddresses([...byId.values()]);
}

function hasAddressData(address) {
  return Boolean(
    String(address?.street || "").trim() ||
      String(address?.street2 || "").trim() ||
      String(address?.city || "").trim()
  );
}

function buildChildOfDomain(partnerIds) {
  const uniqueIds = [...new Set(partnerIds.filter(Boolean))];

  if (!uniqueIds.length) {
    return [["id", "=", 0]];
  }

  if (uniqueIds.length === 1) {
    return [["id", "child_of", uniqueIds[0]]];
  }

  const domain = [];

  for (let index = 0; index < uniqueIds.length; index += 1) {
    if (index > 0) {
      domain.push("|");
    }

    domain.push(["id", "child_of", uniqueIds[index]]);
  }

  return domain;
}

export async function getAccountPartnerIds(partnerId) {
  const id = normalizePartnerId(partnerId);

  if (!id) {
    return [];
  }

  const partners = await odooCall("res.partner", "search_read", {
    domain: [["id", "=", id]],
    fields: ["parent_id", "commercial_partner_id"],
    limit: 1,
  });

  const partner = partners[0];
  const ids = new Set([id]);

  if (partner?.parent_id?.[0]) {
    ids.add(partner.parent_id[0]);
  }

  if (partner?.commercial_partner_id?.[0]) {
    ids.add(partner.commercial_partner_id[0]);
  }

  return [...ids];
}

async function searchPartnerAddresses(domain) {
  const addresses = await odooCall("res.partner", "search_read", {
    domain: [["active", "=", true], ...domain],
    fields: ADDRESS_FIELDS,
    limit: 100,
  });

  return addresses;
}

function filterAccountAddresses(addresses, accountPartnerIds) {
  const accountIds = new Set(accountPartnerIds);

  return addresses.filter((address) => {
    if (!address?.id) {
      return false;
    }

    if (accountIds.has(address.id)) {
      return true;
    }

    const parentId = Array.isArray(address.parent_id) ? address.parent_id[0] : 0;

    if (parentId && accountIds.has(parentId)) {
      return true;
    }

    const commercialId = Array.isArray(address.commercial_partner_id)
      ? address.commercial_partner_id[0]
      : 0;

    if (!commercialId || !accountIds.has(commercialId)) {
      return false;
    }

    if (!hasAddressData(address)) {
      return false;
    }

    return (
      Boolean(parentId) ||
      ADDRESS_TYPES.has(String(address.type || "").toLowerCase())
    );
  });
}

async function searchSimplePartnerAddresses(partnerId) {
  return searchPartnerAddresses([
    "|",
    ["id", "=", partnerId],
    ["parent_id", "=", partnerId],
  ]);
}

async function searchExpandedPartnerAddresses(partnerId) {
  const accountPartnerIds = await getAccountPartnerIds(partnerId);

  if (!accountPartnerIds.length) {
    return [];
  }

  const [hierarchyAddresses, linkedAddresses] = await Promise.all([
    searchPartnerAddresses(buildChildOfDomain(accountPartnerIds)),
    searchPartnerAddresses([
      ["commercial_partner_id", "in", accountPartnerIds],
      "|",
      ["street", "!=", false],
      ["city", "!=", false],
    ]),
  ]);

  return filterAccountAddresses(
    dedupeAddresses([...hierarchyAddresses, ...linkedAddresses]),
    accountPartnerIds
  );
}

export async function getAccountAddresses(partnerId) {
  const id = normalizePartnerId(partnerId);

  if (!id) {
    return [];
  }

  try {
    return await searchExpandedPartnerAddresses(id);
  } catch (err) {
    console.log("Expanded address lookup failed, falling back:", err.message);
    return searchSimplePartnerAddresses(id);
  }
}

async function isAddressInAccountScope(addressId, partnerId) {
  const normalizedAddressId = normalizePartnerId(addressId);
  const normalizedPartnerId = normalizePartnerId(partnerId);

  if (!normalizedAddressId || !normalizedPartnerId) {
    return false;
  }

  const addresses = await getAccountAddresses(normalizedPartnerId);
  return addresses.some((address) => address.id === normalizedAddressId);
}

export async function resolveShippingPartnerId(user, rawAddressId) {
  const partnerId = normalizePartnerId(user?.partner_id);
  const requestedId = normalizePartnerId(rawAddressId);

  if (!partnerId || !requestedId) {
    return null;
  }

  const allowed = await isAddressInAccountScope(requestedId, partnerId);

  return allowed ? requestedId : null;
}

export async function isManagedChildAddress(addressId, partnerId) {
  const normalizedAddressId = normalizePartnerId(addressId);
  const normalizedPartnerId = normalizePartnerId(partnerId);

  if (!normalizedAddressId || !normalizedPartnerId) {
    return false;
  }

  if (normalizedAddressId === normalizedPartnerId) {
    return false;
  }

  return isAddressInAccountScope(normalizedAddressId, normalizedPartnerId);
}
