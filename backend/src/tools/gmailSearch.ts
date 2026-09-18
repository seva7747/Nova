import { env } from "../config.js";
import { executeComposioTool } from "../services/composio.js";
import { localMidnightEpochSeconds } from "../util/time.js";

/**
 * A purpose-built wrapper around Composio's GMAIL_FETCH_EMAILS, replacing
 * direct access to it entirely.
 *
 * CONFIRMED BY TESTING across several real sessions: exposing the raw tool
 * (9 parameters, several with unhelpful defaults) meant Claude had to build
 * a Gmail search query and compute date-range arithmetic itself, fresh,
 * every single time — and it got it wrong often enough to matter: an
 * inconsistent unread count (3, then 1, then 50, real answer 6), "today"
 * lists bleeding an hour into the wrong day, "3 days ago" and specific past
 * dates returning nothing at all, and sent/draft mail being counted as
 * "received." Some of that was Claude's own arithmetic slipping, and some
 * was genuine: Gmail's after:/before: operators interpret a plain
 * YYYY/MM/DD date as midnight in a FIXED reference timezone (confirmed in
 * Google's own docs), not the user's real one — so a query built from the
 * user's local "today" can land on the wrong side of midnight no matter how
 * carefully it's built. Every retry also cost a full extra round trip,
 * which is a real chunk of why responses felt slow.
 *
 * Fix: do the parts that are actually arithmetic — day-boundary math, the
 * received-vs-sent filter, picking a sane result size and payload weight —
 * in plain deterministic code, once, here. Claude just says what it means
 * ("3 days ago," "only what I received," "just the count") and this
 * translates that into a correct, unambiguous Gmail query every time. That
 * also means fewer retry round trips, which should feel faster too.
 *
 * TWO MORE ISSUES CONFIRMED BY TESTING after the above was already working:
 *
 * 1. Gmail's own resultSizeEstimate is genuinely unreliable, not just a
 *    truncation artifact on our end — asked for a plain unread count, it
 *    returned 201 when the TRUE total (verified by actually fetching every
 *    matching message, with hasMore already false) was 49. It's called an
 *    "estimate" in Google's own docs for a reason. Fixed by exposing
 *    `countIsExact` (true whenever hasMore is false, meaning every message
 *    was actually returned and counted, not estimated) so Claude has a
 *    reliable signal for when the exact returnedCount can be trusted over
 *    the fuzzy totalMatching.
 *
 * 2. is:unread with no other scope searches the user's ENTIRE account —
 *    every label, including mail a filter already routed out of the inbox
 *    view — not just what Gmail's UI shows as the visible unread badge.
 *    That's a real, correct distinction, but it isn't what someone means by
 *    a casual "how many unread emails do I have" (of that same 49, 47 were
 *    filtered into other labels and never show up as "unread" in the inbox
 *    the user actually looks at). Defaulted plain unread checks to in:inbox
 *    to match what people actually mean; `anyFolder` opts back into
 *    searching everywhere when that's genuinely what's being asked.
 */
export const gmailSearchTool = {
  name: "search_gmail",
  description:
    "Search or count the user's Gmail. Always use this instead of trying to build Gmail search syntax or figure out date ranges yourself — it handles timezones, date-range math, and received-vs-sent filtering correctly. Returns totalMatching (Gmail's own rough ESTIMATE — can be well off, e.g. 201 vs a true 49) alongside returnedCount (the actual number fetched) and countIsExact (true when hasMore is false, meaning returnedCount is the real, complete total — prefer it over totalMatching whenever it's true). Each message includes a ready-to-speak `receivedAt` (already converted to the user's local time) — always use that field when saying when something arrived, not the raw `messageTimestamp` (that one's UTC and will be the wrong hour if read directly). Never state a date or fact about a message that isn't literally in the returned data — summarize what's there, don't estimate or fill in gaps.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Optional. Free text or Gmail search operators for WHO/WHAT — a sender's name or address, a subject keyword, 'is:unread', etc. Omit to match anything in the given date range.",
      },
      sinceDaysAgo: {
        type: "integer",
        description: "Start of the date range, in days before today: 0 = today, 1 = yesterday, 3 = three days ago, 7 = a week ago. Omit for no lower bound.",
      },
      untilDaysAgo: {
        type: "integer",
        description: "End of the date range (inclusive), in days before today. Defaults to 0 (today) whenever sinceDaysAgo is given. Omit both for no date filter.",
      },
      onlyReceived: {
        type: "boolean",
        description: 'true (default) = only mail the user actually received, excluding what they sent or drafted — use this for "how many emails did I get." Set false to include sent mail too.',
      },
      onlyUnread: { type: "boolean", description: "Restrict to unread mail only. Default false." },
      anyFolder: {
        type: "boolean",
        description:
          'When onlyUnread is true, this defaults to false, which restricts to the inbox — matching what someone means by a casual "how many unread emails do I have." Set anyFolder: true only if the user clearly wants unread mail across every label/folder, including things a filter already routed out of the inbox (e.g. "how many unread total, everywhere, even archived").',
      },
      maxResults: {
        type: "integer",
        description: "How many messages to actually fetch details for (default 20, max 100). Does NOT affect totalMatching, which always reflects the true total regardless of this cap.",
      },
      includeContent: {
        type: "boolean",
        description:
          "false (default): fast, metadata-only (sender, subject, date/time, snippet) — use this for anything about counts, who emailed, or when. true: fetch full bodies too — only set this once you actually need to read or summarize what's inside specific emails, since it's slower and the main way past answers lost data.",
      },
      pageToken: {
        type: "string",
        description: "Pass the previous result's nextPageToken to continue past maxResults when the user needs a genuinely complete picture (e.g. \"everything from this client\") and hasMore was true.",
      },
      connectedAccountId: {
        type: "string",
        description: "Which connected Gmail account to search — only needed if the user has more than one connected (see your instructions for the list of accounts).",
      },
    },
  },
};

export async function runGmailSearch(input: any, ctx: { userId: string; timezone?: string }) {
  const tz = ctx.timezone || env.TIMEZONE;
  const now = new Date();

  const queryParts: string[] = [];
  if (input.query) queryParts.push(String(input.query));
  if (input.onlyReceived !== false) queryParts.push("-in:sent", "-in:drafts");
  if (input.onlyUnread) {
    queryParts.push("is:unread");
    if (!input.anyFolder) queryParts.push("in:inbox");
  }

  if (input.sinceDaysAgo != null || input.untilDaysAgo != null) {
    const since = input.sinceDaysAgo ?? input.untilDaysAgo ?? 0;
    const until = input.untilDaysAgo ?? 0;
    // "untilDaysAgo" is inclusive of that whole day, so the upper bound is
    // midnight at the START of the day AFTER it.
    queryParts.push(`after:${localMidnightEpochSeconds(now, tz, -since)}`, `before:${localMidnightEpochSeconds(now, tz, -until + 1)}`);
  }

  const maxResults = Math.min(Math.max(Number(input.maxResults) || 20, 1), 100);
  const includePayload = Boolean(input.includeContent);

  const args: Record<string, unknown> = {
    max_results: maxResults,
    include_payload: includePayload,
    verbose: includePayload,
  };
  if (queryParts.length > 0) args.query = queryParts.join(" ");
  if (input.pageToken) args.page_token = input.pageToken;
  if (input.connectedAccountId) args.connectedAccountId = input.connectedAccountId;

  const result: any = await executeComposioTool(ctx.userId, "GMAIL_FETCH_EMAILS", args);

  // CONFIRMED BY TESTING: messageTimestamp comes back as a raw UTC instant
  // (e.g. "2026-09-15T16:20:42Z") — fixing the SEARCH boundaries didn't fix
  // this, because reading a result back out loud is a separate step from
  // finding it, and Claude was still doing its own UTC-to-local conversion
  // per message rather than reliably subtracting the right offset every
  // time. Converted here instead, once, in code — every message gets an
  // unambiguous, already-local `receivedAt` string, so there's no more
  // per-message arithmetic left for Claude to get wrong.
  const messages = (result?.data?.messages ?? []).map((m: any) => {
    const ts = m?.messageTimestamp;
    const parsed = ts ? new Date(ts) : null;
    const receivedAt =
      parsed && !isNaN(parsed.getTime())
        ? parsed.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" })
        : undefined;
    return { ...m, receivedAt };
  });

  const hasMore = Boolean(result?.data?.nextPageToken);

  // Reshaped with explicit, hard-to-misread field names. totalMatching
  // (Gmail's own resultSizeEstimate) is kept for when there's genuinely more
  // than fit in one page, but it's an ESTIMATE — confirmed unreliable by
  // testing (201 vs a true 49) — so countIsExact is the field to actually
  // branch on: true means every matching message was actually fetched and
  // returnedCount is the real, complete count, not a guess.
  return {
    totalMatching: result?.data?.resultSizeEstimate ?? null,
    returnedCount: messages.length,
    countIsExact: !hasMore,
    hasMore,
    nextPageToken: result?.data?.nextPageToken || undefined,
    messages,
    error: result?.error ?? undefined,
  };
}
