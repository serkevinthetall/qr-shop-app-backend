import { success, error } from "../utils/response.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { odooCall } from "../services/odoo.service.js";
import { normalizePhone, getPhoneSearchTail, phonesMatch } from "../utils/phone.js";
import { normalizePartnerId } from "../utils/partner-id.js";
import {
  getAccountAddresses,
  isManagedChildAddress,
} from "../utils/partner-scope.js";

function getOdooError(err) {
  return (
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.response?.data ||
    err.message ||
    "Unknown error"
  );
}

function cleanStateName(value) {
  return String(value || "").replace(/\s*\(.*?\)\s*/g, "").trim();
}

async function resolveStateId(stateInput, countryId) {
  if (!stateInput) return false;

  if (Number.isFinite(Number(stateInput))) {
    return Number(stateInput);
  }

  const states = await odooCall("res.country.state", "search_read", {
    domain: [["country_id", "=", countryId]],
    fields: ["id", "name"],
    limit: 200,
  });

  const wanted = cleanStateName(stateInput).toLowerCase();

  const match = states.find((state) => {
    const name = String(state.name || "").toLowerCase();
    const cleanName = cleanStateName(state.name).toLowerCase();

    return (
      name === String(stateInput).toLowerCase() ||
      cleanName === wanted ||
      name.includes(wanted) ||
      wanted.includes(cleanName)
    );
  });

  return match?.id || false;
}

async function getMyanmarCountryId() {
  const countries = await odooCall("res.country", "search_read", {
    domain: [["code", "=", "MM"]],
    fields: ["id"],
    limit: 1,
  });

  return countries[0]?.id || 156;
}

async function findExistingPartnerWithPhone(phone, excludePartnerIds = []) {
  const searchTail = getPhoneSearchTail(phone);

  if (!searchTail || searchTail.length < 7) {
    return null;
  }

  const partners = await odooCall("res.partner", "search_read", {
    domain: [
      "|",
      ["phone", "ilike", searchTail],
      ["mobile", "ilike", searchTail],
    ],
    fields: ["id", "name", "phone", "mobile"],
    limit: 50,
  });

  const excluded = new Set(
    excludePartnerIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  return (
    partners.find((partner) => {
      if (excluded.has(partner.id)) {
        return false;
      }

      return phonesMatch(phone, partner.phone) || phonesMatch(phone, partner.mobile);
    }) || null
  );
}

export async function getAddressMeta(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const countryId = await getMyanmarCountryId();

    const states = await odooCall("res.country.state", "search_read", {
      domain: [["country_id", "=", countryId]],
      fields: ["id", "name", "code"],
      limit: 200,
    });

    return success(res, {
      country_id: countryId,
      states,
    });
  } catch (err) {
    return error(res, "Failed to get address meta", 500, getOdooError(err));
  }
}

export async function getAddresses(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);
    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const addresses = await getAccountAddresses(partnerId);

    return success(res, { addresses });
  } catch (err) {
    return error(res, "Failed to get addresses", 500, getOdooError(err));
  }
}

export async function createAddress(req, res) {
  try {
    const user = getAuthUser(req);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);

    const {
      name,
      phone,
      street,
      street2,
      city,
      zip,
      state_id,
      state,
      country_id,
    } = req.body;

    if (!name || !street || !city) {
      return error(res, "Name, street and city are required", 400);
    }

    if (!phone) {
      return error(res, "Phone is required", 400);
    }

    const normalizedPhone = normalizePhone(phone);
    const duplicatePartner = await findExistingPartnerWithPhone(normalizedPhone);

    if (duplicatePartner) {
      return error(
        res,
        "This phone number is already used by another contact.",
        400,
        { code: "PHONE_ALREADY_USED" }
      );
    }

    const countryId = country_id ? Number(country_id) : await getMyanmarCountryId();
    const resolvedStateId = state_id
      ? Number(state_id)
      : await resolveStateId(state || city, countryId);

    const createdIds = await odooCall("res.partner", "create", {
      vals_list: [
        {
          parent_id: partnerId,
          type: "delivery",
          name: String(name).trim(),
          phone: normalizedPhone,
          street: street || false,
          street2: street2 || false,
          city: city || false,
          zip: zip || false,
          state_id: resolvedStateId || false,
          country_id: countryId || false,
        },
      ],
    });

    const addressId = Array.isArray(createdIds) ? createdIds[0] : createdIds;

    return success(res, {
      message: "Address created successfully",
      address_id: addressId,
    });
  } catch (err) {
    return error(res, "Failed to create address", 500, getOdooError(err));
  }
}

export async function updateAddress(req, res) {
  try {
    const user = getAuthUser(req);
    const addressId = Number(req.params.id);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);
    if (!addressId) return error(res, "Invalid address ID", 400);

    const isEditable = await isManagedChildAddress(addressId, partnerId);

    if (!isEditable) return error(res, "Address not found", 404);

    const vals = {};

    if (req.body.name !== undefined) vals.name = String(req.body.name).trim();
    if (req.body.phone !== undefined) {
      const normalizedPhone = req.body.phone ? normalizePhone(req.body.phone) : false;

      if (normalizedPhone) {
        const duplicatePartner = await findExistingPartnerWithPhone(normalizedPhone, [addressId]);

        if (duplicatePartner) {
          return error(
            res,
            "This phone number is already used by another contact.",
            400,
            { code: "PHONE_ALREADY_USED" }
          );
        }
      }

      vals.phone = normalizedPhone;
    }
    if (req.body.street !== undefined) vals.street = req.body.street || false;
    if (req.body.street2 !== undefined) vals.street2 = req.body.street2 || false;
    if (req.body.city !== undefined) vals.city = req.body.city || false;
    if (req.body.zip !== undefined) vals.zip = req.body.zip || false;
    if (req.body.state_id !== undefined) vals.state_id = req.body.state_id ? Number(req.body.state_id) : false;
    if (req.body.country_id !== undefined) vals.country_id = req.body.country_id ? Number(req.body.country_id) : false;

    if (!Object.keys(vals).length) {
      return error(res, "No fields to update", 400);
    }

    await odooCall("res.partner", "write", {
      ids: [addressId],
      vals,
    });

    return success(res, {
      message: "Address updated successfully",
    });
  } catch (err) {
    return error(res, "Failed to update address", 500, getOdooError(err));
  }
}

export async function deleteAddress(req, res) {
  try {
    const user = getAuthUser(req);
    const addressId = Number(req.params.id);

    if (!user) return error(res, "Unauthorized", 401);

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) return error(res, "No partner linked to this user", 400);
    if (!addressId) return error(res, "Invalid address ID", 400);

    const isEditable = await isManagedChildAddress(addressId, partnerId);

    if (!isEditable) return error(res, "Address not found", 404);

    await odooCall("res.partner", "write", {
      ids: [addressId],
      vals: {
        active: false,
      },
    });

    return success(res, {
      message: "Address deleted successfully",
    });
  } catch (err) {
    return error(res, "Failed to delete address", 500, getOdooError(err));
  }
}