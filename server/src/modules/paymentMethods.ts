import { Router } from "express";
import { query } from "../config/database";
import { asyncHandler } from "../utils/http";

const router = Router();

// GET /payment-methods  (public, active only)
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const paymentMethods = await query(
      "SELECT id, name, code, description, icon FROM payment_methods WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
    );
    res.json({ payment_methods: paymentMethods });
  })
);

export default router;
