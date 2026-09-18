/**
 * Tracks long-running background tasks per user — e.g. "mark every 2026
 * court holiday on my calendar," which needs far more tool-call rounds than
 * fit in one quick voice turn. See liveDelegate.ts's continueBackgroundStep
 * for how a task actually gets driven to completion; this module is just
 * the shared status so the frontend can show a "working on something big"
 * indicator (GET /api/tasks/status) without needing its own connection to
 * whatever's doing the work.
 *
 * Deliberately a plain in-memory Map, matching this project's existing
 * caches (composio.ts's tools/accounts caches) — fine for a single-process
 * personal-use app; would need a real store to survive a restart or run
 * across multiple backend instances.
 */
export type TaskStatus = {
  active: boolean;
  description?: string;
  startedAt?: number;
  result?: string;
  completedAt?: number;
};

const tasks = new Map<string, TaskStatus>(); // userId -> status of their most recent background task

export function startTask(userId: string, description: string) {
  tasks.set(userId, { active: true, description, startedAt: Date.now() });
}

export function finishTask(userId: string, result: string) {
  const prev = tasks.get(userId);
  tasks.set(userId, { active: false, description: prev?.description, startedAt: prev?.startedAt, result, completedAt: Date.now() });
}

export function getTaskStatus(userId: string): TaskStatus {
  return tasks.get(userId) ?? { active: false };
}
