import { Router } from "express";
import { takeDueReminder } from "../services/reminders.js";
import { attachUser } from "./auth.js";

const router = Router();

/**
 * Polled by the frontend (cheap plain HTTP — no GPT-Live session needed)
 * every couple seconds so a reminder set during a PAST live session still
 * gets spoken exactly when it's due, even though that session is long
 * closed by then. See useNovaConversation.ts for what it does with a "yes,
 * something's due" answer — opens a brand-new short-lived live session
 * specifically to announce it, so nothing pays for GPT-Live time while
 * waiting for the reminder.
 */
router.get("/due", attachUser, (req, res) => {
  const due = takeDueReminder((req as any).userId);
  res.json({ due: due ? { message: due.message } : null });
});

export default router;
