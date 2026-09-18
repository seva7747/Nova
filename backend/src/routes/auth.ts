import { Router, type Request, type Response, type NextFunction } from "express";
import { signIn, getUserIdForSession, getDisplayName, logout } from "../services/auth.js";

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
 * Non-blocking stand-in for requireAuth — was wired into the app's routes
 * while accounts were on pause for solo testing (no login step in the way),
 * falling back to a single shared "demo-user" when no token was present.
 * Now that more than one person actually uses Nova, every route uses
 * requireAuth instead so connected accounts don't collide. Kept here,
 * unused, in case there's ever a reason to go back to frictionless testing.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userId = token ? getUserIdForSession(token) : null;
  (req as any).userId = userId ?? "demo-user";
  next();
}

/**
 * Sign in with just a first + last name — no password, no verification code.
 * Creates the account on first use; signing in again with the same name
 * returns to that same account. See services/auth.ts's signIn for the real
 * tradeoff this makes (good enough to tell people apart, not real security).
 */
router.post("/sign-in", (req, res) => {
  const firstName = String(req.body?.firstName ?? "");
  const lastName = String(req.body?.lastName ?? "");
  const result = signIn(firstName, lastName);
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
