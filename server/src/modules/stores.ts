import { Router } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { query, queryOne, execute } from "../config/database";
import { asyncHandler, badRequest, forbidden, notFound, toInt } from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";

const router = Router();

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

const STORE_SELLER_SELECT = `
  SELECT u.id, u.full_name, u.avatar_url, u.shop_name, u.shop_address, u.phone, u.created_at,
    ap.specialty, ap.story, ap.location, ap.years_of_experience, ap.is_featured,
    (SELECT COUNT(*) FROM products p WHERE p.seller_id = u.id AND p.is_active = 1) AS product_count,
    (SELECT ROUND(AVG(sr.rating), 1) FROM store_reviews sr WHERE sr.seller_id = u.id) AS rating,
    (SELECT COUNT(*) FROM store_reviews sr2 WHERE sr2.seller_id = u.id) AS review_count
  FROM users u
  LEFT JOIN artisan_profiles ap ON ap.user_id = u.id
  WHERE u.role = 'seller' AND u.is_active = 1
`;

function normalizeStoreSeller(row: Row) {
  return {
    ...row,
    is_featured: Boolean(row.is_featured),
    product_count: Number(row.product_count ?? 0),
    review_count: Number(row.review_count ?? 0),
    rating: row.rating === null ? null : Number(row.rating),
  };
}

async function getStoreSeller(id: number, includeInactive = false) {
  let sql = `${STORE_SELLER_SELECT} AND u.id = ?`;
  if (includeInactive) {
    sql = sql.replace("AND u.is_active = 1", "");
  }
  return queryOne<Row>(sql, [id]);
}

async function storeExists(sellerId: number) {
  const seller = await queryOne<Row>(
    "SELECT id FROM users WHERE id = ? AND role = 'seller'",
    [sellerId]
  );
  return !!seller;
}

async function productsBySeller(sellerId: number) {
  return query<Row>(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p
     JOIN categories c ON p.category_id = c.id
     WHERE p.seller_id = ? AND p.is_active = 1
     ORDER BY p.created_at DESC`,
    [sellerId]
  );
}

async function reviewsBySeller(sellerId: number) {
  const rows = await query<Row>(
    `SELECT sr.id, sr.seller_id, sr.user_id, sr.product_id, sr.rating, sr.comment,
            sr.created_at, sr.updated_at,
            u.full_name AS reviewer_name, u.avatar_url AS reviewer_avatar,
            p.name AS product_name
     FROM store_reviews sr
     JOIN users u ON u.id = sr.user_id
     LEFT JOIN products p ON p.id = sr.product_id
     WHERE sr.seller_id = ?
     ORDER BY sr.created_at DESC`,
    [sellerId]
  );
  return rows;
}

async function reviewAggregate(sellerId: number) {
  const rows = await query<Row>(
    `SELECT rating, COUNT(*) AS cnt FROM store_reviews WHERE seller_id = ? GROUP BY rating`,
    [sellerId]
  );
  const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const rating = Number(r.rating);
    const cnt = Number(r.cnt);
    if (rating >= 1 && rating <= 5) {
      distribution[String(rating)] += cnt;
      total += cnt;
      sum += rating * cnt;
    }
  }
  return {
    average_rating: total > 0 ? Math.round((sum / total) * 10) / 10 : null,
    review_count: total,
    distribution,
  };
}

// GET /api/stores/me  (current seller's store)
router.get(
  "/me",
  requireAuth,
  authorize("seller"),
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const seller = await getStoreSeller(sellerId, true);
    if (!seller) throw notFound("Seller not found");
    const products = await productsBySeller(sellerId);
    const reviews = await reviewsBySeller(sellerId);
    const agg = await reviewAggregate(sellerId);
    res.json({ seller: normalizeStoreSeller(seller), products, reviews, ...agg });
  })
);

// GET /api/stores/me/products
router.get(
  "/me/products",
  requireAuth,
  authorize("seller"),
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const products = await productsBySeller(sellerId);
    res.json({ products });
  })
);

// GET /api/stores/:sellerId
router.get(
  "/:sellerId",
  asyncHandler(async (req, res) => {
    const sellerId = toInt(req.params.sellerId);
    if (!sellerId) throw badRequest("Seller ID required");

    const seller = await getStoreSeller(sellerId);
    if (!seller) throw notFound("Store not found");

    const products = await productsBySeller(sellerId);
    const agg = await reviewAggregate(sellerId);
    res.json({ seller: normalizeStoreSeller(seller), products, ...agg });
  })
);

// GET /api/stores/:sellerId/products
router.get(
  "/:sellerId/products",
  asyncHandler(async (req, res) => {
    const sellerId = toInt(req.params.sellerId);
    if (!sellerId) throw badRequest("Seller ID required");
    if (!(await storeExists(sellerId))) throw notFound("Store not found");
    const products = await productsBySeller(sellerId);
    res.json({ products });
  })
);

// GET /api/stores/:sellerId/reviews
router.get(
  "/:sellerId/reviews",
  asyncHandler(async (req, res) => {
    const sellerId = toInt(req.params.sellerId);
    if (!sellerId) throw badRequest("Seller ID required");
    if (!(await storeExists(sellerId))) throw notFound("Store not found");
    const reviews = await reviewsBySeller(sellerId);
    const agg = await reviewAggregate(sellerId);
    res.json({ reviews, ...agg });
  })
);

// POST /api/stores/:sellerId/reviews
router.post(
  "/:sellerId/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "buyer") throw forbidden("Buyer access required");

    const sellerId = toInt(req.params.sellerId);
    if (!sellerId) throw badRequest("Seller ID required");
    if (!(await storeExists(sellerId))) throw notFound("Store not found");

    if (sellerId === req.user!.user_id) {
      throw forbidden("You cannot review your own store");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = toInt(body.rating);
    const comment = String(body.comment ?? "").trim();
    const productIdRaw = body.product_id;
    const productId = productIdRaw ? toInt(productIdRaw) : null;

    if (rating < 1 || rating > 5) throw badRequest("Rating must be between 1 and 5");
    if (comment.length > 2000) throw badRequest("Comment is too long");

    if (productId) {
      const p = await queryOne<Row>(
        "SELECT id FROM products WHERE id = ? AND seller_id = ?",
        [productId, sellerId]
      );
      if (!p) throw badRequest("Invalid product reference");
    }

    await execute(
      `INSERT INTO store_reviews (seller_id, user_id, product_id, rating, comment)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), product_id = VALUES(product_id)`,
      [sellerId, req.user!.user_id, productId, rating, comment || null]
    );

    res.json({ success: true });
  })
);

// ---- Store review update/delete (mounted under /api/store-reviews) ----
export const storeReviewsRouter = Router();

storeReviewsRouter.put(
  "/:reviewId",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "buyer") throw forbidden("Buyer access required");

    const reviewId = toInt(req.params.reviewId);
    if (!reviewId) throw badRequest("Review ID required");

    const existing = await queryOne<Row>(
      "SELECT id, seller_id, user_id FROM store_reviews WHERE id = ?",
      [reviewId]
    );
    if (!existing) throw notFound("Review not found");
    if (Number(existing.user_id) !== req.user!.user_id) throw forbidden("You can only edit your own review");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = body.rating !== undefined ? toInt(body.rating) : null;
    const comment = body.comment !== undefined ? String(body.comment).trim() : undefined;
    const productIdRaw = body.product_id;
    const productId = productIdRaw === undefined ? undefined : (productIdRaw ? toInt(productIdRaw) : null);

    if (rating !== null && (rating < 1 || rating > 5)) throw badRequest("Rating must be between 1 and 5");

    const sellerId = Number(existing.seller_id);

    if (productId !== undefined && productId !== null) {
      const p = await queryOne<Row>(
        "SELECT id FROM products WHERE id = ? AND seller_id = ?",
        [productId, sellerId]
      );
      if (!p) throw badRequest("Invalid product reference");
    }

    const fields: string[] = [];
    const params: unknown[] = [];
    if (rating !== null) {
      fields.push("rating = ?");
      params.push(rating);
    }
    if (comment !== undefined) {
      fields.push("comment = ?");
      params.push(comment || null);
    }
    if (productId !== undefined) {
      fields.push("product_id = ?");
      params.push(productId);
    }
    if (fields.length === 0) throw badRequest("Nothing to update");

    await execute(
      `UPDATE store_reviews SET ${fields.join(", ")} WHERE id = ?`,
      [...params, reviewId]
    );

    res.json({ success: true });
  })
);

storeReviewsRouter.delete(
  "/:reviewId",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "buyer") throw forbidden("Buyer access required");

    const reviewId = toInt(req.params.reviewId);
    if (!reviewId) throw badRequest("Review ID required");

    const existing = await queryOne<Row>(
      "SELECT id, user_id FROM store_reviews WHERE id = ?",
      [reviewId]
    );
    if (!existing) throw notFound("Review not found");
    if (Number(existing.user_id) !== req.user!.user_id) throw forbidden("You can only delete your own review");

    await execute("DELETE FROM store_reviews WHERE id = ?", [reviewId]);
    res.json({ success: true });
  })
);

export default router;
