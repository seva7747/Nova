/**
 * Tracks long-running background tasks per user — e.g. "mark every 2026
 * court holiday on my calendar," which needs far more tool-call rounds than
 * fit in one quick voice turn. liveDelegate.ts / smsDelegate.ts drive a task
 * to completion; this module is the shared state around it:
 *   - the frontend's yellow/green task indicator (GET /api/tasks/status)
 *   - the brain's check_background_tasks / cancel_background_task tools
 *     (tools/backgroundTasks.ts), so the user can ask "what are you working
 *     on?", "how far along is it?", or "cancel that" mid-task
 *   - the "by the way" handoff: a finished voice task isn't spoken the moment
 *     it ends (the user may be in the middle of something else) — it waits,
 *     unannounced, until their next question picks it up (takeUnannounced).
 *
 * Deliberately a plain in-memory Map, matching this project's existing
 * caches (composio.ts's tools/accounts caches) — fine for a single-process
 * personal-use app; would need a real store to survive a restart or run
 * across multiple backend instances.
 */

export type TaskState = "running" | "done" | "failed" | "cancelled";

export type Task = {
  id: string;
  description: string; // the user's original request, e.g. "mark every court holiday this year"
  state: TaskState;
  startedAt: number;
  completedAt?: number;
  steps: number;
  actions: string[]; // human-readable log of every tool action completed, oldest first
  result?: string;
  cancelRequested: boolean;
  announced: boolean; // has the user been told the outcome yet?
};

const MAX_TASKS_KEPT = 10;
const tasks = new Map<string, Task[]>(); // userId -> their tasks, oldest first

function listFor(userId: string): Task[] {
  let list = tasks.get(userId);
  if (!list) {
    list = [];
    tasks.set(userId, list);
  }
  return list;
}

export function startTask(userId: string, description: string): Task {
  const list = listFor(userId);
  const task: Task = {
    id: Math.random().toString(36).slice(2, 8),
    description,
    state: "running",
    startedAt: Date.now(),
    steps: 0,
    actions: [],
    cancelRequested: false,
    announced: false,
  };
  list.push(task);
  // Drop the oldest settled tasks, never a running or still-unannounced one.
  while (list.length > MAX_TASKS_KEPT) {
    const i = list.findIndex((t) => t.state !== "running" && t.announced);
    if (i < 0) break;
    list.splice(i, 1);
  }
  return task;
}

export function recordProgress(task: Task, actions: string[]) {
  task.steps++;
  task.actions.push(...actions);
}

/** `announced: true` when the caller already told the user (e.g. SMS texts the result right away). */
export function finishTask(task: Task, state: Exclude<TaskState, "running">, result: string, announced = false) {
  task.state = state;
  task.result = result;
  task.completedAt = Date.now();
  task.announced = announced;
}

export function getTasks(userId: string): Task[] {
  return tasks.get(userId) ?? [];
}

/** Flags running tasks to stop after their current step — all of them, or just `taskId`. A step already in flight can't be interrupted mid-API-call. */
export function requestCancel(userId: string, taskId?: string): Task[] {
  const targets = getTasks(userId).filter((t) => t.state === "running" && (!taskId || t.id === taskId));
  for (const t of targets) t.cancelRequested = true;
  return targets;
}

/** Finished tasks the user hasn't heard about yet — marked announced as they're taken. */
export function takeUnannounced(userId: string): Task[] {
  const pending = getTasks(userId).filter((t) => t.state !== "running" && !t.announced);
  for (const t of pending) t.announced = true;
  return pending;
}

/** Undo takeUnannounced when the turn that was going to mention them failed. */
export function restoreUnannounced(pending: Task[]) {
  for (const t of pending) t.announced = false;
}

/**
 * Human-readable list of the tool actions that actually ran in messages[from..]
 * (Anthropic message shape). Tool calls that came back as the synthetic
 * "Paused here" result (see llm.ts) didn't run and get retried next step, so
 * they're skipped rather than double-counted.
 */
export function actionsSince(messages: any[], from: number): string[] {
  const calls = new Map<string, { name: string; input: any }>();
  const done: string[] = [];
  for (const m of messages.slice(from)) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (m.role === "assistant" && block?.type === "tool_use") {
        calls.set(block.id, { name: block.name, input: block.input });
      } else if (m.role === "user" && block?.type === "tool_result") {
        if (JSON.stringify(block.content ?? "").includes("Paused here")) continue;
        const call = calls.get(block.tool_use_id);
        if (call) done.push(describeAction(call.name, call.input));
      }
    }
  }
  return done;
}

function describeAction(name: string, input: any): string {
  if (input?.summary) return `${name}: ${input.summary}${input.date ? ` (${input.date})` : ""}`;
  const firstText = Object.values(input ?? {}).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return firstText ? `${name}: ${firstText.slice(0, 60)}` : name;
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"}`;
}

/** Plain summary of one task, shaped for the brain to read out loud. */
export function describeTask(t: Task) {
  return {
    id: t.id,
    request: t.description,
    state: t.state,
    ...(t.state === "running"
      ? { runningFor: ago(Date.now() - t.startedAt), stoppingSoon: t.cancelRequested || undefined }
      : { finished: `${ago(Date.now() - (t.completedAt ?? Date.now()))} ago`, result: t.result }),
    actionsCompleted: t.actions.length,
    recentActions: t.actions.slice(-5),
  };
}

/**
 * What the frontend polls. `active` = something is running (yellow pulse);
 * `done` = nothing running but a finished task hasn't been mentioned to the
 * user yet (green) — it clears once the next question's "by the way" goes out.
 */
export function getTaskStatus(userId: string) {
  const list = getTasks(userId);
  const running = list.filter((t) => t.state === "running");
  const unannounced = list.filter((t) => t.state !== "running" && !t.announced);
  const latest = unannounced[unannounced.length - 1];
  return {
    active: running.length > 0,
    runningCount: running.length,
    description: running[0]?.description,
    actionsCompleted: running[0]?.actions.length ?? 0,
    done: running.length === 0 && unannounced.length > 0,
    result: latest?.result,
  };
}
