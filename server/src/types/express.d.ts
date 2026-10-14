import type { Request } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        user_id: number;
        role: Role;
      };
    }
  }
}

export type Role = "admin" | "seller" | "buyer";

export interface AuthUser {
  user_id: number;
  role: Role;
}

export type AuthedRequest = Request & { user: AuthUser };
