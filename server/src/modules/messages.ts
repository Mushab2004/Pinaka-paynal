import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query, execute } from "../config/database";
import { asyncHandler, badRequest, notFound, forbidden } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { notifyConversationMessage, markConversationNotificationsRead } from "../utils/notifications";
import { pool } from "../config/database";


const router = Router();

// conversations GET
router.get(
  "/conversations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const typeFilter = String(req.query.type ?? "");

    if (role === "admin") {
      const rows = await query<any>(
        `SELECT c.id, c.buyer_id, c.seller_id, c.product_id, c.type, c.last_message_at, c.created_at,
                ub.full_name AS buyer_name, ub.avatar_url AS buyer_avatar,
                us.full_name AS seller_name, us.avatar_url AS seller_avatar,
                p.name AS product_name, p.image_url AS product_image,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) AS unread_count
         FROM conversations c
         JOIN users ub ON c.buyer_id = ub.id
         JOIN users us ON c.seller_id = us.id
         LEFT JOIN products p ON c.product_id = p.id
         WHERE c.type = 'seller_admin'
         ORDER BY c.last_message_at DESC`,
        [userId]
      );
      res.json({ conversations: rows });
      return;
    }

    let sql = `SELECT c.id, c.buyer_id, c.seller_id, c.product_id, c.type, c.last_message_at, c.created_at,
                ub.full_name AS buyer_name, ub.avatar_url AS buyer_avatar,
                us.full_name AS seller_name, us.avatar_url AS seller_avatar,
                p.name AS product_name, p.image_url AS product_image,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) AS unread_count
         FROM conversations c
         JOIN users ub ON c.buyer_id = ub.id
         JOIN users us ON c.seller_id = us.id
         LEFT JOIN products p ON c.product_id = p.id
         WHERE (c.buyer_id = ? OR c.seller_id = ?)`;
    const params: any[] = [userId, userId, userId];

    if (role === "seller" && !typeFilter) {
      sql += " AND c.type IN ('buyer_seller', 'seller_admin')";
    } else if (typeFilter) {
      sql += " AND c.type = ?";
      params.push(typeFilter);
    } else {
      sql += " AND c.type = 'buyer_seller'";
    }
    sql += " ORDER BY c.last_message_at DESC";
    const rows = await query<any>(sql, params);
    res.json({ conversations: rows });
  })
);

// start conversation
router.post(
  "/conversations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const body = req.body ?? {};
    const sellerId = Number.parseInt(String(body.seller_id ?? 0), 10);
    const productId = body.product_id == null ? null : Number.parseInt(String(body.product_id), 10);
    const convType = String(body.type ?? "buyer_seller");

    if (convType === "seller_admin") {
      if (role !== "seller") throw forbidden("Only sellers can start admin chat");
      const admin = await query<any>("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
      if (admin.length === 0) throw notFound("No admin found");
      const adminId = Number(admin[0].id);
      if (adminId === userId) throw badRequest("Cannot message yourself");
      const existing = await query<any>("SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id IS NULL AND type = 'seller_admin'", [userId, adminId]);
      if (existing.length > 0) {
        res.json({ conversation_id: Number(existing[0].id), existing: true });
        return;
      }
      const insert = await execute("INSERT INTO conversations (buyer_id, seller_id, product_id, type) VALUES (?, ?, NULL, 'seller_admin')", [userId, adminId]);
      await execute("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [insert.insertId]);
      res.status(201).json({ conversation_id: insert.insertId, existing: false });
      return;
    }

    if (!sellerId) throw badRequest("Seller ID required");
    if (sellerId === userId) throw badRequest("Cannot message yourself");

    if (productId) {
      const existing = await query<any>("SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id = ? AND type = 'buyer_seller'", [userId, sellerId, productId]);
      if (existing.length > 0) {
        res.json({ conversation_id: Number(existing[0].id), existing: true });
        return;
      }
    } else {
      const existing = await query<any>("SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id IS NULL AND type = 'buyer_seller'", [userId, sellerId]);
      if (existing.length > 0) {
        res.json({ conversation_id: Number(existing[0].id), existing: true });
        return;
      }
    }

    const insert = await execute("INSERT INTO conversations (buyer_id, seller_id, product_id, type) VALUES (?, ?, ?, 'buyer_seller')", [userId, sellerId, productId]);
    await execute("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [insert.insertId]);
    res.status(201).json({ conversation_id: insert.insertId, existing: false });
  })
);

// delete conversation
router.delete(
  "/conversations",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const body = req.body ?? {};
    const conversationId = Number.parseInt(String(body.id ?? 0), 10);
    if (!conversationId) throw badRequest("conversation_id required");
    const c = await query<any>("SELECT buyer_id, seller_id, type FROM conversations WHERE id = ?", [conversationId]);
    if (c.length === 0) throw notFound("Conversation not found");
    const conv = c[0];
    const isMember = Number(conv.buyer_id) === userId || Number(conv.seller_id) === userId;
    const isAdminType = role === "admin" && conv.type === "seller_admin";
    if (!isMember && !isAdminType) throw forbidden("Forbidden");
    await execute("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    await execute("DELETE FROM conversations WHERE id = ?", [conversationId]);
    res.json({ success: true });
  })
);

// GET messages
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const conversationId = Number.parseInt(String(req.query.conversation_id ?? 0), 10);
    if (!conversationId) throw badRequest("conversation_id required");

    const c = await query<any>("SELECT id, buyer_id, seller_id, type FROM conversations WHERE id = ?", [conversationId]);
    if (c.length === 0) throw notFound("Conversation not found");
    const conv = c[0];
    if (!(role === "admin" && conv.type === "seller_admin") && Number(conv.buyer_id) !== userId && Number(conv.seller_id) !== userId) {
      throw forbidden("Forbidden");
    }
    await execute("UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?", [conversationId, userId]);
    await markConversationNotificationsRead(pool, userId, conversationId);
    const rows = await query<any>(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.image_url, m.is_read, m.created_at,
              u.full_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = ? ORDER BY m.id ASC`,
      [conversationId]
    );
    res.json({ messages: rows });
  })
);

// POST message
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;
    const body = req.body ?? {};
    const conversationId = Number.parseInt(String(body.conversation_id ?? 0), 10);
    const messageBody = String(body.body ?? "").trim();
    const imageUrl = String(body.image_url ?? "").trim();
    if (!conversationId) throw badRequest("conversation_id required");
    if (messageBody === "" && imageUrl === "") throw badRequest("Message must have text or an image");
    if (messageBody.length > 2000) throw badRequest("Message too long");

    const c = await query<any>("SELECT id, buyer_id, seller_id, type FROM conversations WHERE id = ?", [conversationId]);
    if (c.length === 0) throw notFound("Conversation not found");
    const conv = c[0];
    if (!(role === "admin" && conv.type === "seller_admin") && Number(conv.buyer_id) !== userId && Number(conv.seller_id) !== userId) {
      throw forbidden("Forbidden");
    }
    const nullImage = imageUrl !== "" ? imageUrl : null;
    const insert = await execute("INSERT INTO messages (conversation_id, sender_id, body, image_url) VALUES (?, ?, ?, ?)", [conversationId, userId, messageBody, nullImage]);
    await execute("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);

    const nameRow = await query<any>("SELECT full_name FROM users WHERE id = ?", [userId]);
    const senderName = nameRow[0]?.full_name ?? "Someone";
    try {
      await notifyConversationMessage(
        pool,
        { id: conv.id, buyer_id: Number(conv.buyer_id), seller_id: Number(conv.seller_id), type: String(conv.type) } as any,
        userId,
        senderName,
        messageBody !== "" ? messageBody : ""
      );
    } catch {}

    res.status(201).json({ success: true, message_id: insert.insertId });
  })
);

// upload image
const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ 
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post(
  "/upload",
  requireAuth,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No image uploaded");
    // move to messages path
    const target = path.join(uploadDir, "messages", req.file.filename);
    fs.mkdirSync(path.join(uploadDir, "messages"), { recursive: true });
    fs.renameSync(req.file.path, target);
    res.json({ success: true, image_url: `/uploads/messages/${req.file.filename}` });
  })
);

export default router;
