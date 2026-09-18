import { Router, type Request, type Response, type NextFunction } from "express";
import { normalizePhoneNumber, requestCode, verifyCode, getUserIdForSession, getDisplayName, logout } from "../services/auth.js";
import { sendSms } from "../services/sms.js";

const router = Router();

/**
 * Middleware for any route that needs to know WHO is calling. Pulls the
 * userId from a verified session token — never from client-supplied input
 * (an earlier version of these routes trusted a `userId` query/body param
 * directly, which meant anyone could read or act on ANY user's data just by
 * passing a different string; real accounts close that hole).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? getUserIdForSession(token) : null;
  if (!userId) return res.status(401).json({ error: "Not logged in." });
  (req as any).userId = userId;
  next();
}

/**
 * Non-blocking stand-in for requireAuth — kept around unused, in case there's
 * ever a reason to go back to frictionless solo testing (falls back to a
 * single shared "demo-user" when no token is present).
 */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? getUserIdForSession(token) : null;
  (req as any).userId = userId ?? "demo-user";
  next();
}

/**
 * Step 1 of login: text a 6-digit code to the given phone number. Phone
 * number IS the account identity — the same one texting or calling Nova's
 * number resolves to (see services/auth.ts's verifyCode) — so connecting
 * Gmail/Calendar/etc. here makes them available on every channel, not just
 * the web app.
 */
router.post("/request-code", async (req, res) => {
  const phoneNumber = normalizePhoneNumber(String(req.body?.phoneNumber ?? ""));
  if (!phoneNumber) return res.status(400).json({ error: "That doesn't look like a valid phone number." });

  const code = requestCode(phoneNumber);
  try {
    await sendSms(phoneNumber, `Your Nova verification code is ${code}`);
  } catch (err: any) {
    console.error(`[auth] couldn't text a verification code to ${phoneNumber}:`, err?.message ?? err);
    // Twilio not configured yet, or the send genuinely failed — the code is
    // still valid for the next 5 minutes, so log it as a fallback rather
    // than leaving the user with no way to get it at all.
    console.log(`[auth] verification code for ${phoneNumber}: ${code}`);
  }
  res.json({ sent: true });
});

/** Step 2 of login: verify the code, get back a session token. `displayName` is optional and purely cosmetic — see services/auth.ts's verifyCode. */
router.post("/verify-code", (req, res) => {
  const phoneNumber = normalizePhoneNumber(String(req.body?.phoneNumber ?? ""));
  const code = String(req.body?.code ?? "");
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : undefined;
  if (!phoneNumber || !code) return res.status(400).json({ error: "phoneNumber and code are required" });

  const result = verifyCode(phoneNumber, code, displayName);
  if (result.ok === false) return res.status(400).json({ error: result.error });
  res.json({ token: result.token, userId: result.userId, displayName: result.displayName });
});

/** Lets the frontend check whether a stored session token is still valid (e.g. after a page reload), and re-fetch the current display name. */
router.get("/me", requireAuth, (req, res) => {
  const userId = (req as any).userId;
  res.json({ userId, displayName: getDisplayName(userId) });
});

router.post("/logout", (req, res) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) logout(token);
  res.json({ success: true });
});

export default router;
