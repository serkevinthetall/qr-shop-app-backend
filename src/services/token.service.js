import jwt from "jsonwebtoken";

export function createToken(payload) {
  return jwt.sign(
    {
      ...payload,
      iat: Math.floor(Date.now() / 1000),
    },
    process.env.APP_SECRET,
    {
      expiresIn: "30d",
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