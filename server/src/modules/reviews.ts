import { Router } from "express";
import { query, execute } from "../config/database";
import { asyncHandler, badRequest } from "../utils/http";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const productId = Number.parseInt(String(req.query.product_id ?? 0), 10);
    if (!productId) throw badRequest("Product ID required");

    const rows = await query(
      `SELECT r.*, u.full_name AS reviewer_name
       FROM reviews r JOIN users u ON r.user_id = u.id
       WHERE r.product_id = ? ORDER BY r.created_at DESC`,
      [productId]
    );
    res.json({ reviews: rows });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const productId = Number.parseInt(String(body.product_id ?? 0), 10);
    const rating = Number.parseInt(String(body.rating ?? 0), 10);
    const comment = String(body.comment ?? "").trim();

    if (!productId || rating < 1 || rating > 5) {
      throw badRequest("Valid product ID and rating (1-5) required");
    }

    await execute(
      `INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      [productId, req.user!.user_id, rating, comment]
    );

    await execute(
      `UPDATE products SET rating = (SELECT AVG(rating) FROM reviews WHERE product_id = ?),
        total_reviews = (SELECT COUNT(*) FROM reviews WHERE product_id = ?) WHERE id = ?`,
      [productId, productId, productId]
    );

    res.json({ success: true });
  })
);

export default router;
