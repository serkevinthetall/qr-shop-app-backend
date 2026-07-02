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
];

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

  return sortAddresses(addresses);
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

  return searchPartnerAddresses([
    "|",
    ["id", "in", accountPartnerIds],
    ["parent_id", "in", accountPartnerIds],
  ]);
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

export async function resolveShippingPartnerId(user, rawAddressId) {
  const partnerId = normalizePartnerId(user?.partner_id);
  const requestedId = normalizePartnerId(rawAddressId);

  if (!partnerId || !requestedId) {
    return null;
  }

  const accountPartnerIds = await getAccountPartnerIds(partnerId);

  if (accountPartnerIds.includes(requestedId)) {
    return requestedId;
  }

  const childAddresses = await odooCall("res.partner", "search_read", {
    domain: [
      ["id", "=", requestedId],
      ["parent_id", "in", accountPartnerIds],
      ["active", "=", true],
    ],
    fields: ["id"],
    limit: 1,
  });

  if (!childAddresses.length) {
    return null;
  }

  return requestedId;
}

export async function isManagedChildAddress(addressId, partnerId) {
  const normalizedAddressId = normalizePartnerId(addressId);
  const normalizedPartnerId = normalizePartnerId(partnerId);

  if (!normalizedAddressId || !normalizedPartnerId) {
    return false;
  }

  const accountPartnerIds = await getAccountPartnerIds(normalizedPartnerId);

  const addresses = await odooCall("res.partner", "search_read", {
    domain: [
      ["id", "=", normalizedAddressId],
      ["parent_id", "in", accountPartnerIds],
      ["active", "=", true],
    ],
    fields: ["id"],
    limit: 1,
  });

  return addresses.length > 0;
}
