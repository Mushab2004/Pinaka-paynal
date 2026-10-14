import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import authRouter from "./modules/auth";
import productsRouter from "./modules/products";
import categoriesRouter from "./modules/categories";
import artisansRouter from "./modules/artisans";
import paymentMethodsRouter from "./modules/paymentMethods";
import sellersRouter from "./modules/sellers";
import sellerRouter from "./modules/seller";
import path from "path";
import notificationsRouter from "./modules/notifications";
import cartRouter from "./modules/cart";
import reviewsRouter from "./modules/reviews";
import ordersRouter from "./modules/orders";
import messagesRouter from "./modules/messages";
import uploadsRouter from "./modules/uploads";
import buyerRouter from "./modules/buyer";
import paymentsRouter from "./modules/payments";
import adminRouter from "./modules/admin";
import storesRouter, { storeReviewsRouter } from "./modules/stores";/**
 * Build the Express app. Routes are mounted under /api so the Vite dev proxy
 * can forward /api -> http://localhost:<port> during the migration, keeping
 * the React client's paths simple.
 */
export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "lanaocrafts-server", env: env.nodeEnv });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/artisans", artisansRouter);
  app.use("/api/payment-methods", paymentMethodsRouter);
  app.use("/api/sellers", sellersRouter);
  app.use("/api/stores", storesRouter);
  app.use("/api/store-reviews", storeReviewsRouter);
  app.use("/api/seller", sellerRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/reviews", reviewsRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api", uploadsRouter);
  app.use("/api/buyer", buyerRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/uploads", express.static(path.resolve(env.uploadDir)));
  app.use("/api/uploads", express.static(path.resolve(env.uploadDir)));

  // Remaining modules (cart, orders, reviews, messages, notifications,
  // payments, buyer, seller, admin, uploads) are mounted here as they land.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
