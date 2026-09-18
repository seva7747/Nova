import { randomBytes } from "node:crypto";
import { db } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Best-effort E.164-ish normalization — good enough for one country (this
 * assumes US/Canada when no country code is given, matching who's actually
 * using this today). A real multi-country product would want a real phone
 * parsing library (e.g. libphonenumber-js) instead of this heuristic; not
 * worth the extra dependency until it's actually needed. Only used by the
 * SMS/Twilio path now (routes/sms.ts) — the web app signs in by name (below).
 */
export function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null; // last resort — still rejects obviously-not-a-phone-number input
}

/**
 * Turns "First Last" into a stable id — this IS the userId used everywhere
 * else (Composio connections, tasks, conversation history), so it's what
 * actually keeps two people's Gmail/Calendar/Canvas connections from
 * colliding. Lowercased and stripped to [a-z0-9-] so it's also safe to use
 * as a URL segment / SQL key without escaping.
 */
export function slugifyName(firstName: string, lastName: string): string | null {
  const slug = `${firstName}-${lastName}`
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

export type SignInResult = { ok: true; userId: string; token: string; displayName: string } | { ok: false; error: string };

/**
 * No password, no verification code — just enough to tell people apart and
 * keep their connected integrations separate, which is all that was asked
 * for right now. NOT real security: anyone who knows (or guesses) someone's
 * name can sign in as them and see their connected Gmail/Calendar/Canvas.
 * Fine for a small trusted group (cofounders, early testers); revisit before
 * this is opened up to strangers. Signing in with the same name again always
 * returns to the SAME account (display_name just gets refreshed) — two
 * different people who happen to share a name would collide onto one
 * account, which is the one real limitation of "just a name" as an identity.
 */
export function signIn(firstName: string, lastName: string): SignInResult {
  const first = firstName.trim();
  const last = lastName.trim();
  if (!first || !last) return { ok: false, error: "First and last name are both required." };

  const userId = slugifyName(first, last);
  if (!userId) return { ok: false, error: "That doesn't look like a valid name." };

  const displayName = `${first} ${last}`;
  db.prepare(
    `INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`
  ).run(userId, displayName, Date.now());

  const token = randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    token,
    userId,
    Date.now(),
    Date.now() + SESSION_TTL_MS
  );

  return { ok: true, userId, token, displayName };
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

/** The "First Last" a user typed at sign-in — falls back to the raw userId (e.g. for SMS-originated accounts, which have no display_name). */
export function getDisplayName(userId: string): string {
  const row = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId) as { display_name: string | null } | undefined;
  return row?.display_name ?? userId;
}

export function logout(token: string) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}
