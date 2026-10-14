import { Router } from "express";
import { query, queryOne, execute } from "../config/database";
import { asyncHandler, badRequest, forbidden, notFound, toInt } from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";

const router = Router();

// GET /products?category=&search=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const category = String(req.query.category ?? "");
    const search = String(req.query.search ?? "");

    let sql = `SELECT p.*, c.name AS category_name, c.slug AS category_slug, u.full_name AS artisan_name
      FROM products p
      JOIN categories c ON p.category_id = c.id
      JOIN users u ON p.seller_id = u.id
      WHERE p.is_active = 1`;
    const params: unknown[] = [];

    if (category) {
      sql += " AND c.slug = ?";
      params.push(category);
    }
    if (search) {
      sql += " AND (p.name LIKE ? OR p.description LIKE ? OR u.full_name LIKE ?)";
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    sql += " ORDER BY p.created_at DESC";

    const products = await query(sql, params);
    res.json({ products });
  })
);

// GET /products/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (!id) throw badRequest("Product ID required");

    const product = await queryOne(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
        u.full_name AS artisan_name, ap.specialty, ap.story AS artisan_story, ap.location AS artisan_location
       FROM products p
       JOIN categories c ON p.category_id = c.id
       JOIN users u ON p.seller_id = u.id
       LEFT JOIN artisan_profiles ap ON u.id = ap.user_id
       WHERE p.id = ?`,
      [id]
    );
    if (!product) throw notFound("Product not found");

    const images = await query("SELECT * FROM product_images WHERE product_id = ?", [id]);
    const reviews = await query(
      `SELECT r.*, u.full_name AS reviewer_name FROM reviews r
       JOIN users u ON r.user_id = u.id WHERE r.product_id = ? ORDER BY r.created_at DESC LIMIT 10`,
      [id]
    );

    res.json({ product: { ...product, images, reviews_list: reviews } });
  })
);

// GET /api/products/:id/reviews
router.get(
  "/:id/reviews",
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (!id) throw badRequest("Product ID required");

    const exists = await queryOne("SELECT id FROM products WHERE id = ?", [id]);
    if (!exists) throw notFound("Product not found");

    const rows = await query(
      `SELECT r.id, r.product_id, r.user_id, r.rating, r.comment, r.created_at, r.updated_at,
              u.full_name AS reviewer_name, u.avatar_url AS reviewer_avatar
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.product_id = ? ORDER BY r.created_at DESC`,
      [id]
    );

    const aggRows = await query(
      "SELECT rating, COUNT(*) AS cnt FROM reviews WHERE product_id = ? GROUP BY rating",
      [id]
    );
    const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    let total = 0;
    let sum = 0;
    for (const r of aggRows) {
      const rating = Number(r.rating);
      const cnt = Number(r.cnt);
      if (rating >= 1 && rating <= 5) {
        distribution[String(rating)] += cnt;
        total += cnt;
        sum += rating * cnt;
      }
    }

    res.json({
      reviews: rows,
      average_rating: total > 0 ? Math.round((sum / total) * 10) / 10 : null,
      review_count: total,
      distribution,
    });
  })
);

// POST /api/products/:id/reviews
router.post(
  "/:id/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "buyer") throw forbidden("Buyer access required");

    const id = toInt(req.params.id);
    if (!id) throw badRequest("Product ID required");

    const exists = await queryOne("SELECT id FROM products WHERE id = ?", [id]);
    if (!exists) throw notFound("Product not found");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = toInt(body.rating);
    const comment = String(body.comment ?? "").trim();

    if (rating < 1 || rating > 5) throw badRequest("Rating must be between 1 and 5");
    if (comment.length > 2000) throw badRequest("Comment is too long");

    await execute(
      `INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      [id, req.user!.user_id, rating, comment || null]
    );

    await execute(
      `UPDATE products SET rating = (SELECT AVG(rating) FROM reviews WHERE product_id = ?),
        total_reviews = (SELECT COUNT(*) FROM reviews WHERE product_id = ?) WHERE id = ?`,
      [id, id, id]
    );

    res.json({ success: true });
  })
);

export default router;
