import { scheduleReminder } from "../services/reminders.js";

/**
 * A short, precise timer/reminder — "remind me in 30 seconds to check the
 * oven," "set a timer for 10 minutes," "remind me in 2 hours to call back."
 * Deliberately separate from add_calendar_event, which only understands a
 * specific calendar date — this is for anything measured in seconds/
 * minutes/hours from right now, not a day on the calendar.
 */
export const setReminderTool = {
  name: "set_reminder",
  description:
    'Sets a short reminder/timer that Nova will proactively speak on her own when it\'s due, with no need for the user to ask again. Use this for "remind me in N seconds/minutes/hours," "set a timer for N minutes," etc. — NOT for anything tied to a specific calendar date (use add_calendar_event for those instead). Once you call this, just acknowledge it normally (e.g. "Okay, I\'ll remind you in 30 seconds") — the actual reminder is delivered separately later, automatically, by speaking the "message" you give here VERBATIM and word-for-word — so keep it plain, short, and exactly what should be said out loud, never a note-to-self or a creative flourish.',
  input_schema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description:
          'What to say when the reminder fires, phrased exactly as Nova should say it out loud — this gets spoken VERBATIM later, with no rephrasing, so write it as a complete, natural sentence, not a note-to-self. If the user said what to be reminded of, use that (e.g. "time to check the oven"). If they only asked for a plain timer with no stated reason ("set a timer for one minute," "remind me in 30 seconds"), just use a short, plain, generic sentence naming the duration — e.g. "Your one-minute timer is up." or "Your 30-second reminder is done." — never invent a reason, topic, or embellishment that wasn\'t actually said.',
      },
      delaySeconds: {
        type: "integer",
        description: "How many seconds from right now the reminder should fire. Convert minutes/hours to seconds yourself (10 minutes = 600, 2 hours = 7200).",
      },
    },
    required: ["message", "delaySeconds"],
  },
};

export function runSetReminder(input: any, ctx: { userId: string }) {
  const message = String(input.message ?? "").trim() || "your reminder";
  const delaySeconds = Math.max(1, Math.round(Number(input.delaySeconds) || 0));
  const reminder = scheduleReminder(ctx.userId, message, delaySeconds);
  return { scheduled: true, delaySeconds, dueAt: new Date(reminder.dueAt).toISOString() };
}
