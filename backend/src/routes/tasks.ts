import { Router } from "express";
import { getTaskStatus, takeUnannounced } from "../services/tasks.js";
import { attachUser } from "./auth.js";

const router = Router();

/** Polled by the frontend to drive the "working on something big" orb state — see tasks.ts. */
router.get("/status", attachUser, (req, res) => {
  res.json(getTaskStatus((req as any).userId));
});

/**
 * CONFIRMED BY TESTING (real feedback): a finished task used to only ever
 * get mentioned reactively, the next time the user said anything at all —
 * if nobody spoke to Nova again for a while, it just sat there silently
 * "done," costing nothing but also never actually telling the user. The
 * frontend now proactively speaks a finished task's result the moment it's
 * next safe to (see useNovaConversation.ts's task-status poll) — this route
 * is what it calls right after, so takeUnannounced's flag flips and the
 * OLDER reactive "Done — " mechanism in liveDelegate.ts never mentions the
 * same result a second time.
 */
router.post("/mark-announced", attachUser, (req, res) => {
  takeUnannounced((req as any).userId);
  res.status(204).end();
});

export default router;
