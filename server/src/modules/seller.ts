import { Router } from "express";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "mysql2/promise";
import { query, queryOne, execute, withTransaction, pool } from "../config/database";
import { asyncHandler, badRequest, conflict, forbidden, notFound, toInt } from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";
import { notifyUser } from "../utils/notifications";
import * as gcash from "../utils/gcash";

const router = Router();

// All seller endpoints require an authenticated seller account, mirroring the
// PHP seller/*.php files which call verifyToken() + role === 'seller'.
router.use(requireAuth, authorize("seller"));

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

/** Check whether the seller currently has an active (non-expired) subscription. */
async function hasActiveSubscription(sellerId: number): Promise<boolean> {
  const sub = await queryOne<Row>(
    "SELECT id, status, end_date FROM seller_subscriptions WHERE seller_id = ? AND status = 'Active' ORDER BY created_at DESC LIMIT 1",
    [sellerId]
  );
  if (!sub) return false;
  if (sub.end_date) {
    const end = new Date(sub.end_date as string | Date).getTime();
    if (!Number.isNaN(end) && end < Date.now()) {
      await execute("UPDATE seller_subscriptions SET status = 'Expired', updated_at = NOW() WHERE id = ?", [Number(sub.id)]);
      return false;
    }
  }
  return true;
}

// GET /api/seller/dashboard
router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;

    const totalProductsRow = await queryOne<Row>(
      "SELECT COUNT(*) as total FROM products WHERE seller_id = ?",
      [sellerId]
    );
    const totalProducts = Number(totalProductsRow?.total ?? 0);

    const totalOrdersRow = await queryOne<Row>(
      `SELECT COUNT(DISTINCT o.id) as total
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       WHERE p.seller_id = ?`,
      [sellerId]
    );
    const totalOrders = Number(totalOrdersRow?.total ?? 0);

    const totalSalesRow = await queryOne<Row>(
      `SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) as total
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       WHERE p.seller_id = ? AND o.status != 'cancelled'`,
      [sellerId]
    );
    const totalSales = Number(totalSalesRow?.total ?? 0);

    const recentOrders = await query<Row>(
      `SELECT DISTINCT o.*, u.full_name as customer_name
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       JOIN users u ON o.user_id = u.id
       WHERE p.seller_id = ?
       ORDER BY o.created_at DESC
       LIMIT 5`,
      [sellerId]
    );

    res.json({
      total_products: totalProducts,
      total_orders: totalOrders,
      total_sales: totalSales,
      recent_orders: recentOrders,
    });
  })
);

// GET /api/seller/products
router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const products = await query<Row>(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       JOIN categories c ON p.category_id = c.id
       WHERE p.seller_id = ?
       ORDER BY p.created_at DESC`,
      [sellerId]
    );
    res.json({ products });
  })
);

// POST /api/seller/products
router.post(
  "/products",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    if (!(await hasActiveSubscription(sellerId))) {
      throw forbidden("Active subscription required to add products. Please subscribe first.");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const cultural_background = String(body.cultural_background ?? "").trim();
    const price = Number(body.price ?? 0);
    const stock = toInt(body.stock_quantity ?? 0);
    const category_id = toInt(body.category_id ?? 0);
    const image_url = String(body.image_url ?? "").trim();

    if (!name || !price || !category_id) {
      throw badRequest("Name, price, and category are required");
    }

    const result = await execute(
      "INSERT INTO products (seller_id, category_id, name, description, cultural_background, price, stock_quantity, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [sellerId, category_id, name, description, cultural_background, price, stock, image_url]
    );
    res.status(201).json({ success: true, product_id: result.insertId });
  })
);

// PUT /api/seller/products
router.put(
  "/products",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    if (!(await hasActiveSubscription(sellerId))) {
      throw forbidden("Active subscription required to edit products. Please subscribe first.");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id ?? 0);
    if (!id) throw badRequest("Product ID required");

    const check = await queryOne<Row>("SELECT id FROM products WHERE id = ? AND seller_id = ?", [id, sellerId]);
    if (!check) throw notFound("Product not found");

    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const cultural_background = String(body.cultural_background ?? "").trim();
    const price = Number(body.price ?? 0);
    const stock = toInt(body.stock_quantity ?? 0);
    const category_id = toInt(body.category_id ?? 0);
    const image_url = String(body.image_url ?? "").trim();
    const is_active = toInt(body.is_active ?? 1);

    await execute(
      "UPDATE products SET category_id=?, name=?, description=?, cultural_background=?, price=?, stock_quantity=?, image_url=?, is_active=?, updated_at=NOW() WHERE id=? AND seller_id=?",
      [category_id, name, description, cultural_background, price, stock, image_url, is_active, id, sellerId]
    );
    res.json({ success: true });
  })
);

// DELETE /api/seller/products
router.delete(
  "/products",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = toInt(body.id ?? 0);
    if (!id) throw badRequest("Product ID required");

    const result = await execute("DELETE FROM products WHERE id = ? AND seller_id = ?", [id, sellerId]);
    if (result.affectedRows > 0) {
      res.json({ success: true });
    } else {
      throw notFound("Product not found or not owned");
    }
  })
);

// GET /api/seller/orders
router.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const orders = await query<Row>(
      `SELECT DISTINCT o.*, u.full_name as customer_name, u.email as customer_email
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       JOIN users u ON o.user_id = u.id
       WHERE p.seller_id = ?
       ORDER BY o.created_at DESC`,
      [sellerId]
    );

    const itemStmt = async (oid: number) =>
      query<Row>(
        `SELECT oi.*, p.name, p.image_url
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ? AND p.seller_id = ?`,
        [oid, sellerId]
      );

    const subStmt = async (oid: number) => {
      const r = await queryOne<Row>("SELECT COALESCE(SUM(subtotal),0) s FROM order_items WHERE order_id = ? AND seller_id = ?", [oid, sellerId]);
      return Number(r?.s ?? 0);
    };

    const payStmt = async (oid: number) => {
      const payment = await queryOne<Row>(
        `SELECT pay.id, pay.amount, pay.status, pay.payment_method, pay.transaction_reference,
                pay.conversation_id, pay.rejection_reason, pay.paid_at, pay.created_at
         FROM payments pay
         WHERE pay.order_id = ? AND pay.seller_id = ?
         LIMIT 1`,
        [oid, sellerId]
      );
      if (payment) {
        payment.id = Number(payment.id);
        payment.amount = Number(payment.amount);
        payment.conversation_id = payment.conversation_id === null ? null : Number(payment.conversation_id);
      }
      return payment ?? null;
    };

    const out: unknown[] = [];
    for (const order of orders) {
      const oid = Number(order.id);
      const items = await itemStmt(oid);
      const seller_subtotal = await subStmt(oid);
      const payment = await payStmt(oid);
      out.push({ ...order, items, seller_subtotal, payment });
    }

    res.json({ orders: out });
  })
);

// PUT /api/seller/orders
router.put(
  "/orders",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderId = toInt(body.order_id ?? 0);
    const status = String(body.status ?? "").trim();

    if (!orderId || !status) throw badRequest("Order ID and status required");

    const validStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
    if (!validStatuses.includes(status)) throw badRequest("Invalid status");

    const orderRow = await queryOne<Row>(
      `SELECT o.id, o.user_id, o.status, o.order_number, o.cancel_requested FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       WHERE o.id = ? AND p.seller_id = ?
       LIMIT 1`,
      [orderId, sellerId]
    );
    if (!orderRow) throw notFound("Order not found");

    if (status === "cancelled" && Number(orderRow.cancel_requested) !== 1) {
      throw conflict("The buyer has not requested a cancellation for this order.");
    }

    if (["processing", "shipped", "delivered"].includes(status)) {
      const counts = await queryOne<Row>(
        "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS completed FROM payments WHERE order_id = ? AND seller_id = ?",
        [orderId, sellerId]
      );
      const total = Number(counts?.total ?? 0);
      const completed = Number(counts?.completed ?? 0);
      if (total > 0 && completed < total) {
        throw conflict("Payment must be confirmed before you can move this order to '" + status + "'.", {
          payment_status: completed > 0 ? "partially_paid" : "awaiting_confirmation",
        });
      }
    }

    await execute("UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?", [status, orderId]);

    if (status === "cancelled" && orderRow.status !== "cancelled") {
      await execute(
        `UPDATE products p JOIN order_items oi ON oi.product_id = p.id
         SET p.stock_quantity = p.stock_quantity + oi.quantity
         WHERE oi.order_id = ?`,
        [orderId]
      );
      await notifyUser(
        pool,
        Number(orderRow.user_id),
        "order",
        "Order " + orderRow.order_number + " cancelled",
        "The seller confirmed your cancellation request. If you already sent a GCash payment, arrange the refund in your chat with them.",
        "/account/orders",
        orderId
      );
    }

    res.json({ success: true, status });
  })
);

// GET /api/seller/profile
router.get(
  "/profile",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const user = await queryOne<Row>(
      "SELECT id, full_name, email, role, phone, address, shop_name, shop_address, gcash_number, avatar_url FROM users WHERE id = ?",
      [userId]
    );
    if (!user) throw notFound("User not found");

    const artisan = await queryOne<Row>("SELECT specialty, story, location FROM artisan_profiles WHERE user_id = ?", [userId]);
    (user as Record<string, unknown>).artisan_profile = artisan ?? null;
    res.json({ user });
  })
);

// PUT /api/seller/profile
router.put(
  "/profile",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const action = String(body.action ?? "update_profile");

    if (action === "change_password") {
      const current = String(body.current_password ?? "");
      const neu = String(body.new_password ?? "");
      if (!current || !neu) throw badRequest("Both passwords required");
      if (neu.length < 6) throw badRequest("New password must be at least 6 characters");

      const row = await queryOne<{ password_hash: string } & RowDataPacket>(
        "SELECT password_hash FROM users WHERE id = ?",
        [userId]
      );
      if (!row || !(await bcrypt.compare(current, row.password_hash))) {
        throw badRequest("Current password is incorrect");
      }

      const hashed = await bcrypt.hash(neu, 10);
      await execute("UPDATE users SET password_hash = ? WHERE id = ?", [hashed, userId]);
      res.json({ success: true, message: "Password updated" });
      return;
    }

    const full_name = String(body.full_name ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    const address = String(body.address ?? "").trim();
    const shop_name = String(body.shop_name ?? "").trim();
    const shop_address = String(body.shop_address ?? "").trim();
    const gcash_number = String(body.gcash_number ?? "").trim();

    if (!full_name) throw badRequest("Name is required");
    if (full_name.length > 100) throw badRequest("Name is too long (max 100 characters)");
    if (shop_name.length > 150) throw badRequest("Shop name is too long (max 150 characters)");

    const phoneDigits = phone.replace(/\D+/g, "");
    const gcashDigits = gcash_number.replace(/\D+/g, "");

    if (role === "seller") {
      if (!shop_name) throw badRequest("Shop name is required");
      if (!shop_address) throw badRequest("Shop address is required");
      if (gcashDigits.length < 10 || gcashDigits.length > 15) {
        throw badRequest("A valid GCash number is required");
      }
      if (phoneDigits === "" || phoneDigits.length < 7 || phoneDigits.length > 15) {
        throw badRequest("A valid contact number is required");
      }
    }

    await execute(
      "UPDATE users SET full_name=?, phone=?, address=?, shop_name=?, shop_address=?, gcash_number=? WHERE id=?",
      [full_name, phoneDigits, address, shop_name, shop_address, gcashDigits, userId]
    );

    if (role === "seller") {
      const specialty = String(body.specialty ?? "").trim();
      const story = String(body.story ?? "").trim();
      const location = String(body.location ?? "").trim();

      const check = await queryOne<Row>("SELECT id FROM artisan_profiles WHERE user_id = ?", [userId]);
      if (check) {
        await execute("UPDATE artisan_profiles SET specialty=?, story=?, location=? WHERE user_id=?", [specialty, story, location, userId]);
      } else {
        await execute("INSERT INTO artisan_profiles (user_id, specialty, story, location) VALUES (?, ?, ?, ?)", [userId, specialty, story, location]);
      }
    }

    res.json({ success: true, message: "Profile updated" });
  })
);

// GET /api/seller/subscription
router.get(
  "/subscription",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const sub = await queryOne<Row>(
      `SELECT ss.*, au.full_name AS approved_by_name,
        (SELECT c.id FROM conversations c
         WHERE c.buyer_id = ss.seller_id AND c.product_id IS NULL AND c.type = 'seller_admin'
         ORDER BY c.id ASC LIMIT 1) AS conversation_id
       FROM seller_subscriptions ss
       LEFT JOIN users au ON ss.approved_by = au.id
       WHERE ss.seller_id = ?
       ORDER BY ss.created_at DESC
       LIMIT 1`,
      [sellerId]
    );

    if (sub && sub.status === "Active" && sub.end_date) {
      const end = new Date(sub.end_date as string | Date).getTime();
      if (!Number.isNaN(end) && end < Date.now()) {
        await execute("UPDATE seller_subscriptions SET status = 'Expired', updated_at = NOW() WHERE id = ?", [Number(sub.id)]);
        (sub as Record<string, unknown>).status = "Expired";
      }
    }

    const hasActive = !!(sub && sub.status === "Active");

    let gcashNumber = "";
    if (sub && sub.status === "Pending") {
      gcashNumber = await gcash.platformGcashNumber(pool);
    }

    if (sub && (sub as Record<string, unknown>).conversation_id !== null && (sub as Record<string, unknown>).conversation_id !== undefined) {
      (sub as Record<string, unknown>).conversation_id = Number((sub as Record<string, unknown>).conversation_id);
    }

    const price = await gcash.platformSubscriptionPrice(pool);

    res.json({
      subscription: sub ?? null,
      has_active_subscription: hasActive,
      gcash_number: gcashNumber,
      subscription_price: price,
    });
  })
);

// POST /api/seller/subscription
router.post(
  "/subscription",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;

    const existing = await queryOne<Row>(
      "SELECT id, status FROM seller_subscriptions WHERE seller_id = ? AND status IN ('Pending', 'Active') ORDER BY created_at DESC LIMIT 1",
      [sellerId]
    );
    if (existing) {
      if (existing.status === "Active") {
        throw badRequest("You already have an active subscription");
      }
      throw badRequest("You already have a pending subscription request");
    }

    const gcashNumber = await gcash.platformGcashNumber(pool);
    if (gcashNumber === "") {
      throw conflict("Subscription payments are not configured yet. Please message the admin to set up the GCash number.");
    }

    const price = await gcash.platformSubscriptionPrice(pool);

    let subId = 0;
    let conversationId: number | null = null;

    await withTransaction(async (conn) => {
      const [result] = await conn.execute(
        "INSERT INTO seller_subscriptions (seller_id, status, payment_status, payment_amount) VALUES (?, 'Pending', 'pending', ?)",
        [sellerId, price]
      );
      subId = (result as { insertId: number }).insertId;

      await gcash.logSubscriptionPaymentEvent(
        conn,
        subId,
        sellerId,
        "seller",
        "submitted",
        null,
        "pending",
        "Subscription request created with a " + gcash.gcashMoney(price) + " payment.",
        null
      );

      conversationId = await gcash.ensureSellerAdminConversation(conn, sellerId);
      if (conversationId !== null && conversationId > 0) {
        await gcash.postSystemMessage(conn, conversationId, sellerId, gcash.buildSubscriptionPaymentInquiry(price, gcashNumber));
      }
    });

    res.status(201).json({
      success: true,
      subscription_id: subId,
      payment_status: "pending",
      payment_amount: price,
      gcash_number: gcashNumber,
      conversation_id: conversationId,
    });
  })
);

// POST /api/seller/start-admin-chat
router.post(
  "/start-admin-chat",
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;

    const admin = await queryOne<Row>("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
    if (!admin) throw notFound("No admin user found");

    const adminId = Number(admin.id);
    if (adminId === sellerId) throw badRequest("Cannot message yourself");

    const existing = await queryOne<Row>(
      "SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id IS NULL AND type = 'seller_admin'",
      [sellerId, adminId]
    );

    if (existing) {
      res.json({ conversation_id: Number(existing.id), existing: true });
      return;
    }

    const result = await execute(
      "INSERT INTO conversations (buyer_id, seller_id, product_id, type) VALUES (?, ?, NULL, 'seller_admin')",
      [sellerId, adminId]
    );
    res.status(201).json({ conversation_id: result.insertId, existing: false });
  })
);

export default router;
