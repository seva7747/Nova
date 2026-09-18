/**
 * Short, precise reminders/timers — "remind me in 30 seconds to check the
 * oven," "set a timer for 10 minutes." Deliberately separate from tasks.ts:
 * a task is "something Nova is working on," announced only once she's
 * spoken to again; a reminder is a specific moment to proactively speak up
 * about, with no work attached — see routes/live.ts's `announce` handling
 * and useNovaConversation.ts's polling for how that proactive speech
 * actually happens (a fresh, short-lived live session opened automatically
 * right when it's due, so nothing pays for GPT-Live time while waiting).
 *
 * Plain in-memory Map, matching this project's other per-process state
 * (composio.ts's caches, tasks.ts) — resets on a backend restart, fine for
 * a single-process personal-use app.
 */
export type Reminder = { id: string; message: string; dueAt: number; delivered: boolean };

const reminders = new Map<string, Reminder[]>(); // userId -> reminders, oldest first

function listFor(userId: string): Reminder[] {
  let list = reminders.get(userId);
  if (!list) {
    list = [];
    reminders.set(userId, list);
  }
  return list;
}

export function scheduleReminder(userId: string, message: string, delaySeconds: number): Reminder {
  const reminder: Reminder = {
    id: Math.random().toString(36).slice(2, 8),
    message,
    dueAt: Date.now() + Math.max(1, delaySeconds) * 1000,
    delivered: false,
  };
  const list = listFor(userId);
  list.push(reminder);
  // Undelivered reminders should never pile up in practice (each one gets
  // taken the moment it's due), but cap it defensively all the same.
  while (list.length > 20) list.shift();
  return reminder;
}

/** The earliest reminder that's actually due right now, if any — marks it delivered so it's only ever taken once, even if two pollers race. */
export function takeDueReminder(userId: string): Reminder | null {
  const list = listFor(userId);
  const due = list.find((r) => !r.delivered && r.dueAt <= Date.now());
  if (!due) return null;
  due.delivered = true;
  return due;
}
