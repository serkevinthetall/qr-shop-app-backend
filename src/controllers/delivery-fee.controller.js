import { success, error } from "../utils/response.js";
import { logServerError } from "../utils/safe-client-error.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { normalizePartnerId } from "../utils/partner-id.js";
import { quoteDeliveryFee } from "../utils/delivery-fee.js";
import {
  getAccountAddresses,
  resolveShippingPartnerId,
} from "../utils/partner-scope.js";

/**
 * GET /api/delivery-fee?zip=11241
 * GET /api/delivery-fee?address_id=123
 *
 * Returns waive + fee quote for cart preview. Old apps ignore this route.
 */
export async function getDeliveryFee(req, res) {
  try {
    const user = await getAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    const partnerId = normalizePartnerId(user.partner_id);

    if (!partnerId) {
      return error(res, "No partner linked to this user", 400);
    }

    let addressId = normalizePartnerId(
      req.query.address_id ?? req.query.addressId
    );
    const zip = req.query.zip ?? req.query.postal ?? "";

    // If no zip/address given, use the account's first delivery address (main).
    if (!String(zip || "").trim() && !addressId) {
      const addresses = await getAccountAddresses(partnerId);
      addressId = addresses[0]?.id ? normalizePartnerId(addresses[0].id) : null;
    }

    if (addressId) {
      const allowedId = await resolveShippingPartnerId(
        { partner_id: partnerId },
        addressId
      );

      if (!allowedId) {
        return error(res, "Selected delivery address is invalid", 400);
      }

      addressId = allowedId;
    }

    const quote = await quoteDeliveryFee({
      partnerId,
      zip,
      addressId,
    });

    return success(res, {
      message: "Delivery fee quote",
      ...quote,
    });
  } catch (err) {
    logServerError("Could not resolve delivery fee", err);
    return error(res, "Could not resolve delivery fee", 500);
  }
}
