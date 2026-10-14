import type { Pool, PoolConnection } from "mysql2/promise";

export type DbExecutor = Pool | PoolConnection;

async function q<T = Record<string, unknown>>(
  db: DbExecutor,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await (db as Pool).query(sql, params);
  return rows as T[];
}

async function run(
  db: DbExecutor,
  sql: string,
  params: unknown[] = []
): Promise<{ affectedRows: number; insertId: number }> {
  const [result] = await (db as Pool).query(sql, params);
  const r = result as { affectedRows?: number; insertId?: number };
  return { affectedRows: r.affectedRows ?? 0, insertId: r.insertId ?? 0 };
}

/** Strip everything but digits; only plausible (10-15 digit) numbers survive. */
export function gcashDigits(value: unknown): string {
  const digits = String(value ?? "").replace(/\D+/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

/** Format a peso amount with thousands separators, e.g. ₱1,234.00. */
export function gcashMoney(amount: number): string {
  return "₱" + amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface PaymentEventInput {
  paymentId: number | null;
  actorId: number | null;
  actorRole: string | null;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  note?: string | null;
  reference?: string | null;
}

export async function logPaymentEvent(db: DbExecutor, input: PaymentEventInput): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO payment_events
        (payment_id, subscription_id, actor_id, actor_role, event_type, from_status, to_status, note, reference_snapshot)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.paymentId,
        input.actorId,
        input.actorRole,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.note ?? null,
        input.reference ?? null,
      ]
    );
  } catch (error) {
    console.error("[payments] logPaymentEvent failed", error);
  }
}

export async function logSubscriptionPaymentEvent(
  db: DbExecutor,
  subscriptionId: number,
  actorId: number | null,
  actorRole: string | null,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string | null = null,
  reference: string | null = null
): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO payment_events
        (payment_id, subscription_id, actor_id, actor_role, event_type, from_status, to_status, note, reference_snapshot)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [subscriptionId, actorId, actorRole, eventType, fromStatus, toStatus, note, reference]
    );
  } catch (error) {
    console.error("[payments] logSubscriptionPaymentEvent failed", error);
  }
}

/**
 * Recompute the aggregate payment_status for an order from its per-seller
 * payment rows. Precedence: rejected > paid (all completed) >
 * awaiting_confirmation > pending.
 */
export async function refreshOrderPaymentStatus(db: DbExecutor, orderId: number): Promise<string> {
  const rows = await q<{ status: string }>(db, "SELECT status FROM payments WHERE order_id = ?", [orderId]);
  const statuses = rows.map((r) => r.status);

  let aggregate = "pending";
  if (statuses.some((s) => s === "rejected")) {
    aggregate = "rejected";
  } else if (statuses.length > 0 && statuses.every((s) => s === "completed")) {
    aggregate = "paid";
  } else if (statuses.some((s) => s === "awaiting_confirmation")) {
    aggregate = "awaiting_confirmation";
  }

  if (aggregate === "paid") {
    await run(
      db,
      "UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = ? AND status NOT IN ('cancelled','delivered','shipped')",
      [orderId]
    );
  } else {
    await run(db, "UPDATE orders SET payment_status = ? WHERE id = ?", [aggregate, orderId]);
  }

  return aggregate;
}

/** Find or create the general (no-product) buyer<->seller conversation. */
export async function ensureBuyerSellerConversation(
  db: DbExecutor,
  buyerId: number,
  sellerId: number
): Promise<number> {
  const existing = await q<{ id: number }>(
    db,
    "SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id IS NULL AND type = 'buyer_seller' ORDER BY id ASC LIMIT 1",
    [buyerId, sellerId]
  );
  if (existing.length > 0) {
    await run(db, "UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [existing[0].id]);
    return existing[0].id;
  }
  const created = await run(
    db,
    "INSERT INTO conversations (buyer_id, seller_id, product_id, type) VALUES (?, ?, NULL, 'buyer_seller')",
    [buyerId, sellerId]
  );
  return created.insertId;
}

/** Insert a system-authored message and bump the conversation timestamp. */
export async function postSystemMessage(
  db: DbExecutor,
  conversationId: number,
  senderId: number,
  body: string
): Promise<void> {
  await run(db, "INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)", [
    conversationId,
    senderId,
    body,
  ]);
  await run(db, "UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);
}

/** First admin's id, or null when there is no admin account. */
export async function firstAdminId(db: DbExecutor): Promise<number | null> {
  const rows = await q<{ id: number }>(db, "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
  return rows[0]?.id ?? null;
}

/** Find or create the seller<->admin conversation. */
export async function ensureSellerAdminConversation(
  db: DbExecutor,
  sellerId: number
): Promise<number | null> {
  const adminId = await firstAdminId(db);
  if (!adminId) return null;

  const existing = await q<{ id: number }>(
    db,
    "SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ? AND product_id IS NULL AND type = 'seller_admin' ORDER BY id ASC LIMIT 1",
    [sellerId, adminId]
  );
  if (existing.length > 0) return existing[0].id;

  const created = await run(
    db,
    "INSERT INTO conversations (buyer_id, seller_id, product_id, type) VALUES (?, ?, NULL, 'seller_admin')",
    [sellerId, adminId]
  );
  return created.insertId;
}

export async function platformGcashNumber(db: DbExecutor): Promise<string> {
  const rows = await q<{ value: string }>(
    db,
    "SELECT value FROM platform_settings WHERE `key` = 'gcash_number'",
    []
  );
  return gcashDigits(rows[0]?.value ?? "");
}

export async function platformSubscriptionPrice(db: DbExecutor): Promise<number> {
  const rows = await q<{ value: string }>(
    db,
    "SELECT value FROM platform_settings WHERE `key` = 'subscription_price'",
    []
  );
  const parsed = Number.parseFloat(rows[0]?.value ?? "");
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 299.0;
}

export function buildSubscriptionPaymentInquiry(amount: number, gcashNumber: string): string {
  return [
    "Subscription payment request",
    "",
    `Amount to send: ${gcashMoney(amount)}`,
    `GCash number: ${gcashNumber}`,
    "",
    "After sending, open your Subscription page and submit the GCash reference number so the admin can verify it.",
  ].join("\n");
}

export interface SystemItem {
  name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export function buildPaymentInquiry(
  orderNumber: string,
  sellerName: string,
  gcashNumber: string,
  items: SystemItem[],
  subtotal: number,
  shippingShare: number
): string {
  const lines: string[] = [
    `New order ${orderNumber}`,
    "",
    "Items:",
  ];
  for (const item of items) {
    lines.push(`- ${item.name} x${item.quantity} = ${gcashMoney(item.subtotal)}`);
  }
  lines.push("");
  lines.push(`Subtotal: ${gcashMoney(subtotal)}`);
  if (shippingShare > 0) lines.push(`Shipping share: ${gcashMoney(shippingShare)}`);
  lines.push(`Amount to send: ${gcashMoney(subtotal + shippingShare)}`);
  lines.push(`GCash number: ${gcashNumber}`);
  lines.push("");
  lines.push(`Please send the amount to ${sellerName} and submit the reference number on your order page.`);
  return lines.join("\n");
}
