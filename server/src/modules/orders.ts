import { Router } from "express";
import { query, execute, withTransaction, pool } from "../config/database";
import { asyncHandler, badRequest, notFound } from "../utils/http";
import { requireAuth } from "../middleware/auth";
import { notifyUser } from "../utils/notifications";
import * as gcash from "../utils/gcash";

const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const orders = await query<any>(
      `SELECT o.*, EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'pending') AS needs_payment
       FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC`,
      [userId]
    );
    const out: any[] = [];
    for (const order of orders) {
      const items = await query(
        `SELECT oi.*, p.name, p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`,
        [order.id]
      );
      out.push({ ...order, items });
    }
    res.json({ orders: out });
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const orderId = Number.parseInt(req.params.id, 10);
    if (!orderId) throw badRequest("Order ID required");
    const order = await query<any>("SELECT * FROM orders WHERE id = ? AND user_id = ?", [orderId, userId]);
    if (order.length === 0) throw notFound("Order not found");
    const items = await query(
      `SELECT oi.*, p.name, p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`,
      [orderId]
    );
    const payment = await query("SELECT * FROM payments WHERE order_id = ?", [orderId]);
    res.json({ order: { ...order[0], items, payment: payment[0] ?? null } });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = req.body ?? {};
    const paymentMethod = String(body.payment_method ?? "").trim();
    if (paymentMethod !== "gcash" && paymentMethod !== "cod") {
      throw badRequest("Only GCash and Cash on Delivery are accepted for this order");
    }

    const address = (body.address ?? {}) as Record<string, unknown>;
    if (!address || typeof address !== "object") throw badRequest("Invalid address payload");
    const street = String(address.street ?? "").trim();
    const region = String(address.region ?? "").trim();
    const province = String(address.province ?? "").trim();
    const city = String(address.city ?? "").trim();
    const barangay = String(address.barangay ?? "").trim();
    const missing = [];
    if (!region) missing.push("region");
    if (!province) missing.push("province");
    if (!city) missing.push("city");
    if (!barangay) missing.push("barangay");
    if (missing.length) {
      res.status(400).json({ error: "Incomplete shipping address", missing });
      return;
    }
    const supportedProvinces = new Set(["Lanao del Sur"]);
    if (!supportedProvinces.has(province)) {
      throw badRequest("Delivery is only available in Lanao del Sur (BARMM). This address is outside our service area.");
    }
    const shippingAddress = [street, barangay, city, province, region].filter(Boolean).join(", ");
    const notes = String(body.notes ?? "").trim().slice(0, 500);

    const postedItems = Array.isArray(body.items) ? body.items : [];
    let cartItems: any[] = [];
    if (postedItems.length > 0) {
      for (const pi of postedItems) {
        const pid = Number.parseInt(String(pi.product_id ?? 0), 10);
        const qty = Number.parseInt(String(pi.quantity ?? 1), 10);
        if (!pid || qty < 1) continue;
        const prod = await query<any>("SELECT id, price, stock_quantity, seller_id FROM products WHERE id = ? AND is_active = 1", [pid]);
        if (prod.length === 0) throw notFound(`Product ID ${pid} not found`);
        if (Number(prod[0].stock_quantity) < qty) throw badRequest(`Insufficient stock for product ID ${pid}`);
        cartItems.push({ product_id: pid, quantity: qty, price: prod[0].price, stock_quantity: prod[0].stock_quantity, seller_id: prod[0].seller_id });
      }
    } else {
      const rows = await query<any>("SELECT c.*, p.price, p.stock_quantity, p.seller_id FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?", [userId]);
      cartItems = rows;
    }
    if (cartItems.length === 0) throw badRequest("Cart is empty");

    const idempotencyKey = String(body.idempotency_key ?? "").trim().slice(0, 64);
    if (idempotencyKey) {
      const existingOrder = await query<any>("SELECT id, order_number, total_amount, shipping_fee FROM orders WHERE user_id = ? AND idempotency_key = ?", [userId, idempotencyKey]);
      if (existingOrder.length > 0) {
        const eo = existingOrder[0];
        const sum = await query<any>("SELECT COALESCE(SUM(subtotal),0) AS s FROM order_items WHERE order_id = ?", [eo.id]);
        const existingTotal = Number(sum[0].s ?? 0);
        const existingFee = Number(eo.shipping_fee ?? 0);
        const payRows = await query<any>("SELECT * FROM payments WHERE order_id = ? ORDER BY seller_id IS NULL, seller_id", [eo.id]);
        const sellerCache: Record<number, any> = {};
        const groups: any[] = [];
        for (const p of payRows) {
          const sid = p.seller_id === null ? null : Number(p.seller_id);
          if (sid !== null && !sellerCache[sid]) {
            const sr = await query<any>("SELECT full_name, gcash_number FROM users WHERE id = ?", [sid]);
            sellerCache[sid] = sr[0] ?? { full_name: "Seller", gcash_number: null };
          }
          const sellerRow = sid === null ? { full_name: "Seller", gcash_number: null } : sellerCache[sid];
          groups.push({
            payment_id: Number(p.id),
            seller_id: sid,
            seller_name: sellerRow.full_name,
            gcash_number: gcash.gcashDigits(sellerRow.gcash_number),
            amount: Number(p.amount),
            subtotal: 0,
            shipping_share: Number(p.amount),
            status: p.status,
            conversation_id: p.conversation_id === null ? null : Number(p.conversation_id),
            rejection_reason: p.rejection_reason,
            items: [],
          });
        }
        const state = await query<any>("SELECT status, payment_status FROM orders WHERE id = ?", [eo.id]);
        const st = state[0];
        res.json({
          success: true,
          duplicate: true,
          order: { id: eo.id, order_number: eo.order_number, total: existingTotal, shipping_fee: existingFee, grand_total: existingTotal + existingFee, status: st.status, payment_status: st.payment_status },
          payment_groups: groups,
        });
        return;
      }
    }

    const sellerGroups: Record<number, any> = {};
    let totalAmount = 0;
    for (const item of cartItems) {
      const sellerId = Number(item.seller_id);
      const subtotal = Number(item.price) * Number(item.quantity);
      totalAmount += subtotal;
      if (!sellerGroups[sellerId]) sellerGroups[sellerId] = { subtotal: 0, items: [] };
      sellerGroups[sellerId].subtotal += subtotal;
      sellerGroups[sellerId].items.push({ product_id: Number(item.product_id), name: null, quantity: Number(item.quantity), unit_price: Number(item.price), subtotal });
    }

    const productNames: Record<number, string> = {};
    const sellerCache: Record<number, any> = {};
    for (const sellerId of Object.keys(sellerGroups).map(Number)) {
      const group = sellerGroups[sellerId];
      for (const gi of group.items) {
        if (!productNames[gi.product_id]) {
          const pr = await query<any>("SELECT name FROM products WHERE id = ?", [gi.product_id]);
          productNames[gi.product_id] = pr.length ? pr[0].name : `Product #${gi.product_id}`;
        }
        gi.name = productNames[gi.product_id];
      }
      if (!sellerCache[sellerId]) {
        const sr = await query<any>("SELECT id, full_name, role, is_active, gcash_number FROM users WHERE id = ?", [sellerId]);
        sellerCache[sellerId] = sr[0];
      }
      const seller = sellerCache[sellerId];
      if (!seller) throw badRequest("Seller for this order is no longer available");
      if (seller.role !== "seller") throw badRequest("A product in this order is not owned by a seller account");
      if (Number(seller.is_active) !== 1) throw badRequest("The seller account for one of these products is currently unavailable. Please remove it from your cart.");
      if (paymentMethod === "gcash") {
        const digits = gcash.gcashDigits(seller.gcash_number);
        if (!digits) {
          res.status(400).json({ error: "This seller has not configured a GCash payment number yet. Please contact the seller.", seller_id: seller.id, seller_name: seller.full_name });
          return;
        }
        group.gcash_number = digits;
      }
      group.seller_id = Number(seller.id);
      group.seller_name = seller.full_name;
    }

    const shippingFee = totalAmount >= 3000 ? 0 : 150;
    const grandTotal = totalAmount + shippingFee;

    const sellerIds = Object.keys(sellerGroups).map(Number);
    const lastSellerId = sellerIds[sellerIds.length - 1];
    let shippingAllocated = 0;
    for (const sid of sellerIds) {
      const group = sellerGroups[sid];
      let share = 0;
      if (sid === lastSellerId) {
        share = Number((shippingFee - shippingAllocated).toFixed(2));
      } else {
        share = Number((shippingFee * (group.subtotal / totalAmount)).toFixed(2));
        shippingAllocated += share;
      }
      group.shipping_share = share;
      group.amount = Number((group.subtotal + share).toFixed(2));
    }

    const orderNumber = "MTO-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const nullableKey = idempotencyKey === "" ? null : idempotencyKey;

    const result = await withTransaction(async (conn) => {
      const [insert] = await conn.execute(
        `INSERT INTO orders (user_id, order_number, total_amount, shipping_fee, payment_method, payment_status, shipping_address, notes, idempotency_key)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [userId, orderNumber, totalAmount, shippingFee, paymentMethod, shippingAddress, notes, nullableKey]
      );
      const orderId = (insert as any).insertId;

      for (const item of cartItems) {
        const subtotal = Number(item.price) * Number(item.quantity);
        await conn.execute(
          "INSERT INTO order_items (order_id, product_id, seller_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?)",
          [orderId, item.product_id, item.seller_id, item.quantity, item.price, subtotal]
        );
        await conn.execute("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [item.quantity, item.product_id]);
      }

      const paymentGroups: any[] = [];
      for (const sellerId of sellerIds) {
        const group = sellerGroups[sellerId];
        const conversationId = await gcash.ensureBuyerSellerConversation(conn, userId, sellerId);
        if (paymentMethod === "gcash") {
          const [payInsert] = await conn.execute(
            "INSERT INTO payments (order_id, seller_id, amount, payment_method, status, conversation_id) VALUES (?, ?, ?, 'gcash', 'pending', ?)",
            [orderId, sellerId, group.amount, conversationId]
          );
          const paymentId = (payInsert as any).insertId;

          const systemItems = group.items.map((gi: any) => ({ name: gi.name, quantity: gi.quantity, unit_price: gi.unit_price, subtotal: gi.subtotal }));
          await gcash.postSystemMessage(conn, conversationId, userId, gcash.buildPaymentInquiry(orderNumber, group.seller_name, group.gcash_number, systemItems, group.subtotal, group.shipping_share));

          await notifyUser(conn, sellerId, "order", `New order ${orderNumber}`, `${gcash.gcashMoney(group.amount)} awaiting GCash payment. Payment instructions were sent in your conversation with the buyer.`, "/seller/orders", orderId);

          paymentGroups.push({
            payment_id: paymentId,
            seller_id: sellerId,
            seller_name: group.seller_name,
            gcash_number: group.gcash_number,
            amount: group.amount,
            subtotal: group.subtotal,
            shipping_share: group.shipping_share,
            status: "pending",
            conversation_id: conversationId,
            rejection_reason: null,
            items: group.items,
          });
        } else {
          const itemNames = group.items.map((gi: any) => `${gi.quantity} x ${gi.name}`).join(", ");
          await gcash.postSystemMessage(conn, conversationId, userId, `Order ${orderNumber} has been placed (Cash on Delivery).\nAmount to collect on arrival: ${gcash.gcashMoney(group.amount)}\nItems: ${itemNames}`);
          await notifyUser(conn, sellerId, "order", `New COD order ${orderNumber}`, `${gcash.gcashMoney(group.amount)} will be collected on delivery. The order details were sent to your conversation with the buyer.`, "/seller/orders", orderId);
        }
      }

      await conn.execute("DELETE FROM cart WHERE user_id = ?", [userId]);
      return { orderId, orderNumber, paymentGroups };
    });

    res.status(201).json({
      success: true,
      order: {
        id: result.orderId,
        order_number: result.orderNumber,
        total: totalAmount,
        shipping_fee: shippingFee,
        grand_total: grandTotal,
        payment_status: "pending",
        payment_method: paymentMethod,
      },
      payment_groups: result.paymentGroups,
    });
  })
);

router.post(
  "/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "buyer") {
      res.status(403).json({ error: "Buyer access required" });
      return;
    }
    const userId = req.user!.user_id;
    const body = req.body ?? {};
    const orderId = Number.parseInt(String(body.order_id ?? 0), 10);
    if (!orderId) throw badRequest("order_id required");

    const order = await query<any>("SELECT id, order_number, status, cancel_requested FROM orders WHERE id = ? AND user_id = ?", [orderId, userId]);
    if (order.length === 0) throw notFound("Order not found");
    const o = order[0];
    if (Number(o.cancel_requested) === 1) {
      res.json({ success: true, status: o.status, cancel_requested: true, already: true });
      return;
    }
    if (o.status === "shipped" || o.status === "delivered") {
      res.status(409).json({ error: "This order has already been prepared for shipping and can no longer be cancelled.", status: o.status });
      return;
    }
    if (o.status === "cancelled") {
      res.json({ success: true, status: "cancelled", cancel_requested: false, already: true });
      return;
    }

    await execute("UPDATE orders SET cancel_requested = 1, updated_at = NOW() WHERE id = ?", [orderId]);
    const sellers = await query<any>("SELECT DISTINCT seller_id FROM order_items WHERE order_id = ?", [orderId]);
    for (const row of sellers) {
      await notifyUser(pool as any, Number(row.seller_id), "order", `Cancellation requested for ${o.order_number}`, "The buyer asked to cancel this order. Confirm it in your orders screen; the items return to your stock when you do.", "/seller/orders", orderId);
    }
    res.json({ success: true, status: o.status, cancel_requested: true });
  })
);

export default router;
