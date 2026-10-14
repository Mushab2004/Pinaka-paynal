import { Router } from "express";
import { query } from "../config/database";
import { pool } from "../config/database";
import { asyncHandler, badRequest } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import {
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from "../utils/notifications";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const limitRaw = Number.parseInt(String(req.query.limit ?? "20"), 10);
    const limit = limitRaw < 1 || limitRaw > 50 ? 20 : limitRaw;
    const rows = await query(
      `SELECT id, user_id, type, title, body, link, related_id, is_read, created_at
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${limit}`,
      [userId]
    );
    const count = await unreadNotificationCount(pool, userId);
    res.json({ notifications: rows, unread_count: count });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = req.body ?? {};
    const action = String(body.action ?? "");

    if (action === "mark_read") {
      const id = Number.parseInt(String(body.id ?? 0), 10);
      if (!id) throw badRequest("id is required");
      const ok = await markNotificationRead(pool, userId, id);
      if (!ok) {
        res.status(404).json({ error: "Notification not found" });
        return;
      }
      res.json({ success: true });
      return;
    }

    if (action === "mark_all") {
      await markAllNotificationsRead(pool, userId);
      res.json({ success: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  })
);

export default router;
