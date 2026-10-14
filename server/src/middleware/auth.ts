import type { NextFunction, Request, Response } from "express";
import { queryOne } from "../config/database";
import type { RowDataPacket } from "mysql2/promise";
import { unauthorized, forbidden } from "../utils/http";
import { bearerFromHeader, verifyToken } from "../utils/jwt";
import type { Role } from "../types/express";

interface UserRow extends RowDataPacket {
  id: number;
  role: Role;
  is_active: number;
}

/**
 * Require a valid Bearer token.
 *
 * Exactly like the PHP `verifyToken()`: the role is re-read from the database
 * on every request, so a deactivated, deleted or demoted account loses access
 * immediately instead of keeping its old permissions until the token expires.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearerFromHeader(req.headers.authorization);
    if (!token) throw unauthorized("Token required");

    let payload;
    try {
      payload = verifyToken(token);
    } catch (error) {
      const name = (error as Error).name;
      throw unauthorized(name === "TokenExpiredError" ? "Token expired" : "Invalid token");
    }

    const user = await queryOne<UserRow>(
      "SELECT id, role, is_active FROM users WHERE id = ?",
      [payload.user_id]
    );

    if (!user) throw unauthorized("Invalid token");
    if (Number(user.is_active) !== 1) throw forbidden("Account is inactive");

    req.user = { user_id: user.id, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
}

/** Restrict a route to one or more roles. Must run after `requireAuth`. */
export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized("Token required"));
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(forbidden(roleMessage(roles[0])));
    }
    next();
  };
}

/** Human-readable message matching the PHP endpoints' wording. */
function roleMessage(role: Role): string {
  switch (role) {
    case "admin":
      return "Admin access required";
    case "seller":
      return "Seller access required";
    case "buyer":
      return "Buyer access required";
    default:
      return "Forbidden";
  }
}
