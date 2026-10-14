import { Router } from "express";
import { query } from "../config/database";
import { asyncHandler } from "../utils/http";

const router = Router();

// GET /categories
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const categories = await query("SELECT * FROM categories ORDER BY name");
    res.json({ categories });
  })
);

export default router;
