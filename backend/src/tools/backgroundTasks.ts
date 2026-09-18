import { getTasks, requestCancel, describeTask } from "../services/tasks.js";

/**
 * Lets the user talk about a background task while it's still running — "what
 * are you working on?", "how far along is that?", "cancel it" — instead of
 * the task being a black box until it finishes. See services/tasks.ts.
 */

export const checkBackgroundTasksTool = {
  name: "check_background_tasks",
  description:
    "See what Nova is working on in the background — call this whenever the user asks what task is running, how it's going, its progress, or whether something's done yet. Returns running tasks (the original request, how long it's been going, how many actions are done, the most recent ones) and recently finished ones with their results. Describe progress in plain words, e.g. \"I've added 7 holidays so far, most recently Labor Day\" — don't read ids out loud.",
  input_schema: { type: "object" as const, properties: {} },
};

export const cancelBackgroundTaskTool = {
  name: "cancel_background_task",
  description:
    "Stop a background task — call this when the user says to cancel, stop, or never mind a task that's running. Omit taskId to stop everything running (the normal case — usually there's only one); pass one from check_background_tasks only if several are running and the user named a specific one. It stops after the step already in progress, so a few more actions may still complete — say how many were done.",
  input_schema: {
    type: "object" as const,
    properties: {
      taskId: { type: "string", description: "Only when several tasks are running and the user picked one." },
    },
  },
};

export function runCheckBackgroundTasks(ctx: { userId: string }) {
  const list = getTasks(ctx.userId);
  const running = list.filter((t) => t.state === "running").map(describeTask);
  const recentlyFinished = list
    .filter((t) => t.state !== "running")
    .slice(-3)
    .map(describeTask);
  if (running.length === 0 && recentlyFinished.length === 0) return { running: [], note: "Nothing is running in the background." };
  return { running, recentlyFinished };
}

export function runCancelBackgroundTask(input: any, ctx: { userId: string }) {
  const cancelled = requestCancel(ctx.userId, input?.taskId ? String(input.taskId) : undefined);
  if (cancelled.length === 0) return { cancelled: [], note: "There was no running task to cancel." };
  return {
    cancelled: cancelled.map((t) => ({ request: t.description, actionsCompletedSoFar: t.actions.length })),
    note: "Stopping after the step that's already in progress — a few more actions may still finish.",
  };
}
