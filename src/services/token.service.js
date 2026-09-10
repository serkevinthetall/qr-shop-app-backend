import jwt from "jsonwebtoken";

import { isAccessTokenRevoked, newTokenId } from "./token-revoke.store.js";

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "30d";

export function createToken(payload) {
  return jwt.sign(
    {
      ...payload,
      jti: newTokenId(),
      iat: Math.floor(Date.now() / 1000),
    },
    process.env.APP_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.APP_SECRET);
  } catch {
    return null;
  }
}

/**
 * Verify signature/expiry and reject tokens revoked by logout.
 */
export async function verifyAccessToken(token) {
  const payload = verifyToken(token);

  if (!payload) {
    return null;
  }

  if (await isAccessTokenRevoked(token)) {
    return null;
  }

  return payload;
}

export function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.replace("Bearer ", "").trim();
}
