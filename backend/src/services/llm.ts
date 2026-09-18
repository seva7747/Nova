import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";
import { executeTool, isSlowTool } from "../tools/index.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// See the big comment where these are used, in the tool-result loop below.
const MAX_FIELD_CHARS = 1200;
// CONFIRMED BY TESTING: 20,000 was too tight and became the ACTIVE bottleneck
// instead of a rare safety net — a Gmail result with real metadata (message
// ids, thread ids, label arrays, headers) on top of even truncated bodies
// adds up fast across many messages, so this was silently discarding most of
// a legitimately-requested large result set (e.g. "look at all my emails
// with this client") after only per-field truncation, not because anything
// was actually oversized. Raised well past anything per-field truncation
// should realistically produce — still under 3% of Claude's 200k-token
// window, so it's a real backstop, not a soft cap doing the work it isn't
// meant to.
const MAX_TOOL_RESULT_TOTAL_CHARS = 80000;

/**
 * Walks a tool result and shortens any individual string value over
 * MAX_FIELD_CHARS, leaving everything else — object keys, array length,
 * short fields like dates/senders/ids — completely untouched. Used instead
 * of truncating the final serialized JSON so that no matter how large a
 * result is, EVERY item in an array (e.g. every email) keeps its metadata;
 * only genuinely long free-text fields (email bodies, HTML, etc.) get cut.
 */
function truncateLongStrings(value: any, depth = 0): any {
  if (depth > 6) return value; // safety net against pathological nesting, not expected in practice
  if (typeof value === "string") {
    return value.length > MAX_FIELD_CHARS
      ? `${value.slice(0, MAX_FIELD_CHARS)}… [truncated, ${value.length - MAX_FIELD_CHARS} more characters]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateLongStrings(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateLongStrings(v, depth + 1);
    return out;
  }
  return value;
}

// This instruction block never changes between requests, so it's marked
// cacheable (cache_control: ephemeral) — Anthropic skips re-processing it on
// every call within the ~5 minute cache window, which is a real chunk of the
// per-turn latency once tool schemas are added on top of it. The current
// date/time goes in a SEPARATE, uncached block appended after it (see
// buildSystem below) specifically so this cacheable block's text stays
// byte-for-byte identical call to call — caching is a prefix match, so
// anything that changes has to live after the cached part, not inside it.
const STATIC_INSTRUCTIONS = `You are Nova, a warm, quick, slightly witty voice assistant that lives inside a smart speaker — think Alexa, but named Nova.

Rules for how you talk:
- Your replies are spoken out loud by a text-to-speech voice, not read on a screen. Write the way a person talks: short sentences, no markdown, no bullet lists, no headers, no asterisks.
- Keep answers tight — usually one to three sentences. Say the useful thing first.
- Never say you're "an AI" or mention being a language model. You're Nova.
- If a request is genuinely ambiguous in a way that changes the outcome (e.g. no time given for a calendar event), ask one short clarifying question instead of guessing — but don't ask for details you can reasonably assume (e.g. default appointment length to 30 minutes if not given).
- When a tool result contains an "error" field, explain the problem to the user simply and naturally — don't read the raw error out loud.
- Don't narrate your plan out loud ("Let me search for that...", "I'll check your calendar...") before calling a tool — only your final answer gets spoken, and thinking out loud first just makes you sound slower than you are. Call the tool, then speak once you have the answer.
- You have a web_search tool for anything current, changing, or outside your training data — weather, sports scores/schedules, news, prices, "who won last night," etc. Always search rather than guess for these; a wrong guess about live information is worse than a one-second search. For established facts, math, or normal conversation, just answer directly without searching.
- You also have a tool to call a restaurant and book a table, tools for Gmail search/send/reply, and tools for whichever other services the user has connected through the Connectors page — that list varies per user and can be any of roughly 1,500 possible services (Calendar, Drive, Slack, Notion, Todoist, WhatsApp, Spotify, and many more), not a fixed set, so go by whatever tools are actually available to you in a given conversation rather than assuming a specific list. Only call a tool when the request actually needs it. WhatsApp (when connected) can only send messages, not read them — if asked to check WhatsApp messages, say that isn't something you can do rather than guessing.
- For anything about Gmail — searching, counting, "did I get an email from X," "how many yesterday" — always use search_gmail, never try to guess at Gmail's raw search syntax or do date-range math yourself. Say what you mean in its terms (sinceDaysAgo/untilDaysAgo as plain small numbers — 0 = today, 1 = yesterday, 7 = a week ago; onlyReceived defaults to true) and it handles timezones and query-building correctly. For a count, use returnedCount when countIsExact is true — that's a real, complete count. totalMatching is Gmail's own rough ESTIMATE and can be badly wrong (confirmed: 201 vs a true 49) — only fall back to it, and call it approximate out loud, when countIsExact is false and fetching everything genuinely isn't practical. Leave includeContent false unless you actually need to read what's inside specific emails — it's faster and more reliable that way. If a name search comes back empty, Gmail matches text not phonetics — ask the user to confirm the spelling before concluding there's nothing. Never state a specific date, sender, or detail that isn't literally in the returned data — if you're summarizing many messages, describe what's actually there, don't invent or extrapolate examples.
- For Canvas (school courses/assignments/grades), figure out course/assignment ids by calling the list tools first (e.g. CANVAS_LIST_COURSES) rather than guessing them — nearly every per-course Canvas tool needs a real numeric id, not a course name. A grade, score, or due date is exactly the kind of thing that's actively harmful to get wrong — never state one that isn't literally in a tool's returned data, and never round, estimate, or infer one from partial information. Canvas's raw timestamps (due_at, lock_at, etc.) are UTC and will be the wrong day and hour if read directly — every one comes with a matching *_local field (e.g. due_at_local: "Thursday, Sep 17, 11:59 PM PDT (today)") already converted to the user's time; always say that one, and use its (today)/(tomorrow) tag for "tonight"/"due tomorrow" rather than working it out yourself.
- Before acting on "all" or "every" item of something (delete all my events today, mark every holiday, archive all these emails), make sure you actually have the COMPLETE list first — list tools return results in pages, so if a result includes a nextPageToken (or similar) keep fetching until there isn't one, and ask for a large maxResults. For "today"/"tomorrow" ranges on the calendar, use the user's local midnight-to-midnight with their UTC offset (timeMin/timeMax), never UTC midnight. Missing items silently is worse than taking an extra second.
- To add anything to the calendar, always use add_calendar_event, never GOOGLECALENDAR_CREATE_EVENT directly — it checks for an existing same-titled event on that date first and skips creating it again, so a repeated or re-run bulk request (e.g. marking a list of holidays) never creates duplicates. Omit startTime for an all-day marker (holidays, reminders) — that's the normal case; only set it for an actual timed event. Whenever the user gives (or implies) an end time — a class, a meeting, anything with a real duration — pass endTime, not durationMinutes; endTime is the reliable one for anything longer than an hour.
- Composio-backed tools and the restaurant tool represent real, slower actions. Go ahead and call them as soon as you have what you need — the app already tells the user you're working on it, so you don't need to add filler text like "give me a moment" yourself. Just answer normally once the tool result comes back.
- When one request needs several separate actions (e.g. "add all of these to my calendar" for a whole list of items), call the tool once per item, one at a time across as many turns as it takes, rather than trying to fit many calls into a single response — that's both more reliable and lets you confirm progress as you go.
- Be proactive, not just a reader: when an email (or anything else you look up) contains something with an obvious next step, don't just read it back and stop — offer the obvious next action in the same breath, specific to what's actually in it and to whichever connected tools actually apply. Draw on ALL the services currently connected, not just calendar/reply — e.g. "Want me to add that to your calendar?", "Want me to reply and let them know?", "Want me to add that as a task in Notion?", "Want me to add this to Todoist?", whatever fits what you actually have connected and what the content calls for. Keep it short, and only offer when there's a real, concrete action to take — don't tack this onto every routine email that has nothing to act on. If the user says yes, go do it; don't ask a second confirming question first.`;

type AccountsByToolkit = Record<string, { id: string; label: string }[]>;

function buildSystem(timezone?: string, accountsByToolkit?: AccountsByToolkit) {
  const now = new Date();
  const tz = timezone || env.TIMEZONE;
  const when = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
    timeZoneName: "short",
  });

  // Gmail day-boundary math (the thing that was actually error-prone) no
  // longer happens here or in Claude's head — search_gmail (tools/gmailSearch.ts)
  // takes plain "days ago" numbers and does that arithmetic itself, correctly,
  // in code. This block just needs to state the current moment for everything
  // else (calendar events, "in an hour," etc.).
  const blocks = [
    { type: "text" as const, text: STATIC_INSTRUCTIONS, cache_control: { type: "ephemeral" as const } },
    {
      type: "text" as const,
      text: `Right now it is ${when}. Resolve any relative day/time the user gives you ("this Thursday", "tomorrow at 4", "in an hour") against that moment and timezone.`,
    },
  ];

  // Multiple accounts connected for the same service (e.g. two Gmail
  // addresses) — see composio.ts's patchMultiAccountTools, which is what
  // actually adds the connectedAccountId field these tools now accept.
  const multi = Object.entries(accountsByToolkit ?? {}).filter(([, accounts]) => accounts.length > 1);
  if (multi.length > 0) {
    const desc = multi
      .map(([slug, accounts]) => `${slug} — ${accounts.map((a) => `"${a.label}" (id: ${a.id})`).join(", ")}`)
      .join("; ");
    blocks.push({
      type: "text" as const,
      text: `The user has more than one account connected for some services: ${desc}. If a request could apply to any of them and it isn't already clear which one, ask the user which account before calling a tool for that service — don't just guess or default to one. Once you know (they said, or only one makes sense for the request), pass that account's id as the tool's "connectedAccountId" input.`,
    });
  }

  return blocks;
}

/** Marks the last tool in the array cacheable — caches the whole tool-schema block (Anthropic caching is prefix-based). */
function withToolCaching(tools: any[]): any[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
}

// CONFIRMED BY TESTING: a live session's `messages` array (see
// liveDelegate.ts — same for smsDelegate.ts) is only ever appended to across
// every turn for as long as the session stays open; nothing capped its
// total size. A long enough conversation — especially one with several
// tool-heavy turns — eventually pushes the whole history past Claude's
// context window, and the API call throws. The catch block that runs this
// function rolls back only the CURRENT turn's own addition, so the already-
// oversized history from every earlier turn is untouched — meaning once a
// session got long enough to trip this once, EVERY subsequent question,
// unrelated or not, hit the identical failure for the rest of the session
// ("sorry, something went wrong," forever, no matter what was asked). Fixed
// by trimming down to the most recent whole turns before ever reaching the
// limit, rather than only reacting after the API has already rejected it.
const MAX_HISTORY_CHARS = 400_000; // ~100k tokens at ~4 chars/token — well under the 200k window, leaving room for the system prompt, tool schemas, and response

/**
 * Drops the oldest whole turns from `messages` once its total size crosses
 * MAX_HISTORY_CHARS, always keeping at least the most recent turn. A "turn"
 * starts at a message that's the user's own plain-text question (role
 * "user" with STRING content) — as opposed to a tool_result message (role
 * "user" but ARRAY content), which must stay glued to the assistant
 * tool_use message right before it. Cutting only at these boundaries means
 * every tool_use/tool_result pair that survives the trim is always complete
 * — never orphaned the way the session-corruption bug elsewhere in this file
 * was.
 */
function trimMessageHistory(messages: any[]): any[] {
  const originalSize = JSON.stringify(messages).length;
  if (originalSize <= MAX_HISTORY_CHARS) return messages;

  const turnStarts = messages
    .map((m, i) => (m.role === "user" && typeof m.content === "string" ? i : -1))
    .filter((i) => i >= 0);

  for (let i = 0; i < turnStarts.length - 1; i++) {
    const candidate = messages.slice(turnStarts[i + 1]);
    if (JSON.stringify(candidate).length <= MAX_HISTORY_CHARS) {
      console.log(
        `[llm] trimmed conversation history: ${messages.length} messages (${originalSize} chars) → ${candidate.length} messages, dropped ${i + 1} oldest turn(s)`
      );
      return candidate;
    }
  }
  // Even just the most recent turn alone doesn't fit — nothing smaller left
  // to try (the per-tool-result cap below makes this rare). Return it anyway
  // rather than give up; a huge single turn is still more likely to succeed
  // than the full, larger history.
  console.warn(`[llm] conversation history still large (${originalSize} chars) after trimming to the most recent turn`);
  return turnStarts.length > 0 ? messages.slice(turnStarts[turnStarts.length - 1]) : messages;
}

type ConversationTurnArgs = {
  messages: any[];
  tools: any[];
  userId: string;
  timezone?: string;
  accountsByToolkit?: AccountsByToolkit;
  onSlowTool: (block: { name: string; input: any }) => Promise<void>;
  /**
   * Checked before every round of tool calls — returning true stops here
   * (same resumable "paused" exit as hitting the round cap). CONFIRMED BY
   * TESTING: cancel used to be checked only between whole background steps,
   * and a bulk calendar delete fit in ONE step — the user said "cancel",
   * Nova said it stopped, and the task went on to delete 65 events anyway.
   */
  shouldStop?: () => boolean;
};

/**
 * Turns a failed turn into what Nova should actually say. Most failures are
 * genuinely opaque and get the generic apology — but a low Anthropic account
 * balance is common enough, and looks IDENTICAL to a real bug from the
 * user's side (same generic "something went wrong," repeating on every
 * question), that it's worth telling them the real, actionable cause instead
 * of leaving them debugging a phantom code issue. CONFIRMED BY TESTING: this
 * exact error, verbatim, is what Anthropic returns once the account backing
 * ANTHROPIC_API_KEY runs out of credits — a 400 with this message, not a 429
 * or anything rate-limit-shaped.
 */
export function describeConversationError(err: any, fallback = "Sorry, something went wrong on my end just now."): string {
  const message = String(err?.message ?? "");
  if (/credit balance is too low/i.test(message)) {
    return "My brain's out of credits — the Anthropic account behind me needs more added at console.anthropic.com, under Plans and Billing, before I can keep going.";
  }
  if (err?.status === 429 || /rate.?limit/i.test(message)) {
    return "I'm getting rate-limited right now — give it a few seconds and try again.";
  }
  return fallback;
}

export async function runConversationTurn({ messages, tools, userId, timezone, accountsByToolkit, onSlowTool, shouldStop }: ConversationTurnArgs) {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      finalText: "Nova's brain isn't hooked up yet — add ANTHROPIC_API_KEY to backend/.env.",
      messages,
    };
  }

  messages = trimMessageHistory(messages);

  const system = buildSystem(timezone, accountsByToolkit);
  const cachedTools = withToolCaching(tools);
  const model = env.ANTHROPIC_MODEL;
  // CONFIRMED BY TESTING: 300 was sized for spoken replies (short) but also
  // caps how much STRUCTURED TOOL-CALL JSON Claude can emit in one response
  // — a completely different thing. Asking for several calendar events at
  // once ("mark every California court holiday this month") needed multiple
  // tool_use blocks in one message, and 300 tokens wasn't enough room for
  // that JSON — Anthropic cut the response off with stop_reason: "max_tokens"
  // mid-tool-call, leaving an unresolved tool_use with no result, which is
  // the SAME session-corrupting failure as the tool-round-limit case below,
  // just triggered a different way (stop_reason wasn't even "tool_use" here,
  // so the guard-cap handling for that case didn't catch this one). Raised
  // well past what multi-tool-call JSON should ever need; the actual SPOKEN
  // answer stays short regardless, since that's a separate, later message.
  const maxTokens = 1024;

  let response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    tools: cachedTools,
    messages,
  });

  let fillerFired = false;
  let guard = 0;
  const MAX_TOOL_ROUNDS = 6; // was 4 — too tight for e.g. "look this up, then create several calendar events," which needs more than one round-trip per event

  while (response.stop_reason === "tool_use" && guard < MAX_TOOL_ROUNDS && !shouldStop?.()) {
    guard++;
    const toolUseBlocks = response.content.filter((b: any) => b.type === "tool_use") as any[];

    if (!fillerFired) {
      const slowBlock = toolUseBlocks.find((b) => isSlowTool(b.name));
      if (slowBlock) {
        fillerFired = true;
        await onSlowTool(slowBlock);
      }
    }

    // CONFIRMED BY TESTING: GMAIL_FETCH_EMAILS (called with no args, i.e.
    // whenever the user just says "check my email") came back with full
    // message bodies for enough emails to hit 273,808 tokens in one tool
    // result — 37% over Claude's 200k window, on its own, for a single
    // "check my email." Anthropic then rejects the request outright, and
    // since messages.push below has already happened by the time that
    // failure surfaces, every subsequent turn in the same conversation
    // resends that same bloated history and fails identically — one oversized
    // tool result was silently wedging the ENTIRE rest of the session, not
    // just the turn that triggered it (see the recovery in liveDelegate.ts
    // for the other half of this fix).
    //
    // FIRST ATTEMPT at a fix truncated the whole serialized JSON blob at a
    // flat character count — which cut off whichever fields happened to fall
    // after the cutoff, including dates, for however many emails didn't fit.
    // That's why Nova could read email content but not reliably say when
    // anything arrived. Fixed properly below: truncate long STRING VALUES
    // in place (email bodies, mainly) while walking the object, so every
    // item in an array keeps every field — dates, senders, subjects — no
    // matter how many items there are; only the genuinely long free-text
    // fields get shortened.
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let content: string;
        try {
          const result = await executeTool(block.name, block.input, { userId, timezone });
          content = JSON.stringify(truncateLongStrings(result));
          // Safety net only — normal results shouldn't get anywhere near this
          // after per-field truncation above; this just guarantees a hard
          // ceiling regardless of how many array items or nesting there is.
          if (content.length > MAX_TOOL_RESULT_TOTAL_CHARS) {
            const omitted = content.length - MAX_TOOL_RESULT_TOTAL_CHARS;
            content = `${content.slice(0, MAX_TOOL_RESULT_TOTAL_CHARS)}... [truncated — ${omitted} more characters omitted; ask a narrower question (e.g. "just unread", "just the last 5") if something's missing]`;
          }
        } catch (err: any) {
          content = JSON.stringify({ error: err?.message ?? "That tool failed." });
        }
        return { type: "tool_result" as const, tool_use_id: block.id, content };
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({ model, max_tokens: maxTokens, system, tools: cachedTools, messages });
  }

  messages.push({ role: "assistant", content: response.content });

  // CONFIRMED BY TESTING, TWICE, via two different triggers — this one
  // silently broke an entire session, not just one turn. First seen when a
  // request needed more tool-call rounds than `guard` allows (stop_reason
  // stayed "tool_use" when the loop above gave up). Second time, a DIFFERENT
  // trigger produced the identical failure: Claude tried to emit several
  // tool_use blocks in one response (multiple calendar events at once) and
  // ran out of max_tokens mid-way, so stop_reason was "max_tokens" — a value
  // the first fix's `=== "tool_use"` check didn't account for, so it slipped
  // through anyway. Either way, the assistant message just pushed above can
  // contain tool_use blocks with no tool_result after them, and Anthropic's
  // API requires one immediately following, in the very next message, or
  // EVERY future call in this same conversation fails with "tool_use ids
  // were found without tool_result blocks," forever, since `messages` is the
  // session's whole reused history. That's exactly why an unrelated question
  // ("Chelsea's next game") started failing right after a big calendar
  // request both times. Fixed properly now: check for orphaned tool_use
  // blocks directly, by content, instead of trying to enumerate every
  // stop_reason that could produce one — satisfy the API's contract with a
  // synthetic "cancelled" result for each before doing anything else, so the
  // history is always valid going forward no matter how this happens next.
  const orphaned = (response.content as any[]).filter((b) => b.type === "tool_use");
  if (orphaned.length > 0) {
    const cancelResults = orphaned.map((block) => ({
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: JSON.stringify({ error: "Paused here — will resume with the next batch of tool calls shortly." }),
    }));
    messages.push({ role: "user", content: cancelResults });
    // `needsMoreWork: true` tells the caller (liveDelegate.ts) this genuinely
    // isn't finished — a big enough job (e.g. "mark every court holiday this
    // year") needs more rounds than one call here allows. Rather than just
    // giving up, the caller can keep calling this function again with the
    // same `messages` (now left in a valid, resumable state above) as a
    // background job, independent of the live voice turn that kicked it off.
    return { finalText: "This is a bigger job — I'll keep working on it in the background, so ask me anything in the meantime.", messages, needsMoreWork: true };
  }

  // Find the answer text, not the "thinking out loud" text. When a server
  // tool like web_search runs, Claude's response can contain an earlier text
  // block ("Let me look that up...") before the search, and — this is the
  // part that bit us — when the answer cites sources, the real answer itself
  // often comes back as SEVERAL text blocks with citation blocks spliced
  // between them (Anthropic's citation format), not one single block. Taking
  // only the very last block was cutting the answer off mid-sentence.
  // Fix: find the last non-text block (the last search/tool result), then
  // join every text block that comes after it — that's the complete answer,
  // with the pre-search narration correctly excluded.
  const content = response.content as any[];
  let lastNonTextIdx = -1;
  content.forEach((b, i) => {
    if (b.type !== "text") lastNonTextIdx = i;
  });
  const finalText =
    content
      .slice(lastNonTextIdx + 1)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim() || "Sorry, I didn't catch that.";

  return { finalText, messages };
}
