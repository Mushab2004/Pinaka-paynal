import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { execute, queryOne, query } from "../config/database";
import { asyncHandler, badRequest, conflict, notFound, unauthorized, forbidden, digitsOnly, toInt } from "../utils/http";
import type { RowDataPacket } from "mysql2/promise";
import { dataString, isValidEmail } from "../utils/validate";
import { createToken, verifyToken as verifyJwt } from "../utils/jwt";
import { requireAuth } from "../middleware/auth";
import { env } from "../config/env";

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  full_name: string;
  email: string;
  password_hash: string;
  role: string;
  phone: string | null;
  address: string | null;
  avatar_url: string | null;
}

const SUPPORTED_QUESTION_IDS = [1, 2, 3, 4, 5, 6];
const MIN_PASSWORD_LENGTH = 6;

function normalizeAnswer(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getClientIp(req: any): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}

async function recordRecoveryAttempt(email: string, ip: string) {
  await execute("INSERT INTO password_recovery_attempts (email, ip) VALUES (?, ?)", [email, ip]);
}

async function isRecoveryRateLimited(email: string, ip: string): Promise<boolean> {
  const emailRows = await query(
    "SELECT COUNT(*) AS c FROM password_recovery_attempts WHERE email = ? AND attempted_at > (NOW() - INTERVAL 15 MINUTE)",
    [email]
  );
  const ipRows = await query(
    "SELECT COUNT(*) AS c FROM password_recovery_attempts WHERE ip = ? AND attempted_at > (NOW() - INTERVAL 15 MINUTE)",
    [ip]
  );
  return Number(emailRows[0]?.c ?? 0) >= 5 || Number(ipRows[0]?.c ?? 0) >= 30;
}

function parseSecurityQuestionsInput(body: Record<string, unknown>): Array<{ question_id: number; answer: string }> {
  let raw: unknown = body.security_questions ?? body.securityQuestions ?? body.security_answers ?? body.securityAnswers ?? body.answers;

  // Accept object map { "1": "answer" } as well.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({ question_id: k, answer: v }));
  }

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      const qid = item?.question_id ?? item?.questionId ?? item?.id ?? item?.qid ?? item?.q;
      const answer = item?.answer ?? item?.answer_text ?? item?.value ?? item?.text;
      return { question_id: toInt(qid), answer: String(answer ?? "") };
    })
    .filter((x) => x.question_id > 0);
}

function validateSecurityQuestions(items: Array<{ question_id: number; answer: string }>) {
  if (items.length !== 3) throw badRequest("Exactly three security questions are required");
  const ids = items.map((i) => i.question_id);
  for (const id of ids) {
    if (!SUPPORTED_QUESTION_IDS.includes(id)) throw badRequest("Invalid security question");
  }
  const unique = new Set(ids);
  if (unique.size !== 3) throw badRequest("Security questions must be different");
  for (const item of items) {
    if (!normalizeAnswer(item.answer)) throw badRequest("All security answers are required");
  }
}

async function saveSecurityAnswers(userId: number, items: Array<{ question_id: number; answer: string }>) {
  await execute("DELETE FROM user_security_answers WHERE user_id = ?", [userId]);
  for (const item of items) {
    const hash = await bcrypt.hash(normalizeAnswer(item.answer), 10);
    await execute(
      "INSERT INTO user_security_answers (user_id, question_id, answer_hash) VALUES (?, ?, ?)",
      [userId, item.question_id, hash]
    );
  }
}

// POST /auth/register
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const fullName = String(body.full_name ?? "").trim();
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    let role = String(body.role ?? "buyer");
    const phone = digitsOnly(body.phone);
    const address = String(body.address ?? "").trim();
    const shopName = String(body.shop_name ?? "").trim();
    const shopAddress = String(body.shop_address ?? "").trim();
    const gcashNumber = digitsOnly(body.gcash_number);

    const confirmPasswordRaw =
      body.confirm_password ?? body.confirmPassword ?? body.password_confirmation ?? body.confirm;
    if (confirmPasswordRaw !== undefined && confirmPasswordRaw !== null && String(confirmPasswordRaw) !== "") {
      if (String(confirmPasswordRaw) !== password) {
        throw badRequest("Passwords do not match");
      }
    }

    if (!fullName || !email || !password) {
      throw badRequest("Name, email, and password are required");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (!isValidEmail(email)) throw badRequest("Invalid email");
    if (role !== "buyer" && role !== "seller") role = "buyer";

    if (fullName.length > 100) throw badRequest("Name is too long (max 100 characters)");
    if (email.length > 100) throw badRequest("Email is too long (max 100 characters)");
    if (shopName.length > 150) throw badRequest("Shop name is too long (max 150 characters)");

    if (role === "seller") {
      if (phone.length < 7 || phone.length > 15) {
        throw badRequest("A valid contact number is required for sellers");
      }
      if (!address) throw badRequest("An address is required for sellers");
      if (!shopName) throw badRequest("Shop name is required for sellers");
      if (!shopAddress) throw badRequest("Shop address is required for sellers");
      if (gcashNumber.length < 10 || gcashNumber.length > 15) {
        throw badRequest("A valid GCash number is required for sellers");
      }
    }

    const securityItems = parseSecurityQuestionsInput(body);
    // Registration must include security questions when provided by new forms.
    // Require them for new registrations to satisfy feature.
    validateSecurityQuestions(securityItems);

    const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) throw conflict("Email already registered");

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await execute(
      "INSERT INTO users (full_name, email, password_hash, role, phone, address, shop_name, shop_address, gcash_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        fullName,
        email,
        passwordHash,
        role,
        phone || null,
        address || null,
        shopName || null,
        shopAddress || null,
        gcashNumber || null,
      ]
    );

    await saveSecurityAnswers(result.insertId, securityItems);

    const user = await queryOne<UserRow>(
      "SELECT id, full_name, email, role, phone, address, shop_name, shop_address, gcash_number FROM users WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      token: createToken(result.insertId, role),
      user,
    });
  })
);

// POST /auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");

    if (!email || !password) throw badRequest("Email and password are required");

    const ip = getClientIp(req);

    const emailAttempts = await query(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > (NOW() - INTERVAL 15 MINUTE)",
      [email]
    );
    const ipAttempts = await query(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at > (NOW() - INTERVAL 15 MINUTE)",
      [ip]
    );
    if (Number(emailAttempts[0]?.c ?? 0) >= 5 || Number(ipAttempts[0]?.c ?? 0) >= 30) {
      res.status(429).json({
        error: "Too many failed login attempts. Please wait 15 minutes and try again.",
      });
      return;
    }

    const user = await queryOne<UserRow>(
      "SELECT id, full_name, email, password_hash, role, phone, address, avatar_url FROM users WHERE email = ? AND is_active = 1",
      [email]
    );

    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !ok) {
      await execute("INSERT INTO login_attempts (email, ip) VALUES (?, ?)", [email, ip]);
      await execute("DELETE FROM login_attempts WHERE attempted_at < (NOW() - INTERVAL 1 DAY)").catch(() => undefined);
      throw unauthorized("Invalid email or password");
    }

    await execute("DELETE FROM login_attempts WHERE email = ?", [email]);

    const { password_hash: _omit, ...safeUser } = user;
    res.json({
      success: true,
      token: createToken(user.id, user.role),
      user: safeUser,
    });
  })
);

// GET /auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await queryOne(
      "SELECT id, full_name, email, role, phone, address, avatar_url FROM users WHERE id = ?",
      [req.user!.user_id]
    );
    if (!user) throw notFound("User not found");
    res.json({ user });
  })
);

// GET /auth/security-questions (public list)
router.get(
  "/security-questions",
  asyncHandler(async (_req, res) => {
    const rows = await query("SELECT id, question_text FROM security_questions ORDER BY id");
    res.json({ questions: rows });
  })
);

// GET has/security questions status
router.get(
  "/security-questions/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT COUNT(*) AS c FROM user_security_answers WHERE user_id = ?", [req.user!.user_id]);
    res.json({ configured: Number(rows[0]?.c ?? 0) >= 3 });
  })
);

// PUT /auth/security-questions (enrollment / update for authenticated user)
router.put(
  "/security-questions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = String(body.password ?? body.current_password ?? body.currentPassword ?? "");
    if (!password) throw badRequest("Current password is required");

    const user = await queryOne<UserRow>("SELECT id, password_hash FROM users WHERE id = ?", [req.user!.user_id]);
    if (!user) throw notFound("User not found");
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw unauthorized("Invalid password");

    const items = parseSecurityQuestionsInput(body);
    validateSecurityQuestions(items);
    await saveSecurityAnswers(req.user!.user_id, items);
    res.json({ success: true });
  })
);

// Forgot password: retrieve questions
router.post(
  "/forgot/questions",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? "").trim();
    if (!email || !isValidEmail(email)) throw badRequest("Valid email is required");

    const ip = getClientIp(req);
    if (await isRecoveryRateLimited(email, ip)) {
      res.status(429).json({ error: "Too many recovery attempts. Please wait 15 minutes and try again." });
      return;
    }

    const user = await queryOne<UserRow>("SELECT id FROM users WHERE email = ? AND is_active = 1", [email]);
    if (!user) {
      // Generic to avoid account enumeration
      throw notFound("Account not found or recovery is unavailable");
    }

    const answers = await query("SELECT question_id FROM user_security_answers WHERE user_id = ?", [user.id]);
    if (answers.length < 3) {
      throw notFound("Account not found or recovery is unavailable");
    }

    const questions = await query(
      `SELECT sq.id, sq.question_text
       FROM user_security_answers usa JOIN security_questions sq ON sq.id = usa.question_id
       WHERE usa.user_id = ?
       ORDER BY sq.id`,
      [user.id]
    );

    res.json({ success: true, questions: questions.map((q: any) => ({ id: q.id, question: q.question_text, question_text: q.question_text })) });
  })
);

// Forgot password: verify answers
router.post(
  "/forgot/verify",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? "").trim();
    if (!email || !isValidEmail(email)) throw badRequest("Valid email is required");

    const ip = getClientIp(req);
    if (await isRecoveryRateLimited(email, ip)) {
      res.status(429).json({ error: "Too many recovery attempts. Please wait 15 minutes and try again." });
      return;
    }

    const user = await queryOne<UserRow>("SELECT id FROM users WHERE email = ? AND is_active = 1", [email]);
    if (!user) throw notFound("Account not found or recovery is unavailable");

    const userAnswerRows = await query(
      "SELECT question_id, answer_hash FROM user_security_answers WHERE user_id = ?",
      [user.id]
    );
    if (userAnswerRows.length < 3) throw notFound("Account not found or recovery is unavailable");

    const provided = parseSecurityQuestionsInput(body);
    if (provided.length < 3) throw badRequest("All three security answers are required");

    // Map user question -> hash
    const hashByQuestion = new Map<number, string>();
    for (const r of userAnswerRows) hashByQuestion.set(Number(r.question_id), String(r.answer_hash));

    // Ensure provided covers at least the user's questions
    let allCorrect = true;
    for (const ua of userAnswerRows) {
      const qid = Number(ua.question_id);
      const candidate = provided.find((p) => p.question_id === qid);
      if (!candidate) { allCorrect = false; break; }
      const ok = await bcrypt.compare(normalizeAnswer(candidate.answer), String(ua.answer_hash));
      if (!ok) { allCorrect = false; break; }
    }

    if (!allCorrect) {
      await recordRecoveryAttempt(email, ip);
      await execute("DELETE FROM password_recovery_attempts WHERE attempted_at < (NOW() - INTERVAL 1 DAY)").catch(() => undefined);
      throw unauthorized("Security answers are incorrect");
    }

    const resetToken = jwt.sign(
      { user_id: user.id, purpose: "password_reset" },
      env.jwtSecret,
      { algorithm: "HS256", expiresIn: "10m" }
    );

    res.json({ success: true, reset_token: resetToken });
  })
);

// Forgot password: reset password
router.post(
  "/forgot/reset",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resetToken = String(body.reset_token ?? body.token ?? body.resetToken ?? "").trim();
    const password = String(body.password ?? body.new_password ?? body.newPassword ?? "");
    const confirmPassword = String(
      body.confirm_password ?? body.confirmPassword ?? body.password_confirmation ?? body.confirm ?? ""
    );

    if (!resetToken) throw badRequest("Reset token is required");
    if (!password) throw badRequest("New password is required");
    if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (confirmPassword && confirmPassword !== password) throw badRequest("Passwords do not match");

    let payload: any;
    try {
      payload = jwt.verify(resetToken, env.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      throw unauthorized("Invalid or expired reset token");
    }
    if (!payload || typeof payload.user_id !== "number" || payload.purpose !== "password_reset") {
      throw unauthorized("Invalid reset token");
    }

    const user = await queryOne<UserRow>("SELECT id FROM users WHERE id = ? AND is_active = 1", [payload.user_id]);
    if (!user) throw notFound("User not found");

    const passwordHash = await bcrypt.hash(password, 10);
    await execute("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [passwordHash, user.id]);

    // Invalidate recovery attempts
    await execute("DELETE FROM password_recovery_attempts WHERE email = (SELECT email FROM users WHERE id = ?)", [user.id]).catch(() => undefined);
    await execute("DELETE FROM login_attempts WHERE email = (SELECT email FROM users WHERE id = ?)", [user.id]).catch(() => undefined);

    res.json({ success: true, message: "Password updated successfully" });
  })
);

export default router;
