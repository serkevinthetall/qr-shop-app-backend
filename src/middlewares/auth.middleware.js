import { extractBearerToken, verifyAccessToken } from "../services/token.service.js";
import { normalizePartnerId } from "../utils/partner-id.js";

export async function getAuthUser(req) {
  const token = extractBearerToken(req);

  if (!token) {
    return null;
  }

  const user = await verifyAccessToken(token);

  if (!user) {
    return null;
  }

  return {
    ...user,
    partner_id: normalizePartnerId(user.partner_id),
  };
}

export async function requireAuth(req, res, next) {
  try {
    const user = await getAuthUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    req.user = user;
    return next();
  } catch (err) {
    console.error("requireAuth failed:", err.message);
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }
}
