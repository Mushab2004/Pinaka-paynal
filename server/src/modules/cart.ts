import { Router } from "express";
import { query, execute } from "../config/database";
import { asyncHandler, badRequest, notFound } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import type { RowDataPacket } from "mysql2/promise";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const rows = await query<RowDataPacket & Record<string, unknown>>(
      `SELECT p.*, c.quantity AS quantity, cat.name AS category_name,
              cat.slug AS category_slug, u.full_name AS artisan_name
       FROM cart c
       JOIN products p ON c.product_id = p.id
       JOIN categories cat ON p.category_id = cat.id
       JOIN users u ON p.seller_id = u.id
       WHERE c.user_id = ?`,
      [userId]
    );
    let total = 0;
    const cart = rows.map((item) => {
      const subtotal = Number(item.price) * Number(item.quantity);
      total += subtotal;
      return { ...item, subtotal };
    });
    res.json({ cart, total });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = req.body ?? {};
    const productId = Number.parseInt(String(body.product_id ?? 0), 10);
    const quantity = Number.parseInt(String(body.quantity ?? 1), 10) || 1;
    if (!productId) throw badRequest("Product ID required");

    const product = await query<RowDataPacket & { stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = ? AND is_active = 1",
      [productId]
    );
    if (product.length === 0) throw notFound("Product not found");
    if (Number(product[0].stock_quantity) < quantity) throw badRequest("Insufficient stock");

    await execute(
      `INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [userId, productId, quantity]
    );
    res.json({ success: true, message: "Added to cart" });
  })
);

router.put(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = req.body ?? {};
    const productId = Number.parseInt(String(body.product_id ?? 0), 10);
    const quantity = Number.parseInt(String(body.quantity ?? 1), 10);
    if (!productId || quantity < 1) throw badRequest("Valid product ID and quantity required");

    const product = await query<RowDataPacket & { stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = ?",
      [productId]
    );
    if (product.length === 0) throw notFound("Product not found");
    if (Number(product[0].stock_quantity) < quantity) throw badRequest("Insufficient stock");

    await execute("UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ?", [quantity, userId, productId]);
    res.json({ success: true });
  })
);

router.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const productId = Number.parseInt(String(req.query.product_id ?? 0), 10);
    if (productId) {
      await execute("DELETE FROM cart WHERE user_id = ? AND product_id = ?", [userId, productId]);
    } else {
      await execute("DELETE FROM cart WHERE user_id = ?", [userId]);
    }
    res.json({ success: true });
  })
);

export default router;
