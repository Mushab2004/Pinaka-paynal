import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";
import { env } from "./env";

/**
 * Single shared connection pool to the EXISTING MySQL database.
 *
 * The schema, table names and column names are unchanged from the PHP
 * implementation - this backend must read and write the same data.
 */
export const pool: Pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4",
  dateStrings: false,
});

/** Run a SELECT and return typed rows. Always uses parameterized queries. */
export async function query<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql, params);
  return rows;
}

/** Run a SELECT and return the first row (or null). */
export async function queryOne<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE and return the result header. */
export async function execute(
  sql: string,
  params: unknown[] = []
): Promise<ResultSetHeader> {
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Run a set of statements inside a single transaction.
 *
 * The callback receives a dedicated connection; use `conn.execute` /
 * `conn.query` inside it. Any thrown error rolls the transaction back and is
 * rethrown so the caller (or the central error handler) can respond.
 */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // rollback best-effort
    }
    throw error;
  } finally {
    conn.release();
  }
}
