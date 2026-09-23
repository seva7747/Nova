import OpenAI from "openai";
import { env } from "../config.js";
import { executeTool, isSlowTool } from "../tools/index.js";
import { recentCallsSummary } from "./outboundCall.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// See the big comment where these are used, in the tool-result loop below.
const MAX_FIELD_CHARS = 1200;
// CONFIRMED BY TESTING: 20,000 was too tight and became the ACTIVE bottleneck
// instead of a rare safety net — a Gmail result with real metadata (message
// ids, thread ids, label arrays, headers) on top of even truncated bodies
// adds up fast across many messages, so this was silently discarding most of
// a legitimately-requested large result set (e.g. "look at all my emails
// with this client") after only per-field truncation, not because anything
// was actually oversized. Raised well past anything per-field truncation
// should realistically produce — still a small fraction of the model's
// context window, so it's a real backstop, not a soft cap doing the work it isn't
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

// This instruction block never changes between requests, and it is
// deliberately the FIRST thing in the instructions string for that reason.
// OpenAI caches long prompt prefixes automatically (no cache_control marker
// to set, unlike Anthropic's API, which this used to run on) — but it's a
// prefix match, so it only helps as long as the unchanging text comes first
// and is long enough to cross OpenAI's ~1024-token minimum. The current
// date/time is appended AFTER it (see buildSystem below) specifically so
// this block stays byte-for-byte identical call to call; moving anything
// variable into it would silently cost the cache on every turn.
const STATIC_INSTRUCTIONS = `You are Nova, a warm, quick, slightly witty voice assistant that lives inside a smart speaker — think Alexa, but named Nova.

Rules for how you talk:
- Your replies are spoken out loud by a text-to-speech voice, not read on a screen. Write the way a person talks: short sentences, no markdown, no bullet lists, no headers, no asterisks.
- Keep answers tight — usually one to three sentences. Say the useful thing first.
- Never say you're "an AI" or mention being a language model. You're Nova.
- If a request is genuinely ambiguous in a way that changes the outcome (e.g. no time given for a calendar event), ask one short clarifying question instead of guessing — but don't ask for details you can reasonably assume (e.g. default appointment length to 30 minutes if not given).
- When a tool result contains an "error" field, explain the problem to the user simply and naturally — don't read the raw error out loud.
- Don't narrate your plan out loud ("Let me search for that...", "I'll check your calendar...") before calling a tool — only your final answer gets spoken, and thinking out loud first just makes you sound slower than you are. Call the tool, then speak once you have the answer.
- You have a web_search tool for anything current, changing, or outside your training data — weather, sports scores/schedules, news, prices, "who won last night," etc. Always search rather than guess for these; a wrong guess about live information is worse than a one-second search. For established facts, math, or normal conversation, just answer directly without searching.
- You have make_phone_call for anything that genuinely needs a REAL phone call — asking a business a question, booking a reservation, wishing someone happy birthday, whatever the user actually wants said or asked over the phone. You don't stay on that call yourself; Nova places it and leads the whole conversation on her own, then reports the outcome back automatically the moment it's done (you'll just start talking about it unprompted next time). Find a business's number with web_search first if you don't already have it; ask the user for a personal contact's number if you don't have it. Write the objective as clear instructions to yourself, and the openingLine as the literal first thing to say the instant the call connects. After calling this tool, just tell the user you're calling now — don't guess at an outcome, since you genuinely don't know it yet.
- You also have tools for Gmail search/send/reply, and tools for whichever other services the user has connected through the Connectors page — that list varies per user and can be any of roughly 1,500 possible services (Calendar, Drive, Slack, Notion, Todoist, WhatsApp, Spotify, and many more), not a fixed set, so go by whatever tools are actually available to you in a given conversation rather than assuming a specific list. Only call a tool when the request actually needs it. WhatsApp (when connected) can only send messages, not read them — if asked to check WhatsApp messages, say that isn't something you can do rather than guessing.
- For anything about Gmail — searching, counting, "did I get an email from X," "how many yesterday" — always use search_gmail, never try to guess at Gmail's raw search syntax or do date-range math yourself. Say what you mean in its terms (sinceDaysAgo/untilDaysAgo as plain small numbers — 0 = today, 1 = yesterday, 7 = a week ago; onlyReceived defaults to true) and it handles timezones and query-building correctly. For a count, use returnedCount when countIsExact is true — that's a real, complete count. totalMatching is Gmail's own rough ESTIMATE and can be badly wrong (confirmed: 201 vs a true 49) — only fall back to it, and call it approximate out loud, when countIsExact is false and fetching everything genuinely isn't practical. Leave includeContent false unless you actually need to read what's inside specific emails — it's faster and more reliable that way. If a name search comes back empty, Gmail matches text not phonetics — ask the user to confirm the spelling before concluding there's nothing. Never state a specific date, sender, or detail that isn't literally in the returned data — if you're summarizing many messages, describe what's actually there, don't invent or extrapolate examples.
- For Canvas (school courses/assignments/grades), figure out course/assignment ids by calling the list tools first (e.g. CANVAS_LIST_COURSES) rather than guessing them — nearly every per-course Canvas tool needs a real numeric id, not a course name. A grade, score, or due date is exactly the kind of thing that's actively harmful to get wrong — never state one that isn't literally in a tool's returned data, and never round, estimate, or infer one from partial information. Canvas's raw timestamps (due_at, lock_at, etc.) are UTC and will be the wrong day and hour if read directly — every one comes with a matching *_local field (e.g. due_at_local: "Thursday, Sep 17, 11:59 PM PDT (today)") already converted to the user's time; always say that one, and use its (today)/(tomorrow) tag for "tonight"/"due tomorrow" rather than working it out yourself. CONFIRMED BY TESTING: an assignment's due_at/unlock_at/lock_at describe when THAT ONE ASSIGNMENT is due or available to submit — they say nothing about when the class itself actually meets, and must never be read as a class's meeting time (this produced a real, confusing wrong answer: a homework window mistaken for "when the class is"). If asked when a class meets and that isn't clearly stated somewhere else (the course syllabus body, or the user just telling you), say you can't find a meeting time in Canvas and ask them, rather than inferring one from any assignment's dates.
- Before acting on "all" or "every" item of something (delete all my events today, mark every holiday, archive all these emails), make sure you actually have the COMPLETE list first — list tools return results in pages, so if a result includes a nextPageToken (or similar) keep fetching until there isn't one, and ask for a large maxResults. For "today"/"tomorrow" ranges on the calendar, use the user's local midnight-to-midnight with their UTC offset (timeMin/timeMax), never UTC midnight. Missing items silently is worse than taking an extra second.
- To add anything to the calendar, always use add_calendar_event, never GOOGLECALENDAR_CREATE_EVENT directly — it checks for an existing same-titled event on that date first and skips creating it again, so a repeated or re-run bulk request (e.g. marking a list of holidays) never creates duplicates. Omit startTime for an all-day marker (holidays, reminders) — that's the normal case; only set it for an actual timed event. Whenever the user gives (or implies) an end time — a class, a meeting, anything with a real duration — pass endTime, not durationMinutes; endTime is the reliable one for anything longer than an hour. CONFIRMED BY TESTING — a real wrong action: merely mentioning an activity and a time in conversation ("I might go to the beach from 3 to 5 today") got silently added as a real calendar event, which the user never actually asked for. Only ever call add_calendar_event when the user has CLEARLY and EXPLICITLY asked for something to be added, scheduled, booked, or put on the calendar — never because a date, time, and activity happened to come up together in what they said. If it's genuinely unclear whether they want it added, ask first ("Want me to add that to your calendar?") instead of just doing it — this applies even though the general "be proactive, offer the next step" guidance elsewhere in these instructions still applies to OFFERING, just never to silently acting on your own inference.
- Composio-backed tools represent real, slower actions. Go ahead and call them as soon as you have what you need — the app already tells the user you're working on it, so you don't need to add filler text like "give me a moment" yourself. Just answer normally once the tool result comes back.
- When one request needs several separate actions (e.g. "add all of these to my calendar" for a whole list of items), call the tool once per item, one at a time across as many turns as it takes, rather than trying to fit many calls into a single response — that's both more reliable and lets you confirm progress as you go.
- Be proactive, not just a reader: when an email (or anything else you look up) contains something with an obvious next step, don't just read it back and stop — offer the obvious next action in the same breath, specific to what's actually in it and to whichever connected tools actually apply. Draw on ALL the services currently connected, not just calendar/reply — e.g. "Want me to add that to your calendar?", "Want me to reply and let them know?", "Want me to add that as a task in Notion?", "Want me to add this to Todoist?", whatever fits what you actually have connected and what the content calls for. Keep it short, and only offer when there's a real, concrete action to take — don't tack this onto every routine email that has nothing to act on. If the user says yes, go do it; don't ask a second confirming question first.`;

type AccountsByToolkit = Record<string, { id: string; label: string }[]>;

function buildSystem(userId: string, timezone?: string, accountsByToolkit?: AccountsByToolkit) {
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
  // longer happens here or in the model's head — search_gmail (tools/gmailSearch.ts)
  // takes plain "days ago" numbers and does that arithmetic itself, correctly,
  // in code. This block just needs to state the current moment for everything
  // else (calendar events, "in an hour," etc.).
  // A plain string, not Anthropic's array of content blocks: the Responses
  // API takes one `instructions` string. STATIC_INSTRUCTIONS stays first so
  // the automatic prefix cache can cover it (see its comment above).
  const parts = [
    STATIC_INSTRUCTIONS,
    `Right now it is ${when}. Resolve any relative day/time the user gives you ("this Thursday", "tomorrow at 4", "in an hour") against that moment and timezone.`,
  ];

  // Multiple accounts connected for the same service (e.g. two Gmail
  // addresses) — see composio.ts's patchMultiAccountTools, which is what
  // actually adds the connectedAccountId field these tools now accept.
  const multi = Object.entries(accountsByToolkit ?? {}).filter(([, accounts]) => accounts.length > 1);
  if (multi.length > 0) {
    const desc = multi
      .map(([slug, accounts]) => `${slug} — ${accounts.map((a) => `"${a.label}" (id: ${a.id})`).join(", ")}`)
      .join("; ");
    parts.push(
      `The user has more than one account connected for some services: ${desc}. If a request could apply to any of them and it isn't already clear which one, ask the user which account before calling a tool for that service — don't just guess or default to one. Once you know (they said, or only one makes sense for the request), pass that account's id as the tool's "connectedAccountId" input.`
    );
  }

  // CONFIRMED BY TESTING: without this, a follow-up question in a BRAND NEW
  // session ("what number did you call?") got "I haven't called anyone" as
  // its answer, even seconds after a real call was placed — because a live
  // session's own message history resets to empty on every new connection,
  // but the actual call (services/outboundCall.ts) is tracked separately and
  // outlives any one session. This gives every session, including a fresh
  // one, a short memory of what was actually dialed and how it went.
  const recentCalls = recentCallsSummary(userId);
  if (recentCalls) {
    parts.push(
      `Recent phone calls you (Nova) actually placed, most recent first — use this to answer "who did you call" / "what happened with that call," and to know NOT to call the same number again for the same reason if one is already "still in progress": ${recentCalls}`
    );
  }

  return parts.join("\n\n");
}

/**
 * Composio's SDK (via @composio/core's default OpenAIProvider) hands back
 * tools in Chat Completions' nested shape — {type, function: {name, ...}} —
 * but the Responses API wants those same fields flattened onto the tool
 * itself. Hosted tools (web_search) and our own static tools are already in
 * Responses shape and pass through untouched.
 *
 * `strict` is deliberately left off: strict function calling requires every
 * schema to set additionalProperties:false and mark every property required,
 * which Composio's ~1,500 generated schemas do not, and turning it on
 * rejects them outright rather than degrading.
 */
function toResponsesTools(tools: any[]): any[] {
  return tools.map((tool) => {
    if (tool?.type === "function" && tool.function) {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      };
    }
    return tool;
  });
}

// CONFIRMED BY TESTING: a live session's `messages` array (see
// liveDelegate.ts — same for smsDelegate.ts) is only ever appended to across
// every turn for as long as the session stays open; nothing capped its
// total size. A long enough conversation — especially one with several
// tool-heavy turns — eventually pushes the whole history past the model's
// context window, and the API call throws. The catch block that runs this
// function rolls back only the CURRENT turn's own addition, so the already-
// oversized history from every earlier turn is untouched — meaning once a
// session got long enough to trip this once, EVERY subsequent question,
// unrelated or not, hit the identical failure for the rest of the session
// ("sorry, something went wrong," forever, no matter what was asked). Fixed
// by trimming down to the most recent whole turns before ever reaching the
// limit, rather than only reacting after the API has already rejected it.
const MAX_HISTORY_CHARS = 400_000; // ~100k tokens at ~4 chars/token — well under the model's window, leaving room for the instructions, tool schemas, and response

/**
 * Drops messages from the MIDDLE of `messages` once its total size crosses
 * MAX_HISTORY_CHARS, always keeping message 0 (the original request) AND as
 * much of the recent tail as fits.
 *
 * CONFIRMED BY TESTING, TWICE:
 *
 * 1. The original version of this only ever kept the most recent tail,
 *    dropping the OLDEST turns first — which, given a long enough session,
 *    eventually dropped the user's original request itself, since it was
 *    "oldest" relative to a constantly growing pile of newer tool calls.
 *    The model then kept working from memory of only its own recent tool
 *    calls, with no way to re-check what it was actually asked for.
 *
 * 2. Fixing that by pinning "the first turn" and only trimming middle
 *    TURNS (boundary = a plain-string user message) turned out not to
 *    engage at all for the case that actually matters most: a long
 *    background task (e.g. filling in ~2 months of a class schedule) is
 *    ONE continuous turn from the model's-eye view — a single initial
 *    request followed by many (function_call, function_call_output)
 *    rounds with no further plain-text user turn in between — so
 *    turn-counting saw only 1 "turn" and never trimmed at all, letting
 *    history grow completely unbounded through a long task instead of
 *    gradually. THIS is why later parts of a long task came out
 *    inconsistent or wrong while the beginning (before history ever got
 *    big enough to matter) was correct.
 *
 * Fixed properly by cutting at ROUND boundaries instead of turn boundaries.
 * On the Responses API the boundary is defined by the API's own contract
 * rather than by a role: a cut point is any index where NO function_call
 * before it is still waiting for its function_call_output, and where the
 * item itself isn't an orphaned function_call_output. Slicing there always
 * leaves a complete, valid sequence — which is the exact invariant the
 * Responses API enforces, so encoding it directly is safer than guessing at
 * which item types happen to start a round. Item 0 (always the session's or
 * task's own opening user message) is pinned permanently; the tail then
 * grows backward from the most recent boundary until it no longer fits.
 */
function roundBoundaries(messages: any[]): number[] {
  const boundaries: number[] = [];
  const open = new Set<string>();
  messages.forEach((m, i) => {
    if (i > 0 && open.size === 0 && m?.type !== "function_call_output") boundaries.push(i);
    if (m?.type === "function_call") open.add(m.call_id);
    if (m?.type === "function_call_output") open.delete(m.call_id);
  });
  return boundaries;
}

function trimMessageHistory(messages: any[]): any[] {
  const originalSize = JSON.stringify(messages).length;
  if (originalSize <= MAX_HISTORY_CHARS) return messages;

  const roundStarts = roundBoundaries(messages);
  if (roundStarts.length === 0) {
    // Nothing but the opening message and its immediate tool output, if
    // any — already as small as this can get.
    console.warn(`[llm] conversation history still large (${originalSize} chars) with nothing left to trim`);
    return messages;
  }

  const head = [messages[0]];
  for (let i = 0; i < roundStarts.length; i++) {
    const candidate = [...head, ...messages.slice(roundStarts[i])];
    if (JSON.stringify(candidate).length <= MAX_HISTORY_CHARS) {
      console.log(
        `[llm] trimmed conversation history: ${messages.length} messages (${originalSize} chars) → ${candidate.length} messages (kept the original request), dropped ${roundStarts[i] - 1} middle message(s)`
      );
      return candidate;
    }
  }
  // Not even the original request plus the single most recent round fits
  // under budget — return that smallest-possible candidate anyway (still
  // oversized) rather than give up. Keeping `head` here isn't optional: the
  // API needs the conversation to start with the user's actual request, and
  // a round boundary is generally model output — dropping head would leave
  // this starting mid-exchange with no request in it, not just a bigger
  // history.
  console.warn(`[llm] conversation history still large (${originalSize} chars) even after trimming to the original request + most recent round`);
  return [...head, ...messages.slice(roundStarts[roundStarts.length - 1])];
}

/**
 * A Responses function_call carries its arguments as a JSON STRING, where
 * Anthropic handed over an already-parsed object. A model can occasionally
 * emit malformed JSON here; returning {} lets the tool itself report a
 * missing-argument error normally instead of throwing before it ever runs.
 */
function safeParseArgs(args: any): any {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
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
 * genuinely opaque and get the generic apology — but an exhausted account
 * balance is common enough, and looks IDENTICAL to a real bug from the
 * user's side (same generic "something went wrong," repeating on every
 * question), that it's worth telling them the real, actionable cause instead
 * of leaving them debugging a phantom code issue. OpenAI signals this as an
 * `insufficient_quota` error code rather than a 429, so match on the code
 * (and the message text as a fallback) rather than on the status.
 */
export function describeConversationError(err: any, fallback = "Sorry, something went wrong on my end just now."): string {
  const message = String(err?.message ?? "");
  const code = String(err?.code ?? err?.error?.code ?? "");
  if (code === "insufficient_quota" || /insufficient_quota|exceeded your current quota|credit balance is too low/i.test(message)) {
    return "My brain's out of credits — the OpenAI account behind me needs more added at platform.openai.com, under Billing, before I can keep going.";
  }
  if (err?.status === 429 || /rate.?limit/i.test(message)) {
    return "I'm getting rate-limited right now — give it a few seconds and try again.";
  }
  return fallback;
}

export async function runConversationTurn({ messages, tools, userId, timezone, accountsByToolkit, onSlowTool, shouldStop }: ConversationTurnArgs) {
  if (!env.OPENAI_API_KEY) {
    return {
      finalText: "Nova's brain isn't hooked up yet — add OPENAI_API_KEY to backend/.env.",
      messages,
    };
  }

  messages = trimMessageHistory(messages);

  const instructions = buildSystem(userId, timezone, accountsByToolkit);
  const apiTools = toResponsesTools(tools);
  const model = env.OPENAI_BRAIN_MODEL;
  // CONFIRMED BY TESTING (on the previous Anthropic brain, but the failure
  // mode is identical here): 300 was sized for spoken replies (short) but
  // also caps how much STRUCTURED TOOL-CALL JSON the model can emit in one
  // response — a completely different thing. Asking for several calendar
  // events at once ("mark every California court holiday this month") needed
  // multiple tool calls in one response, and 300 tokens wasn't enough room
  // for that JSON, so the response got cut off mid-tool-call and left an
  // unresolved call with no output — which permanently corrupts the session
  // (see the orphan repair below for why).
  //
  // This budget matters MORE on a gpt-5.x brain than it did before, not
  // less: reasoning tokens are spent out of this same allowance BEFORE any
  // tool call is emitted, so the old 1024 would now be consumed by thinking
  // on a request that never reaches the tool call at all. Sized well past
  // what reasoning plus multi-tool-call JSON should need; the actual SPOKEN
  // answer stays short regardless, since that's a separate, later message.
  const maxTokens = 4096;

  const createResponse = (input: any[]) =>
    openai.responses.create({
      model,
      instructions,
      input,
      tools: apiTools,
      max_output_tokens: maxTokens,
      // Nova is a live voice loop — every second of thinking is audible
      // silence to someone standing in their kitchen. See config.ts.
      reasoning: { effort: env.OPENAI_REASONING_EFFORT as any },
      // Reasoning items are echoed back into `input` across tool rounds (see
      // the loop below), which requires the server to still have them.
      store: true,
    } as any) as Promise<any>;

  let response = await createResponse(messages);

  let fillerFired = false;
  let guard = 0;
  const MAX_TOOL_ROUNDS = 6; // was 4 — too tight for e.g. "look this up, then create several calendar events," which needs more than one round-trip per event

  // The Responses equivalent of Anthropic's stop_reason === "tool_use": the
  // model wants tools iff its output contains function_call items. Hosted
  // tools (web_search) never appear here — they run inside OpenAI's own
  // request/response cycle and come back already resolved.
  const pendingCalls = (r: any) => (r.output as any[]).filter((item) => item?.type === "function_call");

  while (pendingCalls(response).length > 0 && guard < MAX_TOOL_ROUNDS && !shouldStop?.()) {
    guard++;
    const toolCalls = pendingCalls(response);

    if (!fillerFired) {
      const slowBlock = toolCalls.find((b) => isSlowTool(b.name));
      if (slowBlock) {
        fillerFired = true;
        // onSlowTool's callers expect Anthropic's {name, input} shape; a
        // Responses function_call carries its arguments as a JSON string.
        await onSlowTool({ name: slowBlock.name, input: safeParseArgs(slowBlock.arguments) });
      }
    }

    // CONFIRMED BY TESTING: GMAIL_FETCH_EMAILS (called with no args, i.e.
    // whenever the user just says "check my email") came back with full
    // message bodies for enough emails to hit 273,808 tokens in one tool
    // result — far over the model's context window, on its own, for a single
    // "check my email." The API then rejects the request outright, and
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
      toolCalls.map(async (block) => {
        let content: string;
        try {
          const result = await executeTool(block.name, safeParseArgs(block.arguments), { userId, timezone });
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
        return { type: "function_call_output" as const, call_id: block.call_id, output: content };
      })
    );

    // The WHOLE output goes back, not just the function_call items: the
    // reasoning items that came with them carry the model's chain across
    // rounds, and the API rejects a function_call whose reasoning item was
    // dropped from in front of it.
    messages.push(...response.output);
    messages.push(...toolResults);

    response = await createResponse(messages);
  }

  messages.push(...response.output);

  // CONFIRMED BY TESTING, TWICE, via two different triggers — this one
  // silently broke an entire session, not just one turn. First seen when a
  // request needed more tool-call rounds than `guard` allows (the model
  // still wanted tools when the loop above gave up). Second time, a
  // DIFFERENT trigger produced the identical failure: the model tried to
  // emit several tool calls in one response (multiple calendar events at
  // once) and ran out of its output-token budget mid-way, so the response
  // came back incomplete with a half-written call. Either way, the output
  // just pushed above can contain function_call items with no
  // function_call_output after them — and the API requires one for every
  // call, or EVERY future request in this same conversation fails ("No tool
  // output found for function call ..."), forever, since `messages` is the
  // session's whole reused history. That's exactly why an unrelated question
  // ("Chelsea's next game") started failing right after a big calendar
  // request both times. The fix is deliberately NOT a check on why the model
  // stopped — enumerating stop reasons is what let the second trigger slip
  // through the first fix. Check for orphaned calls directly, by content,
  // and satisfy the API's contract with a synthetic "paused" output for each
  // before doing anything else, so the history is always valid going forward
  // no matter how this happens next.
  const orphaned = (response.output as any[]).filter((b) => b?.type === "function_call");
  if (orphaned.length > 0) {
    const cancelResults = orphaned.map((block) => ({
      type: "function_call_output" as const,
      call_id: block.call_id,
      output: JSON.stringify({ error: "Paused here — will resume with the next batch of tool calls shortly." }),
    }));
    messages.push(...cancelResults);
    // `needsMoreWork: true` tells the caller (liveDelegate.ts) this genuinely
    // isn't finished — a big enough job (e.g. "mark every court holiday this
    // year") needs more rounds than one call here allows. Rather than just
    // giving up, the caller can keep calling this function again with the
    // same `messages` (now left in a valid, resumable state above) as a
    // background job, independent of the live voice turn that kicked it off.
    return { finalText: "This is a bigger job — I'll keep working on it in the background, so ask me anything in the meantime.", messages, needsMoreWork: true };
  }

  // Find the answer text, not the "thinking out loud" text. When a hosted
  // tool like web_search runs, the output array contains the search items
  // AND, potentially, an earlier message ("Let me look that up...") from
  // before the search. Deliberately NOT response.output_text, which
  // concatenates every message item in the response and so would glue that
  // pre-search narration onto the front of the real answer — spoken out
  // loud, that's Nova saying "let me look that up" and then immediately
  // answering, which is exactly what STATIC_INSTRUCTIONS tells her not to
  // do. Take the LAST message item instead: that's the answer written after
  // everything else finished, with its own text parts joined (a single
  // message can hold several output_text parts when sources are cited).
  const output = response.output as any[];
  const lastMessage = [...output].reverse().find((item) => item?.type === "message");
  const finalText =
    ((lastMessage?.content ?? []) as any[])
      .filter((part) => part?.type === "output_text")
      .map((part) => part.text)
      .join("")
      .trim() || "Sorry, I didn't catch that.";

  return { finalText, messages };
}
