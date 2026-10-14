import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the JWT secret exactly like the old PHP API did:
 *   1. JWT_SECRET env var (must be 32+ chars)
 *   2. contents of JWT_SECRET_FILE (or the XAMPP default path), 32+ chars
 *
 * Keeping the same secret means tokens issued by the PHP API before the
 * migration continue to verify, so nobody is forced to sign in again.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (typeof fromEnv === "string" && fromEnv.trim().length >= 32) {
    return fromEnv.trim();
  }

  const secretPath =
    process.env.JWT_SECRET_FILE && process.env.JWT_SECRET_FILE.trim() !== ""
      ? process.env.JWT_SECRET_FILE.trim()
      : "C:\\xampp\\maranao_jwt_secret.txt";

  try {
    const contents = fs.readFileSync(secretPath, "utf8").trim();
    if (contents.length >= 32) return contents;
  } catch {
    // fall through to the error below
  }

  throw new Error(
    "JWT secret not found. Set JWT_SECRET (32+ chars) in server/.env, or create " +
      `${secretPath} containing at least 32 random characters.`
  );
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: intFromEnv(process.env.PORT, 4000),
  db: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: intFromEnv(process.env.DB_PORT, 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "maranao_treasures_db",
  },
  jwtSecret: resolveJwtSecret(),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:8080,http://127.0.0.1:8080")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  uploadDir: path.resolve(__dirname, "..", "..", "..", process.env.UPLOAD_DIR ?? "uploads"),
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
  /** Directory that contains the server/ folder (the project root). */
  projectRoot: path.resolve(__dirname, "..", ".."),
};

export type Env = typeof env;
