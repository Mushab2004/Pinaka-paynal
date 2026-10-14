import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * An error that should be turned into a JSON response with a specific status
 * code. The message becomes the `error` field, matching the PHP API's
 * `{ "error": "..." }` shape that the React client already understands.
 */
export class HttpError extends Error {
  status: number;
  extra?: Record<string, unknown>;

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(400, message, extra);
export const unauthorized = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(401, message, extra);
export const forbidden = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(403, message, extra);
export const notFound = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(404, message, extra);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(409, message, extra);

/**
 * Wrap an async route handler so any rejected promise is forwarded to the
 * Express error handler instead of crashing the process.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Parse an integer from a query/body value, returning 0 when not numeric. */
export function toInt(value: unknown): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Keep only digits (mirrors the PHP `preg_replace('/\D+/', '', ...)`). */
export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}
