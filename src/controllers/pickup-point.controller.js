import { success, error } from "../utils/response.js";
import { logServerError } from "../utils/safe-client-error.js";
import { getAuthUser } from "../middlewares/auth.middleware.js";
import { listActivePickupPoints } from "../utils/pickup-point.js";

/**
 * GET /api/pickup-points
 * Lists Active Odoo pickup points for checkout Self Pickup.
 * Additive — old apps never call this route.
 */
export async function getPickupPoints(req, res) {
  try {
    const user = await getAuthUser(req);

    if (!user) {
      return error(res, "Unauthorized", 401);
    }

    const pickup_points = await listActivePickupPoints();

    return success(res, {
      message: "Pickup points",
      pickup_points,
    });
  } catch (err) {
    logServerError("Could not load pickup points", err);
    return error(res, "Could not load pickup points", 500);
  }
}
