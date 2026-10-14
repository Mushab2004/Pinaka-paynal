import { Router } from "express";
import { query } from "../config/database";
import { asyncHandler } from "../utils/http";

const router = Router();

// GET /artisans  (existing endpoint, unchanged behaviour)
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const artisans = await query(
      `SELECT u.id, u.full_name, u.avatar_url, ap.specialty, ap.story, ap.location, ap.years_of_experience, ap.is_featured
       FROM artisan_profiles ap
       JOIN users u ON ap.user_id = u.id
       WHERE u.is_active = 1
       ORDER BY ap.is_featured DESC, ap.years_of_experience DESC`
    );
    res.json({ artisans });
  })
);

export default router;
