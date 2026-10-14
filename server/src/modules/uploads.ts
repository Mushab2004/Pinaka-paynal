import { Router } from "express";
import multer, { type FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { asyncHandler, badRequest, forbidden } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { env } from "../config/env";

const router = Router();

const allowedTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const uploadDir = path.resolve(env.uploadDir, "products");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = allowedTypes[file.mimetype] ?? path.extname(file.originalname).replace(".", "");
    cb(null, `product_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb: FileFilterCallback) => {
    if (!allowedTypes[file.mimetype]) cb(new Error("Invalid file type. Allowed: JPG, PNG, WebP, GIF"));
    else cb(null, true);
  },
});

router.post(
  "/product",
  requireAuth,
  asyncHandler(async (req, res, next) => {
    if (req.user!.role !== "seller") {
      res.status(403).json({ error: "Seller access required" });
      return;
    }
    upload.single("image")(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No image uploaded" });
        return;
      }
      res.json({ success: true, image_url: `uploads/products/${req.file.filename}` });
    });
  })
);

export default router;
