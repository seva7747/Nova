/**
 * "Prove yourself wrong" pass for bulk actions.
 *
 * CONFIRMED BY TESTING: asked to "delete everything on my calendar today",
 * Nova reported "deleted all 23 events" — 14 were still there. It never
 * looked again after acting; it just trusted its own earlier list (which
 * was incomplete — list tools page their results, and a day range built in
 * the wrong timezone silently misses events). The user had to say "go back
 * and double check" to get the rest.
 *
 * So after any run that changed things in bulk, Nova re-reads the REAL
 * current state with a fresh lookup, compares it against what was asked,
 * fixes whatever's missing/left over/duplicated, and repeats until a pass
 * finds nothing to fix. This always runs off the spoken critical path: for a
 * background task it's part of the task (before "done" is reported), and for
 * a normal voice turn it starts as its own background task AFTER the answer
 * is already spoken — so it costs no extra latency either way.
 */

/**
 * Tool names that change something Nova can re-read and check afterward
 * (calendar events, tasks, files, labels...). `actions` entries are
 * "TOOL_NAME: detail" (see tasks.ts). Sending (emails, texts, Slack posts,
 * replies) is deliberately NOT here: a sent message can't be re-read the
 * same way, and a verification pass "fixing" one would mean sending a
 * duplicate to a real person.
 */
const WRITE_TOOL = /(CREATE|DELETE|UPDATE|ADD|REMOVE|MOVE|CLOSE|PATCH|INSERT|ARCHIVE|TRASH|MODIFY)/i;

export function countWrites(actions: string[]): number {
  return actions.filter((a) => WRITE_TOOL.test(a.split(":")[0])).length;
}

/** A normal voice turn this write-heavy gets an automatic background double-check after it answers. */
export const VERIFY_AFTER_WRITES = 3;

/** Stop re-checking after this many passes even if each one still finds something (reports what's left instead). */
export const MAX_VERIFY_PASSES = 3;

export const VERIFY_NOTE = `[System check, not said by the user: before this is reported as done, prove it. Do a FRESH lookup of the real current state now (e.g. list the calendar events again for the same range) — don't rely on earlier results or on what you remember doing, since list results page and can silently miss items. Page through every result (follow nextPageToken) with a large maxResults. Compare what's actually there against exactly what the user asked for. If anything is missing, left over, duplicated, or wrong, fix it now, then look again. Use broad list lookups, not one check per item. Never send, re-send, reply to, or post any email, text, or message as part of this check — only verify and fix things you can re-read. When it's confirmed correct, reply with one short sentence stating the verified final state with real counts (e.g. "Verified — your calendar today is empty; I caught and removed 14 that were missed."). If something couldn't be fixed, say exactly what's still wrong.]`;
