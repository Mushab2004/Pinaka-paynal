import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface TokenPayload {
  user_id: number;
  role: string;
  exp?: number;
}

/**
 * Issue an HS256 JWT with the same shape as the old PHP implementation:
 * payload { user_id, role, exp } valid for 24 hours.
 */
export function createToken(userId: number, role: string): string {
  return jwt.sign({ user_id: userId, role }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "24h",
  });
}

/** Verify a raw token string. Throws on any failure. */
export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  if (typeof decoded === "string" || !decoded || typeof decoded.user_id !== "number") {
    throw new Error("Invalid token");
  }
  return decoded as TokenPayload;
}

export function bearerFromHeader(header: string | undefined): string | null {
  const match = /Bearer\s(\S+)/.exec(header ?? "");
  return match ? match[1] : null;
}
