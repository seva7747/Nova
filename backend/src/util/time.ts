/**
 * Timezone-correct day-boundary math, shared by anything that needs to turn
 * "today"/"3 days ago"/etc. into an exact instant — used instead of letting
 * an LLM do this arithmetic itself (see tools/gmailSearch.ts) or trusting a
 * third-party API's own date parsing (Gmail's after:/before: silently
 * assumes a fixed reference timezone for plain YYYY/MM/DD dates, regardless
 * of the user's real one — see the comment in gmailSearch.ts).
 */

/** The UTC offset Intl reports for `date` in `timeZone`, as "+HH:MM"/"-HH:MM" — DST-correct because it's computed fresh for the exact moment given, not a fixed year-round assumption. */
export function utcOffsetString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0"; // e.g. "GMT-7"
  const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}

/** Unix epoch seconds for local midnight, `dayOffset` days from `date`, in `timeZone`. */
export function localMidnightEpochSeconds(date: Date, timeZone: string, dayOffset: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const offset = utcOffsetString(date, timeZone);
  const midnightToday = new Date(`${y}-${mo}-${d}T00:00:00${offset}`);
  return Math.floor(midnightToday.getTime() / 1000) + dayOffset * 86400;
}
