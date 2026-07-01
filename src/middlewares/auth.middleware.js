import { verifyToken } from "../services/token.service.js";

export function getAuthUser(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return null;
  }

  return verifyToken(token);
}

export function requireAuth(req, res, next) {
  const user = getAuthUser(req);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  req.user = user;
  next();
}