import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/http";
import { env } from "../config/env";

/** 404 handler for unmatched routes. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}

/**
 * Central error handler. Every response is JSON with an `error` string, which
 * is the contract the React client expects (see src/lib/api.ts).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
    return;
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  // Never leak internals in production; keep them visible while developing.
  console.error("[error]", err);
  const body: Record<string, unknown> = { error: "Internal server error" };
  if (!env.isProduction) body.detail = message;

  res.status(500).json(body);
}

/** Standard 405 response body, matching the PHP endpoints. */
export function methodNotAllowed(res: Response) {
  res.status(405).json({ error: "Method not allowed" });
}
