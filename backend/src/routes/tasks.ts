import { Router } from "express";
import { getTaskStatus } from "../services/tasks.js";
import { attachUser } from "./auth.js";

const router = Router();

/** Polled by the frontend to drive the "working on something big" orb state — see tasks.ts. */
router.get("/status", attachUser, (req, res) => {
  res.json(getTaskStatus((req as any).userId));
});

export default router;
