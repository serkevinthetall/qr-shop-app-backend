import { verifyToken } from "../../services/token.service.js";
import { normalizePartnerId } from "../../utils/partner-id.js";

export function getAppAuthUser(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return null;
  }

  const user = verifyToken(token);

  if (!user || user.role !== "sales_rep") {
    return null;
  }

  return {
    ...user,
    partner_id: normalizePartnerId(user.partner_id),
  };
}

export function requireAppAuth(req, res, next) {
  const user = getAppAuthUser(req);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  req.user = user;
  next();
}
