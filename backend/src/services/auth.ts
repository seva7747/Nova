import { randomInt, randomBytes } from "node:crypto";
import { db } from "./db.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Best-effort E.164-ish normalization — good enough for one country (this
 * assumes US/Canada when no country code is given, matching who's actually
 * using this today). A real multi-country product would want a real phone
 * parsing library (e.g. libphonenumber-js) instead of this heuristic; not
 * worth the extra dependency until it's actually needed.
 */
export function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null; // last resort — still rejects obviously-not-a-phone-number input
}

/** Generates and stores a 6-digit code for `phoneNumber`, returning it so the caller can send it (SMS once Twilio is wired up; console.log for now — see routes/auth.ts). */
export function requestCode(phoneNumber: string): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(
    `INSERT INTO otp_codes (phone_number, code, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(phone_number) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`
  ).run(phoneNumber, code, Date.now() + OTP_TTL_MS);
  return code;
}

export type VerifyResult = { ok: true; userId: string; token: string } | { ok: false; error: string };

/** Checks the code, and on success finds-or-creates the user (keyed by phone number — that's also the userId used everywhere else, Composio/GPT-Live included) and issues a session token. */
export function verifyCode(phoneNumber: string, code: string): VerifyResult {
  const row = db.prepare(`SELECT code, expires_at, attempts FROM otp_codes WHERE phone_number = ?`).get(phoneNumber) as
    | { code: string; expires_at: number; attempts: number }
    | undefined;

  if (!row) return { ok: false, error: "No code was requested for this number, or it already expired — request a new one." };
  if (Date.now() > row.expires_at) {
    db.prepare(`DELETE FROM otp_codes WHERE phone_number = ?`).run(phoneNumber);
    return { ok: false, error: "That code expired — request a new one." };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare(`DELETE FROM otp_codes WHERE phone_number = ?`).run(phoneNumber);
    return { ok: false, error: "Too many wrong attempts — request a new code." };
  }
  if (row.code !== code.trim()) {
    db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_number = ?`).run(phoneNumber);
    return { ok: false, error: "That code doesn't match." };
  }

  db.prepare(`DELETE FROM otp_codes WHERE phone_number = ?`).run(phoneNumber);

  const userId = phoneNumber; // the phone number IS the userId — same value Composio/GPT-Live/tasks already key everything on
  db.prepare(
    `INSERT INTO users (id, phone_number, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(userId, phoneNumber, Date.now());

  const token = randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    token,
    userId,
    Date.now(),
    Date.now() + SESSION_TTL_MS
  );

  return { ok: true, userId, token };
}

/** Resolves a session token (from the Authorization: Bearer header) to a userId, or null if missing/expired. */
export function getUserIdForSession(token: string): string | null {
  const row = db.prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`).get(token) as
    | { user_id: string; expires_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row.user_id;
}

export function logout(token: string) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}
