import { Router } from "express";
import { query, queryOne, execute, withTransaction, pool } from "../config/database";
import {
  asyncHandler,
  badRequest,
  notFound,
  conflict,
  toInt,
} from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";
import { logAdminAudit } from "../utils/notifications";
import * as gcash from "../utils/gcash";
import type { RowDataPacket } from "mysql2/promise";

const router = Router();

// Every admin endpoint requires a valid session. Individual endpoints below
// add the stricter role checks (settings GET is deliberately readable by any
// authenticated user, matching the PHP implementation).
router.use(requireAuth);

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];

const SUBSCRIPTION_STATUSES = ["Pending", "Active", "Expired", "Rejected"];

interface DbRow extends RowDataPacket {
  [key: string]: unknown;
}

function boundedSearch(value: unknown, max = 80): string {
  const text = String(value ?? "").trim();
  if ([...text].length > max) throw badRequest("Search term too long");
  return text;
}

function requireLimit(value: unknown, max = 500): number {
  const raw = String(value ?? "").trim();
  if (raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw badRequest(`limit must be between 1 and ${max}`);
  }
  return n;
}

function resolveOffset(req: { query: Record<string, unknown> }, limit: number): number {
  let offset = 0;
  if (req.query.offset !== undefined) {
    const raw = Number.parseInt(String(req.query.offset ?? ""), 10);
    if (Number.isFinite(raw) && raw >= 0) offset = raw;
  }
  const page = toInt(req.query.page);
  if (page > 1 && (req.query.offset === undefined || offset === 0)) {
    offset = (page - 1) * limit;
  }
  return offset;
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

router.get(
  "/users",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const limit = requireLimit(req.query.limit);
    const totalRows = await query("SELECT COUNT(*) AS n FROM users");
    const total = Number((totalRows as DbRow[])[0]?.n ?? 0);

    const sql = "SELECT id, full_name, email, role, phone, address, avatar_url, is_active, created_at FROM users ORDER BY created_at DESC";
    const params: unknown[] = [];
    let rows: unknown[];
    if (limit > 0) {
      const offset = resolveOffset(req, limit);
      const [r] = await (pool as any).query(`${sql} LIMIT ? OFFSET ?`, [limit, offset]);
      rows = r;
    } else {
      const [r] = await (pool as any).query(sql, params);
      rows = r;
    }

    res.json({
      users: rows,
      total,
      page: limit > 0 ? Math.floor(resolveOffset(req, limit) / limit) + 1 : 1,
      limit,
      totalPages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1,
    });
  })
);

router.put(
  "/users",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = toInt(body.user_id);
    if (!userId) throw badRequest("user_id required");

    const before = await queryOne<DbRow>(
      "SELECT role, is_active FROM users WHERE id = ?",
      [userId]
    );
    if (!before) throw notFound("User not found");

    const updates: string[] = [];
    const params: unknown[] = [];
    const types: string[] = [];
    const changes: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(body, "role") && body.role !== null && body.role !== undefined) {
      updates.push("role = ?");
      params.push(body.role);
      types.push("s");
      changes.role = { from: before.role, to: body.role };
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active") && body.is_active !== null && body.is_active !== undefined) {
      updates.push("is_active = ?");
      params.push(Number(body.is_active) ? 1 : 0);
      types.push("i");
      changes.is_active = { from: Number(before.is_active ?? 0), to: Number(body.is_active) ? 1 : 0 };
    }

    if (updates.length === 0) throw badRequest("Nothing to update");

    const adminId = req.user!.user_id;
    await withTransaction(async (conn) => {
      await (conn as any).execute(
        `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
        [...params, userId]
      );
    });

    await logAdminAudit(adminId, "user.update", "user", userId, changes);
    res.json({ success: true, message: "User updated" });
  })
);

router.delete(
  "/users",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = toInt(body.user_id);
    if (!userId) throw badRequest("user_id required");

    const adminId = req.user!.user_id;
    if (userId === adminId) throw badRequest("Cannot delete yourself");

    const target = await queryOne<DbRow>(
      "SELECT full_name, email, role FROM users WHERE id = ?",
      [userId]
    );
    if (!target) throw notFound("User not found");

    const linkedRows = await query(
      "SELECT (SELECT COUNT(*) FROM orders WHERE user_id = ?) + (SELECT COUNT(*) FROM order_items WHERE seller_id = ?) AS linked",
      [userId, userId]
    );
    const linked = Number((linkedRows as DbRow[])[0]?.linked ?? 0);

    if (linked > 0) {
      await logAdminAudit(adminId, "user.delete_blocked", "user", userId, {
        email: target.email,
        linked_orders: linked,
      });
      throw conflict("This account has order history and can't be deleted without erasing records. Deactivate it instead (toggle its status).", {
        hint: "deactivate",
      });
    }

    await withTransaction(async (conn) => {
      await conn.execute("DELETE FROM users WHERE id = ?", [userId]);
    });

    await logAdminAudit(adminId, "user.delete", "user", userId, {
      email: target.email,
      role: target.role,
    });
    res.json({ success: true, message: "User deleted" });
  })
);

/* ------------------------------------------------------------------ */
/* Sellers                                                            */
/* ------------------------------------------------------------------ */

router.get(
  "/sellers",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const sellerId = toInt(req.query.id);
    if (sellerId) {
      const seller = await queryOne<DbRow>(
        `SELECT u.id, u.full_name, u.email, u.phone, u.address, u.shop_name, u.shop_address,
                u.gcash_number, u.avatar_url, u.is_active, u.created_at,
                (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id) AS product_count,
                (SELECT COUNT(DISTINCT oi.order_id) FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   WHERE oi.seller_id = u.id AND o.status <> 'cancelled') AS order_count,
                (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   WHERE oi.seller_id = u.id AND o.status <> 'cancelled') AS sold_items,
                (SELECT COALESCE(SUM(oi.subtotal), 0) FROM order_items oi
                   JOIN orders o ON o.id = oi.order_id
                   WHERE oi.seller_id = u.id AND o.status <> 'cancelled') AS total_sales
         FROM users u WHERE u.id = ? AND u.role = 'seller'`,
        [sellerId]
      );
      if (!seller) throw notFound("Seller not found");

      const products = await query(
        "SELECT id, name, price, stock_quantity, image_url, is_active, created_at FROM products WHERE seller_id = ? ORDER BY created_at DESC",
        [sellerId]
      );
      const sales = await query(
        `SELECT oi.id, oi.quantity, oi.unit_price, oi.subtotal, oi.created_at,
                o.order_number, o.status AS order_status, p.name AS product_name
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         WHERE oi.seller_id = ? AND o.status <> 'cancelled'
         ORDER BY oi.created_at DESC LIMIT 50`,
        [sellerId]
      );
      const payments = await query(
        `SELECT pay.*, o.order_number FROM payments pay
         JOIN orders o ON o.id = pay.order_id
         WHERE pay.seller_id = ?
         ORDER BY pay.created_at DESC LIMIT 20`,
        [sellerId]
      );

      res.json({ seller: { ...seller, products, sales, payments } });
      return;
    }

    const search = boundedSearch(req.query.search, 80);
    const sql = `SELECT u.id, u.full_name, u.email, u.phone, u.shop_name, u.gcash_number, u.avatar_url,
               u.is_active, u.created_at,
               (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id) AS product_count,
               (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                  JOIN orders o ON o.id = oi.order_id
                  WHERE oi.seller_id = u.id AND o.status <> 'cancelled') AS sold_items,
               (SELECT COALESCE(SUM(oi.subtotal), 0) FROM order_items oi
                  JOIN orders o ON o.id = oi.order_id
                  WHERE oi.seller_id = u.id AND o.status <> 'cancelled') AS total_sales
        FROM users u WHERE u.role = 'seller'`;

    let rows: unknown[];
    if (search !== "") {
      const like = `%${search}%`;
      const [r] = await (pool as any).query(
        `${sql} AND (u.shop_name LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)`,
        [like, like, like]
      );
      rows = r;
    } else {
      const [r] = await (pool as any).query(sql, []);
      rows = r;
    }
    res.json({ sellers: rows });
  })
);

/* ------------------------------------------------------------------ */
/* Categories                                                         */
/* ------------------------------------------------------------------ */

router.get(
  "/categories",
  authorize("admin"),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      "SELECT c.*, COUNT(p.id) as product_count FROM categories c LEFT JOIN products p ON c.id = p.category_id GROUP BY c.id ORDER BY c.name"
    );
    res.json({ categories: rows });
  })
);

router.post(
  "/categories",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "");
    const slug = String(body.slug ?? "");
    const description = body.description == null ? "" : String(body.description);
    if (!name.trim() || !slug.trim()) throw badRequest("Name and slug required");

    const adminId = req.user!.user_id;
    let categoryId = 0;
    try {
      await withTransaction(async (conn) => {
        const [result] = await (conn as any).execute(
          "INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)",
          [name, slug, description]
        );
        categoryId = Number((result as any).insertId ?? 0);
      });
    } catch {
      throw badRequest("Category already exists or DB error");
    }
    await logAdminAudit(adminId, "category.create", "category", categoryId, { name, slug });
    res.json({ success: true, category_id: categoryId, message: "Category created" });
  })
);

router.put(
  "/categories",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id);
    if (!id) throw badRequest("Category id required");

    const name = String(body.name ?? "");
    const slug = String(body.slug ?? "");
    const description = body.description == null ? "" : String(body.description);

    const adminId = req.user!.user_id;
    await withTransaction(async (conn) => {
      await (conn as any).execute(
        "UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?",
        [name, slug, description, id]
      );
    });
    await logAdminAudit(adminId, "category.update", "category", id, { name, slug });
    res.json({ success: true, message: "Category updated" });
  })
);

router.delete(
  "/categories",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id);
    if (!id) throw badRequest("Category id required");

    const check = await query("SELECT COUNT(*) as cnt FROM products WHERE category_id = ?", [id]);
    const count = Number((check as DbRow[])[0]?.cnt ?? 0);
    if (count > 0) throw badRequest(`Cannot delete category with ${count} product(s). Reassign products first.`);

    const adminId = req.user!.user_id;
    await withTransaction(async (conn) => {
      await conn.execute("DELETE FROM categories WHERE id = ?", [id]);
    });
    await logAdminAudit(adminId, "category.delete", "category", id, {});
    res.json({ success: true, message: "Category deleted" });
  })
);

/* ------------------------------------------------------------------ */
/* Orders                                                             */
/* ------------------------------------------------------------------ */

router.get(
  "/orders",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const orderId = toInt(req.query.id);
    if (orderId) {
      const orderRows = await query(
        `SELECT o.*, u.id AS buyer_id, u.full_name AS buyer_name, u.email AS buyer_email
         FROM orders o JOIN users u ON o.user_id = u.id
         WHERE o.id = ?`,
        [orderId]
      );
      if ((orderRows as DbRow[]).length === 0) throw notFound("Order not found");
      const order = (orderRows as DbRow[])[0] as Record<string, unknown>;

      const items = await query(
        `SELECT oi.*, p.name, p.image_url, u.full_name AS seller_name FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN users u ON u.id = oi.seller_id
         WHERE oi.order_id = ?`,
        [orderId]
      );
      const payments = await query(
        `SELECT pay.*, u.full_name AS seller_name
         FROM payments pay LEFT JOIN users u ON u.id = pay.seller_id
         WHERE pay.order_id = ?
         ORDER BY pay.seller_id IS NULL, pay.seller_id`,
        [orderId]
      );
      res.json({ order: { ...order, items, payments } });
      return;
    }

    const status = String(req.query.status ?? "").trim();
    const search = boundedSearch(req.query.search, 80);
    const buyerId = toInt(req.query.buyer);
    const limit = requireLimit(req.query.limit);

    const ORDER_STATUSES_LOCAL = ORDER_STATUSES;
    if (status !== "" && !ORDER_STATUSES_LOCAL.includes(status)) {
      throw badRequest("Invalid status filter");
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== "") {
      where.push("o.status = ?");
      params.push(status);
    }
    if (buyerId > 0) {
      where.push("o.user_id = ?");
      params.push(buyerId);
    }
    if (search !== "") {
      where.push("(o.order_number LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    let sql = `SELECT o.id, o.order_number, o.total_amount, o.shipping_fee, o.status, o.payment_method,
               o.payment_status, o.created_at, o.user_id AS buyer_id,
               u.full_name AS buyer_name, u.email AS buyer_email,
               (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
        FROM orders o JOIN users u ON o.user_id = u.id${whereSql}
        ORDER BY o.created_at DESC`;
    if (limit > 0) {
      const offset = resolveOffset(req, limit);
      params.push(limit, offset);
      sql += " LIMIT ? OFFSET ?";
    }

    const rows = await pool.query(sql, params).then((r: any) => (Array.isArray(r) ? r[0] : r));

    const result: Record<string, unknown> = { orders: rows };

    if (limit > 0) {
      const countParams = params.slice(0, params.length - (limit > 0 ? 2 : 0));
      const countSql = `SELECT COUNT(*) AS n FROM orders o JOIN users u ON o.user_id = u.id${whereSql}`;
      const countRows = await pool.query(countSql, countParams).then((r: any) => (Array.isArray(r) ? r[0] : r));
      result.orders_total = Number((countRows as DbRow[])[0]?.n ?? 0);
      const buyerCountRows = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'buyer'");
      result.buyers_total = Number((buyerCountRows as DbRow[])[0]?.n ?? 0);
    }

    // Every buyer account, limited only when pagination is requested.
    let buyersSql = `SELECT u.id, u.full_name, u.email, u.avatar_url,
            COUNT(o.id) AS order_count, MAX(o.created_at) AS last_order_at
     FROM users u LEFT JOIN orders o ON o.user_id = u.id
     WHERE u.role = 'buyer'
     GROUP BY u.id, u.full_name, u.email, u.avatar_url
     ORDER BY u.full_name ASC`;
    if (limit > 0) buyersSql += ` LIMIT ${limit}`;
    const buyerRows = await pool.query(buyersSql, []).then((r: any) => (Array.isArray(r) ? r[0] : r));
    result.buyers = buyerRows;

    res.json(result);
  })
);

/* ------------------------------------------------------------------ */
/* Payment methods                                                    */
/* ------------------------------------------------------------------ */

router.get(
  "/payment-methods",
  authorize("admin"),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT pm.*, (SELECT COUNT(*) FROM payments p WHERE p.payment_method = pm.code) as usage_count
       FROM payment_methods pm ORDER BY pm.sort_order ASC, pm.id ASC`
    );
    res.json({ payment_methods: rows });
  })
);

router.post(
  "/payment-methods",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const code = String(body.code ?? "").trim();
    const description = body.description == null ? "" : String(body.description).trim();
    const icon = body.icon == null ? "" : String(body.icon).trim();
    const isActive = body.is_active === undefined ? 1 : (Number(body.is_active) ? 1 : 0);
    const sortOrder = body.sort_order === undefined ? 0 : Number(body.sort_order) || 0;

    if (!name || !code) throw badRequest("Name and code are required");

    const adminId = req.user!.user_id;
    let id = 0;
    await withTransaction(async (conn) => {
      const [result] = await (conn as any).execute(
        "INSERT INTO payment_methods (name, code, description, icon, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        [name, code, description, icon, isActive, sortOrder]
      );
      id = Number((result as any).insertId ?? 0);
    });
    await logAdminAudit(adminId, "payment_method.create", "payment_method", id, { name, code });
    res.status(201).json({ success: true, id });
  })
);

router.put(
  "/payment-methods",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id);
    if (!id) throw badRequest("ID required");

    const fields: string[] = [];
    const params: unknown[] = [];
    const changes: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      fields.push("name = ?");
      params.push(String(body.name ?? "").trim());
      changes.name = body.name;
    }
    if (Object.prototype.hasOwnProperty.call(body, "code")) {
      fields.push("code = ?");
      params.push(String(body.code ?? "").trim());
      changes.code = body.code;
    }
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      fields.push("description = ?");
      params.push(body.description == null ? "" : String(body.description).trim());
      changes.description = body.description;
    }
    if (Object.prototype.hasOwnProperty.call(body, "icon")) {
      fields.push("icon = ?");
      params.push(body.icon == null ? "" : String(body.icon).trim());
      changes.icon = body.icon;
    }
    if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
      fields.push("is_active = ?");
      params.push(Number(body.is_active) ? 1 : 0);
      changes.is_active = body.is_active;
    }
    if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
      fields.push("sort_order = ?");
      params.push(Number(body.sort_order) || 0);
      changes.sort_order = body.sort_order;
    }

    if (fields.length === 0) throw badRequest("No fields to update");

    const adminId = req.user!.user_id;
    await withTransaction(async (conn) => {
      await (conn as any).execute(`UPDATE payment_methods SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
    });
    await logAdminAudit(adminId, "payment_method.update", "payment_method", id, changes);
    res.json({ success: true });
  })
);

router.delete(
  "/payment-methods",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id);
    if (!id) throw badRequest("ID required");

    const adminId = req.user!.user_id;
    await withTransaction(async (conn) => {
      await conn.execute("DELETE FROM payment_methods WHERE id = ?", [id]);
    });
    await logAdminAudit(adminId, "payment_method.delete", "payment_method", id, {});
    res.json({ success: true });
  })
);

/* ------------------------------------------------------------------ */
/* Subscriptions                                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/subscriptions",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    await execute(
      "UPDATE seller_subscriptions SET status = 'Expired', updated_at = NOW() WHERE status = 'Active' AND end_date IS NOT NULL AND end_date <> '' AND end_date <= CURDATE()"
    );

    const filter = String(req.query.status ?? "").trim();
    if (filter !== "" && !SUBSCRIPTION_STATUSES.includes(filter)) {
      throw badRequest("Invalid status filter");
    }

    const limit = requireLimit(req.query.limit);

    const whereSql = filter !== "" ? " WHERE ss.status = ?" : "";
    const params: unknown[] = [];
    if (filter !== "") params.push(filter);

    const countRows = await query(
      `SELECT COUNT(*) AS n FROM seller_subscriptions ss JOIN users u ON ss.seller_id = u.id${whereSql}`,
      params
    );
    const total = Number((countRows as DbRow[])[0]?.n ?? 0);

    let sql = `SELECT ss.*, u.full_name AS seller_name, u.email AS seller_email, au.full_name AS approved_by_name
               FROM seller_subscriptions ss
               JOIN users u ON ss.seller_id = u.id
               LEFT JOIN users au ON ss.approved_by = au.id
               ${whereSql}
               ORDER BY ss.created_at DESC`;
    const queryParams = [...params];
    if (limit > 0) {
      const offset = resolveOffset(req, limit);
      queryParams.push(limit, offset);
      sql += " LIMIT ? OFFSET ?";
    }
    const rows = await query(sql, queryParams);

    const page = limit > 0 ? Math.floor(resolveOffset(req, limit) / limit) + 1 : 1;
    res.json({ subscriptions: rows, total, page, limit, totalPages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1 });
  })
);

router.put(
  "/subscriptions",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subId = toInt(body.id);
    const action = String(body.action ?? "").trim();
    if (!subId || !action) throw badRequest("id and action required");

    const adminId = req.user!.user_id;

    if (action === "reject") {
      const reason = String(body.reason ?? "").trim();
      const sub = await queryOne<DbRow>(
        "SELECT * FROM seller_subscriptions WHERE id = ?",
        [subId]
      );
      if (!sub) throw notFound("Subscription not found");
      if (String(sub.status) !== "Pending") {
        throw badRequest("Only pending subscriptions can be rejected");
      }

      await withTransaction(async (conn) => {
        await (conn as any).execute(
          "UPDATE seller_subscriptions SET status = 'Rejected', rejection_reason = ?, approved_by = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?",
          [reason, adminId, subId]
        );
      });
      await logAdminAudit(adminId, "subscription.reject", "subscription", subId, {
        seller_id: Number(sub.seller_id ?? 0),
        reason,
      });
      res.json({ success: true, message: "Subscription rejected" });
      return;
    }

    if (action === "expire") {
      const sub = await queryOne<DbRow>(
        "SELECT status, seller_id FROM seller_subscriptions WHERE id = ?",
        [subId]
      );
      if (!sub) throw notFound("Subscription not found");

      await withTransaction(async (conn) => {
        await (conn as any).execute(
          "UPDATE seller_subscriptions SET status = 'Expired', updated_at = NOW() WHERE id = ?",
          [subId]
        );
      });
      await logAdminAudit(adminId, "subscription.expire", "subscription", subId, {
        seller_id: Number(sub.seller_id ?? 0),
      });
      res.json({ success: true, message: "Subscription marked as expired" });
      return;
    }

    throw badRequest("Invalid action. Use: reject or expire");
  })
);

router.delete(
  "/subscriptions",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subId = toInt(body.id);
    if (!subId) throw badRequest("id required");

    const adminId = req.user!.user_id;
    const sub = await queryOne<DbRow>(
      "SELECT status, seller_id FROM seller_subscriptions WHERE id = ?",
      [subId]
    );
    if (!sub) throw notFound("Subscription not found");

    if (String(sub.status) === "Active") {
      await logAdminAudit(adminId, "subscription.delete_blocked", "subscription", subId, {
        seller_id: Number(sub.seller_id ?? 0),
      });
      throw conflict("Active subscriptions can't be deleted - mark it as expired first, then delete");
    }

    await withTransaction(async (conn) => {
      await (conn as any).execute(
        "DELETE FROM notifications WHERE type = 'subscription' AND related_id = ?",
        [subId]
      );
      await conn.execute("DELETE FROM seller_subscriptions WHERE id = ?", [subId]);
    });

    await logAdminAudit(adminId, "subscription.delete", "subscription", subId, {
      seller_id: Number(sub.seller_id ?? 0),
      status: sub.status,
    });
    res.json({ success: true, message: "Subscription deleted" });
  })
);

/* ------------------------------------------------------------------ */
/* Audit                                                              */
/* ------------------------------------------------------------------ */

router.get(
  "/audit",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    let limit = toInt(req.query.limit ?? 100);
    if (limit < 1) limit = 100;
    if (limit > 500) limit = 500;

    const action = String(req.query.action ?? "").trim();
    const params: unknown[] = [];
    let sql = `SELECT l.*, u.full_name AS admin_name, u.email AS admin_email
               FROM admin_audit_log l
               LEFT JOIN users u ON l.admin_id = u.id`;
    if (action !== "") {
      sql += " WHERE l.action = ?";
      params.push(action);
    }
    sql += " ORDER BY l.id DESC LIMIT ?";
    params.push(limit);

    const rows = await query(sql, params) as DbRow[];
    for (const row of rows) {
      const details = row.details;
      if (typeof details === "string" && details !== "") {
        try {
          row.details = JSON.parse(details);
        } catch {
          // keep raw string
        }
      }
    }

    res.json({ entries: rows, count: rows.length });
  })
);

/* ------------------------------------------------------------------ */
/* Reports                                                            */
/* ------------------------------------------------------------------ */

router.get(
  "/reports",
  authorize("admin"),
  asyncHandler(async (_req, res) => {
    const userStats = await query("SELECT role, COUNT(*) as count FROM users GROUP BY role");
    const productCounts = await query("SELECT COUNT(*) as count FROM products");
    const activeProductCounts = await query("SELECT COUNT(*) as count FROM products WHERE is_active = 1");
    const orderStatsRows = await query("SELECT COUNT(*) as total_orders, COALESCE(SUM(total_amount), 0) as total_revenue FROM orders");
    const ordersByStatus = await query("SELECT status, COUNT(*) as count FROM orders GROUP BY status");
    const recentOrders = await query(
      "SELECT o.id, o.total_amount, o.status, o.created_at, u.full_name as buyer_name FROM orders o JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT 10"
    );
    const monthlyRevenue = await query(
      "SELECT DATE_FORMAT(created_at, '%Y-%m') as month, SUM(total_amount) as revenue, COUNT(*) as orders FROM orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH) GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month"
    );
    const topProducts = await query(
      "SELECT p.name, SUM(oi.quantity) as total_sold, SUM(oi.subtotal) as total_revenue FROM order_items oi JOIN products p ON oi.product_id = p.id GROUP BY oi.product_id ORDER BY total_sold DESC LIMIT 5"
    );
    const categories = await query("SELECT COUNT(*) as count FROM categories");

    res.json({
      user_stats: userStats,
      total_products: Number((productCounts as DbRow[])[0]?.count ?? 0),
      active_products: Number((activeProductCounts as DbRow[])[0]?.count ?? 0),
      total_orders: Number((orderStatsRows as DbRow[])[0]?.total_orders ?? 0),
      total_revenue: Number((orderStatsRows as DbRow[])[0]?.total_revenue ?? 0),
      orders_by_status: ordersByStatus,
      recent_orders: recentOrders,
      monthly_revenue: monthlyRevenue,
      top_products: topProducts,
      total_categories: Number((categories as DbRow[])[0]?.count ?? 0),
    });
  })
);

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const rows = await query("SELECT `key`, `value` FROM platform_settings");
    const settings: Record<string, string> = {};
    for (const row of rows as DbRow[]) {
      settings[String(row.key)] = String(row.value ?? "");
    }
    res.json({
      settings: {
        gcash_number: settings.gcash_number ?? "",
        subscription_price: settings.subscription_price ?? "299.00",
      },
    });
  })
);

router.put(
  "/settings",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const adminId = req.user!.user_id;

    const touched = { value: false };
    const changes: Record<string, unknown> = {};

    await withTransaction(async (conn) => {
      // Snapshot current values for audit.
      if (Object.prototype.hasOwnProperty.call(body, "gcash_number")) {
        const [rows] = await (conn as any).query(
          "SELECT `value` FROM platform_settings WHERE `key` = ?",
          ["gcash_number"]
        );
        const current = Array.isArray(rows) ? rows[0] : rows;
        changes.gcash_number = { from: current?.value ?? null };
      }
      if (Object.prototype.hasOwnProperty.call(body, "subscription_price")) {
        const [rows] = await (conn as any).query(
          "SELECT `value` FROM platform_settings WHERE `key` = ?",
          ["subscription_price"]
        );
        const current = Array.isArray(rows) ? rows[0] : rows;
        changes.subscription_price = { from: current?.value ?? null };
      }

      if (Object.prototype.hasOwnProperty.call(body, "gcash_number")) {
        const gcashNumber = String(body.gcash_number ?? "").trim();
        const digits = gcash.gcashDigits(gcashNumber);
        if (gcashNumber !== "" && digits === "") {
          throw badRequest("GCash number must be 10 to 15 digits", { field: "gcash_number" });
        }
        const value = digits;
        await (conn as any).execute(
          "INSERT INTO platform_settings (`key`, `value`) VALUES ('gcash_number', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
          [value]
        );
        changes.gcash_number = { ...(changes.gcash_number as Record<string, unknown>), to: value };
        touched.value = true;
      }

      if (Object.prototype.hasOwnProperty.call(body, "subscription_price")) {
        const raw = String(body.subscription_price ?? "").trim();
        if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) {
          throw badRequest("Subscription price must be a number like 299 or 149.50", {
            field: "subscription_price",
          });
        }
        const num = Number.parseFloat(raw);
        if (!Number.isFinite(num) || num < 1 || num > 100000) {
          throw badRequest("Subscription price must be between ₱1.00 and ₱100,000.00", {
            field: "subscription_price",
          });
        }
        const value = num.toFixed(2);
        await (conn as any).execute(
          "INSERT INTO platform_settings (`key`, `value`) VALUES ('subscription_price', ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
          [value]
        );
        changes.subscription_price = {
          ...(changes.subscription_price as Record<string, unknown>),
          to: value,
        };
        touched.value = true;
      }

      if (!touched.value) throw badRequest("No settings provided");
    });

    await logAdminAudit(adminId, "settings.update", "platform_settings", 0, changes);

    const rows = await query("SELECT `key`, `value` FROM platform_settings");
    const settings: Record<string, string> = {};
    for (const row of rows as DbRow[]) {
      settings[String(row.key)] = String(row.value ?? "");
    }
    res.json({
      success: true,
      settings: {
        gcash_number: settings.gcash_number ?? "",
        subscription_price: settings.subscription_price ?? "299.00",
      },
    });
  })
);

export default router;