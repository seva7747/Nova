/**
 * Adds a ready-to-speak local-time twin next to every UTC timestamp in a
 * tool result — e.g. `due_at: "2026-09-18T06:59:00Z"` gains
 * `due_at_local: "Thursday, Sep 17, 11:59 PM PDT (today)"`.
 *
 * CONFIRMED BY TESTING: Canvas returns every date (due_at, lock_at,
 * unlock_at, ...) as a raw UTC instant, and the model read them as if they were
 * already local — an assignment due 11:59 PM tonight Pacific (06:59Z the next
 * morning) came out as "due at 6:59 AM tomorrow", and in another run "due
 * tonight at 6:59 AM, in about 11 hours". Same class of bug search_gmail
 * already fixed with its `receivedAt` field: do the timezone math in code,
 * once, and hand the model a string it can read out as-is. The original
 * field is left untouched so ids/timestamps can still be passed back into
 * later tool calls unchanged.
 */

// Only full date-times with an explicit zone (Z or ±HH:MM) — a bare date like
// "2026-09-18" has no instant to convert, and touching it would be wrong.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function localDayKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone }); // YYYY-MM-DD in that zone
}

function relativeDay(date: Date, timeZone: string): string {
  const day = new Date(`${localDayKey(date, timeZone)}T00:00:00Z`).getTime();
  const today = new Date(`${localDayKey(new Date(), timeZone)}T00:00:00Z`).getTime();
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return " (today)";
  if (diff === 1) return " (tomorrow)";
  if (diff === -1) return " (yesterday)";
  return "";
}

function formatLocal(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const text = date.toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return text + relativeDay(date, timeZone);
}

export function addLocalTimes(value: any, timeZone: string, depth = 0): any {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => addLocalTimes(v, timeZone, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, any> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = addLocalTimes(v, timeZone, depth + 1);
    if (typeof v === "string" && ISO_WITH_ZONE.test(v) && !(`${key}_local` in value)) {
      const local = formatLocal(v, timeZone);
      if (local) out[`${key}_local`] = local;
    }
  }
  return out;
}
