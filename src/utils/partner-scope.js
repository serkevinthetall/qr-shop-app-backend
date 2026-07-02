import { odooCall } from "../services/odoo.service.js";

export async function getAccountPartnerIds(partnerId) {
  const partners = await odooCall("res.partner", "read", {
    args: [[partnerId], ["parent_id", "commercial_partner_id"]],
  });

  const partner = partners[0];
  const ids = new Set([partnerId]);

  if (partner?.parent_id?.[0]) {
    ids.add(partner.parent_id[0]);
  }

  if (partner?.commercial_partner_id?.[0]) {
    ids.add(partner.commercial_partner_id[0]);
  }

  return [...ids];
}

export async function resolveShippingPartnerId(user, rawAddressId) {
  let requestedId = rawAddressId;

  if (Array.isArray(requestedId)) {
    requestedId = requestedId[0];
  }

  requestedId = Number(requestedId);

  if (!Number.isFinite(requestedId) || requestedId <= 0) {
    return null;
  }

  const accountPartnerIds = await getAccountPartnerIds(user.partner_id);

  if (accountPartnerIds.includes(requestedId)) {
    return requestedId;
  }

  const childAddresses = await odooCall("res.partner", "search_read", {
    domain: [
      ["id", "=", requestedId],
      ["parent_id", "in", accountPartnerIds],
    ],
    fields: ["id"],
    limit: 1,
  });

  if (!childAddresses.length) {
    return null;
  }

  return requestedId;
}

export async function getAccountAddresses(partnerId) {
  const accountPartnerIds = await getAccountPartnerIds(partnerId);

  return odooCall("res.partner", "search_read", {
    domain: [
      "|",
      ["id", "in", accountPartnerIds],
      ["parent_id", "in", accountPartnerIds],
    ],
    fields: [
      "id",
      "name",
      "phone",
      "mobile",
      "street",
      "street2",
      "city",
      "zip",
      "state_id",
      "country_id",
      "type",
      "parent_id",
    ],
    order: "parent_id asc, id asc",
    limit: 100,
  });
}

export async function isManagedChildAddress(addressId, partnerId) {
  const accountPartnerIds = await getAccountPartnerIds(partnerId);

  const addresses = await odooCall("res.partner", "search_read", {
    domain: [
      ["id", "=", addressId],
      ["parent_id", "in", accountPartnerIds],
    ],
    fields: ["id"],
    limit: 1,
  });

  return addresses.length > 0;
}
