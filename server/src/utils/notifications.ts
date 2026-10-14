import type { Pool, PoolConnection } from "mysql2/promise";
import { execute } from "../config/database";

/**
 * Append an entry to the admin audit log. Never throws: a failed audit write
 * must not break the action it is recording.
 */
export async function logAdminAudit(
  adminId: number | null,
  action: string,
  targetType = "",
  targetId = 0,
  details: unknown = null
): Promise<void> {
  try {
    let detailsValue: string | null = null;
    if (details !== null && details !== undefined && details !== "") {
      detailsValue = typeof details === "string" ? details : JSON.stringify(details);
    }
    await execute(
      "INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
      [adminId ?? null, action, targetType, targetId, detailsValue]
    );
  } catch (error) {
    console.error("[audit] failed to write audit log", error);
  }
}

export type DbExecutor = Pool | PoolConnection;

async function execQuery<T = Record<string, unknown>>(
  db: DbExecutor,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await (db as Pool).query(sql, params);
  return rows as T[];
}

async function execRun(
  db: DbExecutor,
  sql: string,
  params: unknown[] = []
): Promise<number> {
  const [result] = await (db as Pool).query(sql, params);
  return (result as { affectedRows?: number; insertId?: number }).affectedRows ?? 0;
}

function clamp(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

const NOTIFICATION_TYPES = ["message", "order", "payment", "subscription"];

/** Insert a notification for a single user. Errors are swallowed. */
export async function notifyUser(
  db: DbExecutor,
  userId: number,
  type: string,
  title: string,
  body: string | null = null,
  link: string | null = null,
  relatedId: number | null = null
): Promise<void> {
  try {
    if (!userId || userId <= 0) return;
    if (!NOTIFICATION_TYPES.includes(type)) return;

    await execRun(
      db,
      "INSERT INTO notifications (user_id, type, title, body, link, related_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        userId,
        type,
        clamp(title, 150),
        body === null ? null : clamp(body, 255),
        link === null ? null : clamp(link, 255),
        relatedId,
      ]
    );
  } catch (error) {
    console.error("[notifications] notifyUser failed", error);
  }
}

/** Notify every active user with a given role. Errors are swallowed. */
export async function notifyRole(
  db: DbExecutor,
  role: string,
  type: string,
  title: string,
  body: string | null = null,
  link: string | null = null,
  relatedId: number | null = null
): Promise<void> {
  try {
    const users = await execQuery<{ id: number }>(
      db,
      "SELECT id FROM users WHERE role = ? AND is_active = 1",
      [role]
    );
    for (const user of users) {
      await notifyUser(db, user.id, type, title, body, link, relatedId);
    }
  } catch (error) {
    console.error("[notifications] notifyRole failed", error);
  }
}

export async function notificationUserRole(db: DbExecutor, userId: number): Promise<string> {
  const rows = await execQuery<{ role: string }>(
    db,
    "SELECT role FROM users WHERE id = ?",
    [userId]
  );
  return rows[0]?.role ?? "buyer";
}

export interface ConversationRow {
  id: number;
  buyer_id: number;
  seller_id: number;
  type: string;
}

/** Notify the other participant(s) of a conversation about a new message. */
export async function notifyConversationMessage(
  db: DbExecutor,
  conversation: ConversationRow,
  senderId: number,
  senderName: string,
  excerpt: string | null
): Promise<void> {
  try {
    const title = `New message from ${senderName}`;
    const body = excerpt && excerpt.trim() !== "" ? excerpt : "Sent an image";

    if (conversation.type === "seller_admin") {
      if (conversation.buyer_id === senderId) {
        await notifyRole(db, "admin", "message", title, body, `/admin/messages?conversation=${conversation.id}`, conversation.id);
      } else {
        await notifyUser(db, conversation.buyer_id, "message", title, body, `/seller/messages?conversation=${conversation.id}`, conversation.id);
      }
      return;
    }

    const recipientId =
      conversation.buyer_id === senderId ? conversation.seller_id : conversation.buyer_id;
    if (!recipientId) return;
    const role = await notificationUserRole(db, recipientId);
    const prefix = role === "admin" ? "/admin" : role === "seller" ? "/seller" : "/account";
    await notifyUser(db, recipientId, "message", title, body, `${prefix}/messages?conversation=${conversation.id}`, conversation.id);
  } catch (error) {
    console.error("[notifications] notifyConversationMessage failed", error);
  }
}

export async function markConversationNotificationsRead(
  db: DbExecutor,
  userId: number,
  conversationId: number
): Promise<void> {
  try {
    await execRun(
      db,
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = 'message' AND related_id = ? AND is_read = 0",
      [userId, conversationId]
    );
  } catch (error) {
    console.error("[notifications] markConversationNotificationsRead failed", error);
  }
}

export async function markAllNotificationsRead(db: DbExecutor, userId: number): Promise<void> {
  await execRun(db, "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [userId]);
}

export async function markNotificationRead(
  db: DbExecutor,
  userId: number,
  notificationId: number
): Promise<boolean> {
  const affected = await execRun(
    db,
    "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ? AND is_read = 0",
    [notificationId, userId]
  );
  if (affected > 0) return true;
  const rows = await execQuery(db, "SELECT id FROM notifications WHERE id = ? AND user_id = ?", [
    notificationId,
    userId,
  ]);
  return rows.length > 0;
}

export async function unreadNotificationCount(db: DbExecutor, userId: number): Promise<number> {
  const rows = await execQuery<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
    [userId]
  );
  return Number(rows[0]?.count ?? 0);
}
