import { env } from "../config.js";
import { executeComposioTool, getAccountsByToolkit } from "../services/composio.js";
import { utcOffsetString } from "../util/time.js";

/**
 * A purpose-built wrapper around Composio's GOOGLECALENDAR_CREATE_EVENT,
 * replacing direct access to it — same philosophy as search_gmail.
 *
 * CONFIRMED BY TESTING: asked to mark a list of holidays on the calendar a
 * second time (one had already been added), the model re-created the
 * already-existing one — nothing in the raw create-event tool checks for a
 * duplicate, and there's no reliable reason to expect an LLM to remember to
 * check first, every time, especially mid-way through a long batch of
 * similar calls. Fixed the same way as the Gmail issues: put the check in
 * code, once, instead of leaving it to be reliably remembered in prose. This
 * tool looks for an existing event with the same title on the same date
 * before creating anything, and reports whether it actually created one.
 */
export const addCalendarEventTool = {
  type: "function" as const,
  name: "add_calendar_event",
  description:
    "Add an event to Google Calendar. Always use this instead of GOOGLECALENDAR_CREATE_EVENT directly — it automatically skips creating a duplicate if an event with the same title already exists on that date, which matters for any bulk or repeated request (e.g. marking a list of holidays) that might get run more than once. It also checks for a scheduling CONFLICT — a different, already-existing timed event that overlaps the requested time — and refuses to create it (returning needsConfirmation) until the user has explicitly said to go ahead anyway; call this again with confirmed:true once they do. Returns { created: true/false, skipped, reason } or { needsConfirmation: true, conflictingEvent, error }.",
  parameters: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "Event title, e.g. \"Labor Day (court closed)\"." },
      date: { type: "string", description: "The event's date as YYYY-MM-DD, in the user's local calendar." },
      startTime: { type: "string", description: "24-hour HH:MM start time. Omit entirely for an all-day marker (e.g. a holiday) — that's the common case." },
      endTime: { type: "string", description: "24-hour HH:MM end time, e.g. \"21:15\" for something running until 9:15 PM. Preferred over durationMinutes whenever you know the actual end time — handles any length correctly, including multi-hour events." },
      durationMinutes: { type: "integer", description: "Alternative to endTime: length in minutes, any positive number (e.g. 180 for three hours, not just under 60). Only used if endTime is omitted. Default 30." },
      description: { type: "string", description: "Optional longer note for the event." },
      connectedAccountId: { type: "string", description: "Which connected Calendar account to use — only needed if the user has more than one connected." },
      confirmed: {
        type: "boolean",
        description:
          "Set to true ONLY after the user has explicitly said to go ahead despite a scheduling conflict a previous call to this tool told you about. Omit entirely on a normal, first attempt — never guess this to true.",
      },
    },
    required: ["summary", "date"],
  },
};

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase();
}

function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes from `start` to `end` (both "HH:MM"), assuming `end` is later the same day unless it's actually earlier, in which case the event is treated as spanning midnight. */
function diffMinutes(start: string, end: string): number {
  const diff = minutesSinceMidnight(end) - minutesSinceMidnight(start);
  return diff > 0 ? diff : diff + 24 * 60;
}

/** A timed (not all-day) existing event's [start, end) as epoch ms, or null if it's all-day (has .date, not .dateTime) or malformed — all-day markers are deliberately excluded from conflict checks below. */
function parseEventRange(e: any): { start: number; end: number } | null {
  const startStr = e?.start?.dateTime;
  const endStr = e?.end?.dateTime;
  if (!startStr || !endStr) return null;
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

export async function runAddCalendarEvent(input: any, ctx: { userId: string; timezone?: string }) {
  // Same reasoning/fix as search_gmail's identical guard — Composio silently
  // defaults to "the first connected account" when this is ambiguous, so
  // without this, a second Calendar account never gets a real chance to be
  // picked; Nova would just write to whichever one happened to be first.
  if (!input.connectedAccountId) {
    const accounts = (await getAccountsByToolkit(ctx.userId)).googlecalendar ?? [];
    if (accounts.length > 1) {
      return {
        needsAccountSelection: true,
        accounts: accounts.map((a) => ({ connectedAccountId: a.id, label: a.label })),
        error: `This user has ${accounts.length} connected Google Calendar accounts: ${accounts
          .map((a) => a.label)
          .join(
            ", "
          )}. Do NOT guess which one — ask the user which account they mean, then call add_calendar_event again with that account's connectedAccountId once they say.`,
      };
    }
  }

  const tz = ctx.timezone || env.TIMEZONE;
  const date = String(input.date);
  const summary = String(input.summary);
  const connectedAccountId = input.connectedAccountId;

  // The day's [start, end) window, RFC3339 with the correct offset for THIS
  // specific date (not "now") — utcOffsetString is DST-aware per-date, which
  // matters for a bulk job spanning months with different DST status.
  const offset = utcOffsetString(new Date(`${date}T12:00:00Z`), tz);
  const dayStart = new Date(`${date}T00:00:00${offset}`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const listArgs: Record<string, unknown> = {
    calendarId: "primary",
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    showDeleted: false,
  };
  if (connectedAccountId) listArgs.connectedAccountId = connectedAccountId;

  const existingResult: any = await executeComposioTool(ctx.userId, "GOOGLECALENDAR_EVENTS_LIST", listArgs);
  const existingItems: any[] = existingResult?.data?.items ?? existingResult?.items ?? [];
  const duplicate = existingItems.find((e) => normalizeTitle(e?.summary ?? "") === normalizeTitle(summary));

  if (duplicate) {
    return { created: false, skipped: true, reason: `"${summary}" is already on the calendar for ${date}.`, existingEventId: duplicate.id };
  }

  // CONFIRMED BY TESTING — a real wrong action: asked to add a recurring
  // class at a specific time, Nova created it directly over a class that was
  // ALREADY on the calendar (from an earlier Canvas import) at the exact
  // same time — the duplicate check above only catches the SAME title, so a
  // genuine double-booking under a different name sailed right through.
  // Only checked for TIMED events (an all-day marker like a holiday isn't a
  // real scheduling conflict in this sense), and skipped once the user has
  // explicitly confirmed they want it anyway (confirmed:true).
  if (input.startTime && !input.confirmed) {
    const newStart = new Date(`${date}T${input.startTime}:00${offset}`).getTime();
    const totalMinutes = input.endTime
      ? diffMinutes(String(input.startTime), String(input.endTime))
      : Math.max(Number(input.durationMinutes) || 30, 1);
    const newEnd = newStart + totalMinutes * 60_000;

    const conflict = existingItems.find((e) => {
      const range = parseEventRange(e);
      if (!range) return false;
      return range.start < newEnd && newStart < range.end;
    });

    if (conflict) {
      const fmt = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
      const conflictStart = fmt(conflict.start.dateTime);
      const conflictEnd = fmt(conflict.end.dateTime);
      return {
        needsConfirmation: true,
        conflictingEvent: { summary: conflict.summary, start: conflictStart, end: conflictEnd, date },
        error: `There's already "${conflict.summary}" on the calendar from ${conflictStart} to ${conflictEnd} on ${date}, which overlaps the requested time for "${summary}". Do NOT create this yet — ask the user to confirm they really want to add it on top of the existing event, then call add_calendar_event again with confirmed:true only if they say yes.`,
      };
    }
  }

  const createArgs: Record<string, unknown> = {
    summary,
    timezone: tz,
    calendar_id: "primary",
    // CONFIRMED BY TESTING: left unset, this tool attaches a Google Meet
    // link (and invites the organizer as an attendee) to every event by
    // default — unwanted noise for something like a holiday marker, and
    // wasteful multiplied across a bulk batch of them.
    create_meeting_room: false,
  };
  if (input.description) createArgs.description = String(input.description);
  if (connectedAccountId) createArgs.connectedAccountId = connectedAccountId;

  if (input.startTime) {
    createArgs.start_datetime = `${date}T${input.startTime}:00`;
    // CONFIRMED BY TESTING — real wrong answer: the underlying Composio tool
    // splits duration into a separate hour field (0-24) and minute field
    // (0-59 ONLY, its own hard cap) rather than taking one total-minutes
    // number. This wrapper used to pass durationMinutes straight into that
    // 0-59 field and clamp anything bigger down to 59 — so a 3-hour class
    // (6:15-9:15) silently became a 1-hour one, with no error, nothing
    // wrong-looking in the request. Fixed by computing the total length
    // (from endTime when given, which is the natural way to specify one)
    // and splitting it into hour+minute ourselves instead of shoving
    // everything into the minute field alone.
    const totalMinutes = input.endTime
      ? diffMinutes(String(input.startTime), String(input.endTime))
      : Math.max(Number(input.durationMinutes) || 30, 1);
    createArgs.event_duration_hour = Math.min(Math.floor(totalMinutes / 60), 24);
    createArgs.event_duration_minutes = totalMinutes % 60;
  } else {
    // All-day marker (the common case for holidays etc.) — the create tool
    // has no dedicated "all day" flag, so a full 24h block starting at
    // midnight is the closest equivalent it actually supports.
    createArgs.start_datetime = `${date}T00:00:00`;
    createArgs.event_duration_hour = 24;
    createArgs.event_duration_minutes = 0;
  }

  const created: any = await executeComposioTool(ctx.userId, "GOOGLECALENDAR_CREATE_EVENT", createArgs);
  return { created: true, skipped: false, event: created?.data ?? created };
}
