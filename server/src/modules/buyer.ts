import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, queryOne, execute } from "../config/database";
import { asyncHandler, badRequest, notFound, toInt } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import type { RowDataPacket } from "mysql2/promise";

const router = Router();

router.use(requireAuth);

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

// ==================== PROFILE ====================

// GET /api/buyer/profile
router.get(
  "/profile",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const user = await queryOne<Row>(
      "SELECT id, full_name, email, role, phone, address, avatar_url, created_at FROM users WHERE id = ?",
      [userId]
    );
    if (!user) throw notFound("User not found");
    res.json({ user });
  })
);

// PUT /api/buyer/profile
router.put(
  "/profile",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.action === "change_password") {
      const currentPassword = String(body.current_password ?? "");
      const newPassword = String(body.new_password ?? "");
      if (newPassword.length < 6) {
        throw badRequest("New password must be at least 6 characters");
      }

      const row = await queryOne<{ password_hash: string } & RowDataPacket>(
        "SELECT password_hash FROM users WHERE id = ?",
        [userId]
      );
      if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
        throw badRequest("Current password is incorrect");
      }

      const hashed = await bcrypt.hash(newPassword, 10);
      await execute("UPDATE users SET password_hash = ? WHERE id = ?", [hashed, userId]);
      res.json({ success: true, message: "Password changed successfully" });
      return;
    }

    const fullName = String(body.full_name ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    const address = String(body.address ?? "").trim();

    if (!fullName) throw badRequest("Full name is required");

    await execute(
      "UPDATE users SET full_name = ?, phone = ?, address = ? WHERE id = ?",
      [fullName, phone, address, userId]
    );

    const updatedUser = await queryOne<Row>(
      "SELECT id, full_name, email, role, phone, address, avatar_url FROM users WHERE id = ?",
      [userId]
    );

    res.json({ success: true, message: "Profile updated", user: updatedUser });
  })
);

router.all("/profile", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

// ==================== WISHLIST ====================

// GET /api/buyer/wishlist
router.get(
  "/wishlist",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const items = await query<Row>(
      `SELECT w.id, w.product_id, w.created_at, p.name, p.price, p.image_url, p.stock_quantity, c.name as category_name, c.slug as category_slug
       FROM wishlist w
       JOIN products p ON w.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`,
      [userId]
    );
    res.json({ wishlist: items });
  })
);

// POST /api/buyer/wishlist
router.post(
  "/wishlist",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const productId = toInt(body.product_id);
    if (!productId) throw badRequest("Product ID required");

    const existing = await queryOne<Row>(
      "SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?",
      [userId, productId]
    );
    if (existing) throw badRequest("Already in wishlist");

    await execute("INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)", [userId, productId]);
    res.status(201).json({ success: true, message: "Added to wishlist" });
  })
);

// DELETE /api/buyer/wishlist
router.delete(
  "/wishlist",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const productId = toInt(body.product_id ?? (req.query as Record<string, unknown>).product_id);
    if (!productId) throw badRequest("Product ID required");

    await execute("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", [userId, productId]);
    res.json({ success: true, message: "Removed from wishlist" });
  })
);

router.all("/wishlist", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

// ==================== PAYMENTS ====================

// GET /api/buyer/payments
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const payments = await query<Row>(
      `SELECT p.*, o.order_number, o.status as order_status, o.total_amount, o.shipping_fee
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE o.user_id = ?
       ORDER BY p.created_at DESC`,
      [userId]
    );
    res.json({ payments });
  })
);

router.all("/payments", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

export default router;