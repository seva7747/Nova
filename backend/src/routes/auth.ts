import { Router, type Request, type Response, type NextFunction } from "express";
import { normalizePhoneNumber, requestCode, verifyCode, getUserIdForSession, logout } from "../services/auth.js";

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
 * Non-blocking stand-in for requireAuth, wired into the app's routes for now
 * instead of it: the phone-login flow above is fully built, but real accounts
 * are on pause while just testing Nova/connectors directly (no login step in
 * the way). Resolves userId from a session token when one's actually present
 * (so logging in still works if you do it), otherwise falls back to a single
 * shared "demo-user" — the same no-accounts behavior as before Phase 1.
 * Swap a route from this back to requireAuth to make login required again.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? getUserIdForSession(token) : null;
  (req as any).userId = userId ?? "demo-user";
  next();
}

/** Step 1 of login: text a 6-digit code to the given phone number. */
router.post("/request-code", (req, res) => {
  const phoneNumber = normalizePhoneNumber(String(req.body?.phoneNumber ?? ""));
  if (!phoneNumber) return res.status(400).json({ error: "That doesn't look like a valid phone number." });

  const code = requestCode(phoneNumber);
  // TODO once Twilio is wired up: send `code` as a real text to `phoneNumber`
  // via the Twilio Messaging API instead of just logging it. Until then this
  // IS the delivery mechanism — check the backend terminal for the code.
  console.log(`[auth] verification code for ${phoneNumber}: ${code}`);
  res.json({ sent: true });
});

/** Step 2 of login: verify the code, get back a session token. */
router.post("/verify-code", (req, res) => {
  const phoneNumber = normalizePhoneNumber(String(req.body?.phoneNumber ?? ""));
  const code = String(req.body?.code ?? "");
  if (!phoneNumber || !code) return res.status(400).json({ error: "phoneNumber and code are required" });

  const result = verifyCode(phoneNumber, code);
  if (result.ok === false) return res.status(400).json({ error: result.error });
  res.json({ token: result.token, userId: result.userId });
});

/** Lets the frontend check whether a stored session token is still valid (e.g. after a page reload). */
router.get("/me", requireAuth, (req, res) => {
  res.json({ userId: (req as any).userId });
});

router.post("/logout", (req, res) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) logout(token);
  res.json({ success: true });
});

export default router;
