import { Router } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { query, queryOne, execute } from "../config/database";
import { asyncHandler, badRequest, notFound, toInt } from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";

const router = Router();

/**
 * A "seller" is any active user with the seller role. There is no admin
 * approval column in the schema, so role + is_active is the definition the
 * rest of the app already relies on. Ratings are derived from the reviews on
 * that seller's products; sellers with no reviews yet get a NULL rating and
 * the UI shows "No reviews yet".
 */
const SELLER_SELECT = `
  SELECT u.id, u.full_name, u.avatar_url, u.shop_name, u.shop_address, u.phone, u.created_at,
    ap.specialty, ap.story, ap.location, ap.years_of_experience, ap.is_featured,
    (SELECT COUNT(*) FROM products p
       WHERE p.seller_id = u.id AND p.is_active = 1) AS product_count,
    (SELECT ROUND(AVG(sr.rating), 1) FROM store_reviews sr
       WHERE sr.seller_id = u.id) AS rating,
    (SELECT COUNT(*) FROM store_reviews sr2
       WHERE sr2.seller_id = u.id) AS review_count
  FROM users u
  LEFT JOIN artisan_profiles ap ON ap.user_id = u.id
  WHERE u.role = 'seller' AND u.is_active = 1
`;

/** Sellers with reviews first (best rated), then those with none, by activity. */
const SELLER_ORDER =
  "ORDER BY (rating IS NULL) ASC, rating DESC, review_count DESC, ap.is_featured DESC, u.id ASC";

interface SellerRow extends RowDataPacket {
  id: number;
  rating: string | number | null;
  review_count: string | number | null;
  product_count: string | number | null;
  is_featured: number | null;
}

/** Normalize DECIMAL/aggregate values that mysql2 returns as strings. */
function normalizeSeller(row: SellerRow) {
  return {
    ...row,
    is_featured: Boolean(row.is_featured),
    product_count: Number(row.product_count ?? 0),
    review_count: Number(row.review_count ?? 0),
    rating: row.rating === null ? null : Number(row.rating),
  };
}

// GET /sellers/featured  -> top 3 rated sellers for the homepage
router.get(
  "/featured",
  asyncHandler(async (_req, res) => {
    const rows = await query<SellerRow>(`${SELLER_SELECT} ${SELLER_ORDER} LIMIT 3`);
    res.json({ sellers: rows.map(normalizeSeller) });
  })
);

// GET /sellers?search=&specialty=&sort=&page=&limit=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? "").trim();
    const specialty = String(req.query.specialty ?? "").trim();
    const sort = String(req.query.sort ?? "rating").trim();
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
    const offset = (page - 1) * limit;

    let sql = SELLER_SELECT;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (search) {
      conditions.push("(u.full_name LIKE ? OR u.shop_name LIKE ? OR ap.specialty LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (specialty) {
      conditions.push("ap.specialty LIKE ?");
      params.push(`%${specialty}%`);
    }
    if (conditions.length) {
      sql += " AND " + conditions.join(" AND ");
    }

    // count
    const countSql = `SELECT COUNT(*) AS total FROM users u LEFT JOIN artisan_profiles ap ON ap.user_id = u.id WHERE u.role = 'seller' AND u.is_active = 1` +
      (search ? " AND (u.full_name LIKE ? OR u.shop_name LIKE ? OR ap.specialty LIKE ?)" : "") +
      (specialty ? " AND ap.specialty LIKE ?" : "");
    const countParams: unknown[] = [];
    if (search) {
      const like = `%${search}%`;
      countParams.push(like, like, like);
    }
    if (specialty) countParams.push(`%${specialty}%`);
    const countRows = await query(countSql, countParams);
    const total = Number(countRows[0]?.total ?? 0);

    let order = SELLER_ORDER;
    if (sort === "reviews") order = "ORDER BY review_count DESC, (rating IS NULL) ASC, rating DESC, u.id ASC";
    else if (sort === "newest") order = "ORDER BY u.created_at DESC, u.id ASC";
    else order = SELLER_ORDER;

    sql += ` ${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await query<SellerRow>(sql, params);
    res.json({ sellers: rows.map(normalizeSeller), total, page, limit, totalPages: Math.ceil(total / limit) });
  })
);

// GET /sellers/:id  -> store page: one seller plus their active products
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (!id) throw badRequest("Seller ID required");

    const seller = await queryOne<SellerRow>(`${SELLER_SELECT} AND u.id = ?`, [id]);
    if (!seller) throw notFound("Seller not found");

    const products = await query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p
       JOIN categories c ON p.category_id = c.id
       WHERE p.seller_id = ? AND p.is_active = 1
       ORDER BY p.created_at DESC`,
      [id]
    );

    res.json({ seller: normalizeSeller(seller), products });
  })
);

export default router;
