import { Router } from "express";
import { query, execute, withTransaction, pool } from "../config/database";
import { asyncHandler, badRequest, notFound, conflict, forbidden, toInt } from "../utils/http";
import { requireAuth, authorize } from "../middleware/auth";
import { dataString } from "../utils/validate";
import { notifyUser, notifyRole } from "../utils/notifications";
import * as gcash from "../utils/gcash";

const router = Router();

// All payment endpoints require a valid session.
router.use(requireAuth);

// GET /?order_id=...  -- role-scoped payment groups for one order.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const role = req.user!.role;

    const orderId = toInt(req.query.order_id);
    if (!orderId) throw badRequest("order_id is required");

    const orderRows = await query<any>(
      "SELECT id, order_number, user_id, total_amount, shipping_fee, status, payment_method, payment_status FROM orders WHERE id = ?",
      [orderId]
    );
    if (orderRows.length === 0) throw notFound("Order not found");
    const order = orderRows[0];

    if (role === "buyer" && Number(order.user_id) !== userId) {
      throw forbidden("Forbidden");
    }

    if (role === "seller") {
      const own = await query<any>(
        "SELECT 1 FROM order_items WHERE order_id = ? AND seller_id = ? LIMIT 1",
        [orderId, userId]
      );
      if (own.length === 0) throw notFound("Order not found");
    }

    const payRows = await query<any>(
      `SELECT pay.*,
              u.full_name AS seller_name,
              u.gcash_number AS seller_gcash,
              b.full_name AS buyer_name
       FROM payments pay
       LEFT JOIN users u ON u.id = pay.seller_id
       LEFT JOIN orders o ON o.id = pay.order_id
       LEFT JOIN users b ON b.id = o.user_id
       WHERE pay.order_id = ?
       ORDER BY pay.seller_id IS NULL, pay.seller_id, pay.id`,
      [orderId]
    );

    const subStmt = async (oId: number, sId: number) =>
      query<any>("SELECT COALESCE(SUM(subtotal),0) AS s FROM order_items WHERE order_id = ? AND seller_id = ?", [oId, sId]);
    const itemStmt = async (oId: number, sId: number) =>
      query<any>(
        `SELECT oi.quantity, oi.unit_price, oi.subtotal, p.name, p.image_url
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ? AND oi.seller_id = ?
         ORDER BY oi.id`,
        [oId, sId]
      );

    const groups: any[] = [];
    for (const row of payRows) {
      const sellerId = row.seller_id === null ? null : Number(row.seller_id);

      if (role === "seller" && sellerId !== userId) {
        continue;
      }

      let subtotal = 0;
      const items: any[] = [];
      if (sellerId !== null) {
        const sub = await subStmt(orderId, sellerId);
        subtotal = Number(sub[0]?.s ?? 0);
        const its = await itemStmt(orderId, sellerId);
        for (const it of its) {
          items.push({
            name: it.name,
            image_url: it.image_url,
            quantity: Number(it.quantity),
            unit_price: Number(it.unit_price),
            subtotal: Number(it.subtotal),
          });
        }
      }

      const amount = Number(row.amount);
      groups.push({
        payment_id: Number(row.id),
        seller_id: sellerId,
        seller_name: row.seller_name,
        gcash_number: gcash.gcashDigits(row.seller_gcash),
        amount,
        subtotal,
        shipping_share: Number((amount - subtotal).toFixed(2)),
        status: row.status,
        conversation_id: row.conversation_id === null ? null : Number(row.conversation_id),
        transaction_reference: row.transaction_reference,
        rejection_reason: row.rejection_reason,
        paid_at: row.paid_at,
        items,
      });
    }

    res.json({
      order: {
        id: Number(order.id),
        order_number: order.order_number,
        total_amount: Number(order.total_amount),
        shipping_fee: Number(order.shipping_fee),
        status: order.status,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
      },
      buyer_name: payRows[0]?.buyer_name ?? null,
      payment_groups: groups,
    });
  })
);

// POST /mark-sent  (buyer)
router.post(
  "/mark-sent",
  authorize("buyer"),
  asyncHandler(async (req, res) => {
    const userId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const paymentId = toInt(body.payment_id);
    if (!paymentId) throw badRequest("payment_id is required");

    const rows = await query<any>(
      `SELECT pay.*, o.user_id AS buyer_id, o.order_number, o.status AS order_status
       FROM payments pay JOIN orders o ON o.id = pay.order_id
       WHERE pay.id = ?`,
      [paymentId]
    );
    if (rows.length === 0) throw notFound("Payment not found");
    const payment = rows[0];

    if (Number(payment.buyer_id) !== userId) throw forbidden("Forbidden");

    if (payment.order_status === "cancelled") {
      throw conflict("This order was cancelled. No payment is needed.");
    }

    const reference = dataString(body, "transaction_reference", 100);
    if (reference === "") {
      throw badRequest("GCash reference number is required", { field: "transaction_reference" });
    }
    const normalized = reference.replace(/[\s-]+/g, "");
    if (!/^[A-Za-z0-9]+$/.test(normalized)) {
      throw badRequest("GCash reference may only contain letters and numbers", { field: "transaction_reference" });
    }
    if (normalized.length < 6 || normalized.length > 32) {
      throw badRequest("GCash reference must be between 6 and 32 characters", { field: "transaction_reference" });
    }

    const current = String(payment.status);
    const orderId = Number(payment.order_id);
    const wasRejected = current === "rejected";

    if (current === "awaiting_confirmation") {
      res.json({ success: true, already_marked: true, status: "awaiting_confirmation", payment_id: paymentId });
      return;
    }
    if (current === "completed") {
      throw conflict("This payment is already confirmed by the seller.");
    }
    if (current !== "pending" && !wasRejected) {
      throw conflict("This payment is not awaiting your confirmation.");
    }

    let resultStatus = "awaiting_confirmation";
    let lockedStatus = current;
    let already = false;
    let aggregate = "";

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status, transaction_reference FROM payments WHERE id = ? FOR UPDATE",
        [paymentId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      const ls = locked ? String(locked.status) : current;
      lockedStatus = ls;
      if (!locked || (ls !== "pending" && ls !== "rejected")) {
        already = true;
        resultStatus = ls;
        return;
      }

      await conn.execute(
        "UPDATE payments SET status = 'awaiting_confirmation', transaction_reference = ? WHERE id = ?",
        [normalized, paymentId]
      );

      await gcash.logPaymentEvent(conn, {
        paymentId,
        actorId: userId,
        actorRole: "buyer",
        eventType: ls === "rejected" ? "resubmitted" : "submitted",
        fromStatus: ls,
        toStatus: "awaiting_confirmation",
        note:
          ls === "rejected"
            ? `Buyer resubmitted after rejection. Previously submitted reference: ${String(locked.transaction_reference ?? "none")}`
            : null,
        reference: normalized,
      });

      aggregate = await gcash.refreshOrderPaymentStatus(conn, orderId);

      const convId = payment.conversation_id === null ? 0 : Number(payment.conversation_id);
      if (convId > 0) {
        let msg = "";
        if (ls === "rejected") {
          msg =
            `I sent the GCash payment of ${gcash.gcashMoney(Number(payment.amount))} again for order ${payment.order_number}.` +
            `\nNew GCash reference: ${normalized}` +
            `\n(The reference I gave before was ${String(locked.transaction_reference ?? "none")}.)` +
            "\nPlease check your GCash and confirm when you receive it.";
        } else {
          msg =
            `I have sent the GCash payment of ${gcash.gcashMoney(Number(payment.amount))}.` +
            `\nGCash reference: ${normalized}` +
            "\nPlease check your GCash for that reference and confirm when you receive it.";
        }
        await gcash.postSystemMessage(conn, convId, userId, msg);
      }

      await notifyUser(
        conn,
        Number(payment.seller_id),
        "payment",
        "Buyer submitted a GCash reference",
        `Order ${payment.order_number} - ${gcash.gcashMoney(Number(payment.amount))} claimed as paid. Reference: ${normalized}` +
          (wasRejected ? " (resubmitted after rejection)" : "") +
          ". Verify it in your Orders list.",
        "/seller/orders",
        paymentId
      );
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not update the payment" });
      return;
    }

    if (already) {
      res.json({ success: true, already_marked: true, status: lockedStatus, payment_id: paymentId });
      return;
    }

    const finalAggregate = aggregate || (await gcash.refreshOrderPaymentStatus(pool, orderId));
    res.json({
      success: true,
      status: "awaiting_confirmation",
      payment_id: paymentId,
      resubmitted: wasRejected,
      order_payment_status: finalAggregate,
    });
  })
);

// POST /confirm  (seller)
router.post(
  "/confirm",
  authorize("seller"),
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const paymentId = toInt(body.payment_id);
    if (!paymentId) throw badRequest("payment_id is required");

    const lateNote = dataString(body, "note", 255);

    const rows = await query<any>(
      "SELECT pay.*, o.order_number FROM payments pay JOIN orders o ON o.id = pay.order_id WHERE pay.id = ?",
      [paymentId]
    );
    if (rows.length === 0) throw notFound("Payment not found");
    const payment = rows[0];

    if (payment.seller_id === null || Number(payment.seller_id) !== sellerId) {
      throw forbidden("Forbidden");
    }

    const orderId = Number(payment.order_id);
    const current = String(payment.status);

    if (current === "completed") {
      const agg = await gcash.refreshOrderPaymentStatus(pool, orderId);
      res.json({
        success: true,
        already_confirmed: true,
        status: "completed",
        payment_id: paymentId,
        order_payment_status: agg,
      });
      return;
    }
    if (current === "pending") {
      throw conflict("The buyer has not marked this payment as sent yet.");
    }
    if (current === "rejected" && lateNote === "") {
      throw badRequest("This payment was rejected. Add a note explaining how you received the money so the buyer can see what happened.", {
        field: "note",
      });
    }
    if (current !== "rejected" && current !== "awaiting_confirmation") {
      throw conflict("This payment is not awaiting confirmation.");
    }

    const wasRejected = current === "rejected";

    let already = false;
    let lockedStatus = current;
    let aggregate = "";
    let resultStatus = current;

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status, transaction_reference FROM payments WHERE id = ? FOR UPDATE",
        [paymentId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      const ls = locked ? String(locked.status) : current;
      lockedStatus = ls;
      if (!locked || (ls !== "awaiting_confirmation" && ls !== "rejected")) {
        already = true;
        resultStatus = ls;
        return;
      }

      await conn.execute(
        "UPDATE payments SET status = 'completed', paid_at = CURRENT_TIMESTAMP, rejection_reason = NULL WHERE id = ?",
        [paymentId]
      );

      const eventNote =
        ls === "rejected"
          ? lateNote + ` (overturned a rejection: ${String(payment.rejection_reason ?? "no reason recorded")})`
          : lateNote;

      await gcash.logPaymentEvent(conn, {
        paymentId,
        actorId: sellerId,
        actorRole: "seller",
        eventType: ls === "rejected" ? "received_late" : "confirmed",
        fromStatus: ls,
        toStatus: "completed",
        note: eventNote !== "" ? eventNote : null,
        reference: locked.transaction_reference ?? payment.transaction_reference ?? null,
      });

      aggregate = await gcash.refreshOrderPaymentStatus(conn, orderId);

      const convId = payment.conversation_id === null ? 0 : Number(payment.conversation_id);
      if (convId > 0) {
        let msg = "";
        if (ls === "rejected") {
          msg = `I have received the GCash payment of ${gcash.gcashMoney(Number(payment.amount))} for order ${payment.order_number} after all, so I have marked it as paid.\n\n${lateNote}`;
        } else {
          msg = `Payment received and confirmed for order ${payment.order_number} (${gcash.gcashMoney(Number(payment.amount))}). Thank you!`;
        }
        await gcash.postSystemMessage(conn, convId, sellerId, msg);
      }
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not confirm the payment" });
      return;
    }

    if (already) {
      res.json({
        success: true,
        already_confirmed: lockedStatus === "completed",
        status: lockedStatus,
        payment_id: paymentId,
      });
      return;
    }

    const finalAggregate = aggregate || (await gcash.refreshOrderPaymentStatus(pool, orderId));
    res.json({
      success: true,
      status: "completed",
      payment_id: paymentId,
      recovered_from_rejection: wasRejected,
      order_payment_status: finalAggregate,
      order_fully_paid: finalAggregate === "paid",
    });
  })
);

// POST /reject  (seller)
router.post(
  "/reject",
  authorize("seller"),
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const paymentId = toInt(body.payment_id);
    if (!paymentId) throw badRequest("payment_id is required");

    const reason = dataString(body, "reason", 255);
    if (reason === "") throw badRequest("A reason is required so the buyer knows what to fix");

    const reasonLabels: Record<string, string> = {
      not_received: "Payment not received.",
      wrong_amount: "Incorrect amount received.",
      wrong_number: "Payment was sent to the wrong GCash number.",
      unverifiable: "Transaction cannot be verified.",
    };
    const reasonKey = dataString(body, "reason_code", 40);
    let label = reasonLabels[reasonKey] ?? "Payment not verified by seller.";
    if (reasonKey === "other") {
      label = `Payment not verified: ${reason}`;
    }

    const rows = await query<any>(
      "SELECT pay.*, o.order_number FROM payments pay JOIN orders o ON o.id = pay.order_id WHERE pay.id = ?",
      [paymentId]
    );
    if (rows.length === 0) throw notFound("Payment not found");
    const payment = rows[0];

    if (payment.seller_id === null || Number(payment.seller_id) !== sellerId) {
      throw forbidden("Forbidden");
    }

    const orderId = Number(payment.order_id);
    const current = String(payment.status);

    if (current === "completed") throw conflict("This payment is already confirmed and cannot be rejected.");
    if (current === "pending") throw conflict("The buyer has not marked this payment as sent yet.");
    if (current === "rejected") {
      res.json({ success: true, already_rejected: true, status: "rejected", payment_id: paymentId });
      return;
    }
    if (current !== "awaiting_confirmation") {
      throw conflict("This payment is not awaiting confirmation.");
    }

    let already = false;
    let lockedStatus = current;
    let aggregate = "";

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status FROM payments WHERE id = ? FOR UPDATE",
        [paymentId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      const ls = locked ? String(locked.status) : current;
      if (!locked || ls !== "awaiting_confirmation") {
        already = true;
        lockedStatus = locked ? String(locked.status) : current;
        return;
      }

      await conn.execute(
        "UPDATE payments SET status = 'rejected', rejection_reason = ? WHERE id = ?",
        [label, paymentId]
      );

      await gcash.logPaymentEvent(conn, {
        paymentId,
        actorId: sellerId,
        actorRole: "seller",
        eventType: "rejected",
        fromStatus: current,
        toStatus: "rejected",
        note: label,
        reference: payment.transaction_reference ?? null,
      });

      aggregate = await gcash.refreshOrderPaymentStatus(conn, orderId);

      const convId = payment.conversation_id === null ? 0 : Number(payment.conversation_id);
      if (convId > 0) {
        await gcash.postSystemMessage(
          conn,
          convId,
          sellerId,
          `I could not verify the GCash payment of ${gcash.gcashMoney(Number(payment.amount))} for order ${payment.order_number}.\n\n${label}\nPlease check your GCash transaction and send the correct amount.`
        );
      }
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not reject the payment" });
      return;
    }

    if (already) {
      res.json({
        success: true,
        already_rejected: true,
        status: lockedStatus,
        payment_id: paymentId,
      });
      return;
    }

    const finalAggregate = aggregate || (await gcash.refreshOrderPaymentStatus(pool, orderId));
    res.json({
      success: true,
      status: "rejected",
      payment_id: paymentId,
      rejection_reason: label,
      order_payment_status: finalAggregate,
      order_fully_paid: finalAggregate === "paid",
    });
  })
);

// POST /subscription-mark-sent  (seller)
router.post(
  "/subscription-mark-sent",
  authorize("seller"),
  asyncHandler(async (req, res) => {
    const sellerId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const subId = toInt(body.subscription_id);
    if (!subId) throw badRequest("subscription_id is required");

    const qRows = await query<any>(
      "SELECT id, seller_id, status, payment_status, payment_amount, transaction_reference FROM seller_subscriptions WHERE id = ?",
      [subId]
    );
    if (qRows.length === 0) throw notFound("Subscription not found");
    const sub = qRows[0];

    if (Number(sub.seller_id) !== sellerId) throw forbidden("Forbidden");

    const reference = dataString(body, "transaction_reference", 100);
    if (reference === "") {
      throw badRequest("GCash reference number is required", { field: "transaction_reference" });
    }
    const normalized = reference.replace(/[\s-]+/g, "");
    if (!/^[A-Za-z0-9]+$/.test(normalized)) {
      throw badRequest("GCash reference may only contain letters and numbers", { field: "transaction_reference" });
    }
    if (normalized.length < 6 || normalized.length > 32) {
      throw badRequest("GCash reference must be between 6 and 32 characters", { field: "transaction_reference" });
    }

    const current = String(sub.payment_status);
    const wasRejected = current === "rejected";

    if (current === "awaiting_confirmation") {
      res.json({ success: true, already_marked: true, status: "awaiting_confirmation", subscription_id: subId });
      return;
    }
    if (current === "completed") {
      throw conflict("This subscription payment is already confirmed.");
    }
    if (current !== "pending" && !wasRejected) {
      throw conflict("This payment is not awaiting confirmation.");
    }
    if (String(sub.status) !== "Pending") {
      throw conflict("This subscription is no longer awaiting payment.");
    }

    let already = false;
    let lockedStatus = current;

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status, payment_status, transaction_reference FROM seller_subscriptions WHERE id = ? FOR UPDATE",
        [subId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      const ls = locked ? String(locked.payment_status) : current;
      if (
        !locked ||
        String(locked.status) !== "Pending" ||
        (ls !== "pending" && ls !== "rejected")
      ) {
        already = true;
        lockedStatus = ls;
        return;
      }

      await conn.execute(
        "UPDATE seller_subscriptions SET payment_status = 'awaiting_confirmation', transaction_reference = ?, updated_at = NOW() WHERE id = ?",
        [normalized, subId]
      );

      await gcash.logSubscriptionPaymentEvent(
        conn,
        subId,
        sellerId,
        "seller",
        ls === "rejected" ? "resubmitted" : "submitted",
        ls,
        "awaiting_confirmation",
        ls === "rejected"
          ? `Seller resubmitted after rejection. Previously submitted reference: ${String(locked.transaction_reference ?? "none")}`
          : null,
        normalized
      );

      const convId = await gcash.ensureSellerAdminConversation(conn, sellerId);
      if (convId !== null && convId > 0) {
        const amount = gcash.gcashMoney(Number(sub.payment_amount));
        let msg = "";
        if (ls === "rejected") {
          msg =
            `I sent the subscription payment of ${amount} again.` +
            `\nNew GCash reference: ${normalized}` +
            `\n(The reference I gave before was ${String(locked.transaction_reference ?? "none")}.)` +
            "\nPlease check your GCash and confirm when you receive it.";
        } else {
          msg = `I have sent the subscription payment of ${amount}.` + `\nGCash reference: ${normalized}` + "\nPlease check your GCash for that reference and confirm when you receive it.";
        }
        await gcash.postSystemMessage(conn, convId, sellerId, msg);
      }

      // notify admins
      const nameRows = await query<any>("SELECT full_name FROM users WHERE id = ?", [sellerId]);
      const sellerName = String(nameRows[0]?.full_name ?? "A seller");
      await notifyRole(
        conn,
        "admin",
        "subscription",
        "Subscription payment submitted",
        `${sellerName} sent ${gcash.gcashMoney(Number(sub.payment_amount))}. Reference: ${normalized}` +
          (ls === "rejected" ? " (resubmitted after rejection)" : "") +
          ". Confirm or reject it in Subscriptions.",
        "/admin/subscriptions",
        subId
      );
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not update the payment" });
      return;
    }

    if (already) {
      res.json({ success: true, already_marked: true, status: lockedStatus, subscription_id: subId });
      return;
    }

    res.json({
      success: true,
      status: "awaiting_confirmation",
      subscription_id: subId,
      resubmitted: wasRejected,
    });
  })
);

// POST /subscription-confirm  (admin)
router.post(
  "/subscription-confirm",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const adminId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const subId = toInt(body.subscription_id);
    if (!subId) throw badRequest("subscription_id is required");

    const note = dataString(body, "note", 255);

    const rows = await query<any>(
      "SELECT id, seller_id, status, payment_status, payment_amount, transaction_reference FROM seller_subscriptions WHERE id = ?",
      [subId]
    );
    if (rows.length === 0) throw notFound("Subscription not found");
    const sub = rows[0];

    const current = String(sub.payment_status);

    if (current === "completed") {
      res.json({ success: true, already_confirmed: true, status: "completed", subscription_id: subId });
      return;
    }
    if (current === "pending") {
      throw conflict("The seller has not marked this payment as sent yet.");
    }
    if (current !== "awaiting_confirmation") {
      throw conflict("This payment is not awaiting confirmation.");
    }
    if (String(sub.status) !== "Pending") {
      throw conflict("This subscription is no longer awaiting approval.");
    }

    const startDate = new Date().toISOString().slice(0, 10);
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const endDate = d.toISOString().slice(0, 10);
    const endDateHuman = new Date(endDate + "T00:00:00").toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    let already = false;
    let lockedStatus = current;
    let lockedSubStatus = String(sub.status);

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status, payment_status, transaction_reference FROM seller_subscriptions WHERE id = ? FOR UPDATE",
        [subId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      const ls = locked ? String(locked.payment_status) : current;
      const lss = locked ? String(locked.status) : String(sub.status);
      lockedStatus = ls;
      lockedSubStatus = lss;
      if (!locked || lss !== "Pending" || ls !== "awaiting_confirmation") {
        already = true;
        return;
      }

      await conn.execute(
        `UPDATE seller_subscriptions
         SET payment_status = 'completed',
             paid_at = CURRENT_TIMESTAMP,
             payment_rejection_reason = NULL,
             status = 'Active',
             start_date = ?,
             end_date = ?,
             approved_by = ?,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = ?`,
        [startDate, endDate, adminId, subId]
      );

      await gcash.logSubscriptionPaymentEvent(
        conn,
        subId,
        adminId,
        "admin",
        "confirmed",
        ls,
        "completed",
        note !== "" ? note : null,
        locked.transaction_reference ?? sub.transaction_reference ?? null
      );

      const convId = await gcash.ensureSellerAdminConversation(conn, Number(sub.seller_id));
      if (convId !== null && convId > 0) {
        let msg = `Payment received and confirmed for your subscription (${gcash.gcashMoney(Number(sub.payment_amount))}).\nYour subscription is now active until ${endDateHuman}.`;
        if (note !== "") msg += `\n\n${note}`;
        await gcash.postSystemMessage(conn, convId, adminId, msg);
      }
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not confirm the payment" });
      return;
    }

    if (already) {
      res.json({
        success: true,
        already_confirmed: lockedStatus === "completed",
        status: lockedStatus,
        subscription_id: subId,
      });
      return;
    }

    res.json({
      success: true,
      status: "completed",
      subscription_id: subId,
      subscription_status: "Active",
      start_date: startDate,
      end_date: endDate,
    });
  })
);

// POST /subscription-reject  (admin)
router.post(
  "/subscription-reject",
  authorize("admin"),
  asyncHandler(async (req, res) => {
    const adminId = req.user!.user_id;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const subId = toInt(body.subscription_id);
    if (!subId) throw badRequest("subscription_id is required");

    const reason = dataString(body, "reason", 255);
    if (reason === "") throw badRequest("A reason is required so the seller knows what to fix");

    const reasonLabels: Record<string, string> = {
      not_received: "Payment not received.",
      wrong_amount: "Incorrect amount received.",
      wrong_number: "Payment was sent to the wrong GCash number.",
      unverifiable: "Transaction cannot be verified.",
    };
    const reasonKey = dataString(body, "reason_code", 40);
    let label = reasonLabels[reasonKey] ?? "Payment not verified by admin.";
    if (reasonKey === "other") {
      label = `Payment not verified: ${reason}`;
    }

    const rows = await query<any>(
      "SELECT id, seller_id, status, payment_status, payment_amount, transaction_reference FROM seller_subscriptions WHERE id = ?",
      [subId]
    );
    if (rows.length === 0) throw notFound("Subscription not found");
    const sub = rows[0];

    const current = String(sub.payment_status);

    if (current === "completed") throw conflict("This payment is already confirmed and cannot be rejected.");
    if (current === "pending") throw conflict("The seller has not marked this payment as sent yet.");
    if (current === "rejected") {
      res.json({ success: true, already_rejected: true, status: "rejected", subscription_id: subId });
      return;
    }
    if (current !== "awaiting_confirmation") throw conflict("This payment is not awaiting confirmation.");
    if (String(sub.status) !== "Pending") throw conflict("This subscription is no longer awaiting payment.");

    let already = false;
    let lockedStatus = current;

    try {
      await withTransaction(async (conn) => {
        const [lockResult] = await (conn as any).query(
          "SELECT status, payment_status FROM seller_subscriptions WHERE id = ? FOR UPDATE",
        [subId]
      );
      const locked = Array.isArray(lockResult) ? lockResult[0] : lockResult;
      if (
        !locked ||
        String(locked.status) !== "Pending" ||
        String(locked.payment_status) !== "awaiting_confirmation"
      ) {
        already = true;
        lockedStatus = locked ? String(locked.payment_status) : current;
        return;
      }

      await conn.execute(
        "UPDATE seller_subscriptions SET payment_status = 'rejected', payment_rejection_reason = ?, updated_at = NOW() WHERE id = ?",
        [label, subId]
      );

      await gcash.logSubscriptionPaymentEvent(
        conn,
        subId,
        adminId,
        "admin",
        "rejected",
        current,
        "rejected",
        label,
        sub.transaction_reference ?? null
      );

      const convId = await gcash.ensureSellerAdminConversation(conn, Number(sub.seller_id));
      if (convId !== null && convId > 0) {
        await gcash.postSystemMessage(
          conn,
          convId,
          adminId,
          `I could not verify the subscription payment of ${gcash.gcashMoney(Number(sub.payment_amount))}.\n\n${label}\nPlease check your GCash transaction and send the correct reference again.`
        );
      }
    });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not reject the payment" });
      return;
    }

    if (already) {
      res.json({
        success: true,
        already_rejected: (lockedStatus === "rejected"),
        status: lockedStatus,
        subscription_id: subId,
      });
      return;
    }

    res.json({
      success: true,
      status: "rejected",
      subscription_id: subId,
      rejection_reason: label,
    });
  })
);

// Clean unused utils import guard
export default router;
