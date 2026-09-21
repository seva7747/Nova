import { env } from "../config.js";
import { executeTool, isSlowTool } from "../tools/index.js";
import { recentCallsSummary } from "./outboundCall.js";

// Nova's brain runs on OpenAI's Responses API (gpt-4.1-mini) — see
// config.ts's OPENAI_REASONING_MODEL for the full history of why (Anthropic
// Claude Haiku 4.5 → here, for cost, after ruling out gpt-4o-mini). Plain
// fetch, no SDK — same pattern this project already used for the brief
// Groq/Gemini detour and for Twilio, and it keeps this file in full control
// of the exact request/response shape rather than an SDK's abstraction of it.
const API_BASE = "https://api.openai.com/v1";

// See the big comment where these are used, in the tool-result loop below.
const MAX_FIELD_CHARS = 1200;
// CONFIRMED BY TESTING: 20,000 was too tight and became the ACTIVE bottleneck
// instead of a rare safety net — a Gmail result with real metadata (message
// ids, thread ids, label arrays, headers) on top of even truncated bodies
// adds up fast across many messages, so this was silently discarding most of
// a legitimately-requested large result set (e.g. "look at all my emails
// with this client") after only per-field truncation, not because anything
// was actually oversized. Raised well past anything per-field truncation
// should realistically produce.
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

const STATIC_INSTRUCTIONS = `You are Nova, a warm, quick, slightly witty voice assistant that lives inside a smart speaker — think Alexa, but named Nova.

Rules for how you talk:
- Your replies are spoken out loud by a text-to-speech voice, not read on a screen. Write the way a person talks: short sentences, no markdown, no bullet lists, no headers, no asterisks.
- Keep answers tight — usually one to three sentences. Say the useful thing first.
- Never say you're "an AI" or mention being a language model. You're Nova.
- If a request is genuinely ambiguous in a way that changes the outcome (e.g. no time given for a calendar event), ask one short clarifying question instead of guessing — but don't ask for details you can reasonably assume (e.g. default appointment length to 30 minutes if not given).
- When a tool result contains an "error" field, explain the problem to the user simply and naturally — don't read the raw error out loud.
- Don't narrate your plan out loud ("Let me search for that...", "I'll check your calendar...") before calling a tool — only your final answer gets spoken, and thinking out loud first just makes you sound slower than you are. Call the tool, then speak once you have the answer.
- You have a web_search tool for anything current, changing, or outside your training data — weather, sports scores/schedules, news, prices, "who won last night," etc. Always search rather than guess for these; a wrong guess about live information is worse than a one-second search. For established facts, math, or normal conversation, just answer directly without searching. CONFIRMED BY TESTING: search results often come back internally formatted with headers, bullet points, and a multi-day forecast table — never relay that structure or extra days/detail nobody asked for. Pull out just the one or two facts that answer what was actually asked and say them as plain spoken sentences, exactly like every other answer.
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

/**
 * Builds the system prompt as one plain string — the Responses API takes it
 * as a single top-level `instructions` field, not a separate message in the
 * history the way Chat Completions' {role:"system"} or Anthropic's blocks
 * array worked. OpenAI's own prompt caching is automatic prefix-matching (no
 * explicit cache_control markers to set, unlike Anthropic), so this doesn't
 * need the old cacheable/uncacheable block split either — just keep the part
 * that never changes (STATIC_INSTRUCTIONS) first, so the cacheable prefix
 * stays as long as possible.
 */
function buildSystem(userId: string, timezone?: string, accountsByToolkit?: AccountsByToolkit): string {
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
 * Converts a tool definition into the Responses API's flat function-tool
 * shape ({type:"function", name, description, parameters} — no nested
 * "function" wrapper). Handles all three shapes this codebase's tools can
 * arrive in:
 *   - our own custom tools (search_gmail, add_calendar_event, make_phone_call,
 *     etc.) — Anthropic-style {name, description, input_schema}.
 *   - Composio-provided tools — arrive via @composio/openai's OpenAIProvider
 *     as the Chat-Completions-nested {type:"function", function:{name,
 *     description, parameters}} shape, which needs flattening.
 *   - the built-in web_search tool (see tools/index.ts) — already
 *     {type:"web_search"}, passed through unchanged; it's resolved entirely
 *     server-side by OpenAI, so it never reaches executeTool() below.
 */
function toResponsesTool(t: any): any {
  if (t.type === "web_search") return t;
  if (t.input_schema) return { type: "function", name: t.name, description: t.description, parameters: t.input_schema };
  if (t.type === "function" && t.function) {
    return { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters };
  }
  return t; // already correctly shaped
}

function safeParseArgs(raw: string | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
const MAX_HISTORY_CHARS = 400_000; // ~100k tokens at ~4 chars/token — deliberately kept the same conservative budget as before, well under gpt-4.1-mini's much larger context window, leaving plenty of room for the system prompt, tool schemas, and response.

/**
 * Drops items from the MIDDLE of `messages` once its total size crosses
 * MAX_HISTORY_CHARS, always keeping message 0 (the original request) AND as
 * much of the recent tail as fits.
 *
 * Same round-boundary approach as the pre-swap Anthropic version, adapted to
 * the Responses API's flat item shape (no wrapping {role:"assistant",
 * content:[...tool_use blocks]} container — a model turn's function_calls are
 * top-level items in `input`, one after another). A safe cut point is either
 * a plain assistant text item (role: "assistant") or the FIRST function_call
 * item of a fresh batch (checked via the previous item not also being a
 * function_call) — cutting there never splits a function_call from its
 * matching function_call_output, since this file always pushes a batch's
 * calls and then its outputs contiguously, never interleaved with anything
 * else.
 */
function isRoundStart(item: any, prev: any): boolean {
  if (item.role === "assistant") return true;
  if (item.type === "function_call" && prev?.type !== "function_call") return true;
  return false;
}

function trimMessageHistory(messages: any[]): any[] {
  const originalSize = JSON.stringify(messages).length;
  if (originalSize <= MAX_HISTORY_CHARS) return messages;

  const roundStarts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (isRoundStart(messages[i], messages[i - 1])) roundStarts.push(i);
  }
  if (roundStarts.length === 0) {
    // Nothing but the opening message and its immediate function_call_output,
    // if any — already as small as this can get.
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
  // oversized) rather than give up. Keeping `head` here isn't optional —
  // it's the user's actual original request, and losing it is the exact bug
  // this function exists to prevent.
  console.warn(`[llm] conversation history still large (${originalSize} chars) even after trimming to the original request + most recent round`);
  return [...head, ...messages.slice(roundStarts[roundStarts.length - 1])];
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
 * genuinely opaque and get the generic apology — but a couple of specific,
 * common causes are worth naming instead of leaving the user debugging a
 * phantom code issue: a rate limit (429) or an out-of-quota/billing account,
 * OpenAI's own wording for both confirmed against their error responses
 * (`insufficient_quota` is the error code OpenAI returns for the latter,
 * distinct from Anthropic's differently-worded "credit balance is too low"
 * this check used to look for).
 */
export function describeConversationError(err: any, fallback = "Sorry, something went wrong on my end just now."): string {
  const message = String(err?.message ?? "");
  if (/insufficient_quota|exceeded.*quota|billing/i.test(message)) {
    return "My brain's out of credits — the OpenAI account behind me needs more added at platform.openai.com, under Billing, before I can keep going.";
  }
  if (err?.status === 429 || /rate.?limit/i.test(message)) {
    return "I'm getting rate-limited right now — give it a few seconds and try again.";
  }
  if (/timed out/i.test(message)) {
    return "Sorry, that took too long and timed out — try asking again.";
  }
  return fallback;
}

// CONFIRMED BY TESTING: a real live session logged a delegation that started
// ("who is the current president of America") and then NEVER got an answer —
// no error, no timeout, nothing, ever, for the rest of that session. Plain
// `fetch` has no default timeout, unlike the Anthropic SDK this replaced
// (which had its own built-in one) — a single stalled OpenAI request could
// hang this call, and therefore the whole live session waiting on it,
// forever. Since a live voice turn goes through this exact function, a hang
// here manifests to the user as the UI stuck on "Powering on..." or
// "Thinking..." with no way out short of reloading the page. Bounded here
// instead: any request that hasn't resolved in 25s is aborted and surfaces
// as a normal, catchable error, which describeConversationError below turns
// into something Nova can actually say instead of silence.
const REQUEST_TIMEOUT_MS = 25_000;

async function callModel(input: any[], instructions: string, tools: any[]): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/responses`, {
    method: "POST",
    signal: controller.signal,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_REASONING_MODEL,
      instructions,
      input,
      tools,
      tool_choice: "auto",
      // CONFIRMED BY TESTING (pre-swap, against Claude): 300 was sized for
      // spoken replies (short) but also caps how much STRUCTURED TOOL-CALL
      // JSON the model can emit in one response — a completely different
      // thing. Several calendar events at once needed multiple function_call
      // items in one response, and 300 tokens wasn't enough room for that
      // JSON. Kept at the same raised value here; the actual SPOKEN answer
      // stays short regardless, since that's a separate, later message.
      max_output_tokens: 1024,
      // Nova manages her own trimmed/rolled-back history in `messages` —
      // she doesn't want or need OpenAI's server-side conversation state
      // (previous_response_id), so this is always a fresh, stateless call
      // with the full input resent, matching how the Anthropic version and
      // the Groq/Gemini version before it both worked.
      store: false,
    }),
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`OpenAI Responses API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err: any = new Error(json?.error?.message ?? `OpenAI Responses API error (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return json;
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
  const apiTools = tools.map(toResponsesTool);

  let response = await callModel(messages, instructions, apiTools);

  let fillerFired = false;
  let guard = 0;
  const MAX_TOOL_ROUNDS = 6; // was 4 — too tight for e.g. "look this up, then create several calendar events," which needs more than one round-trip per event

  while (guard < MAX_TOOL_ROUNDS && !shouldStop?.()) {
    const output: any[] = response.output ?? [];
    const functionCalls = output.filter((o) => o.type === "function_call");
    if (functionCalls.length === 0) break;
    guard++;

    if (!fillerFired) {
      const slowCall = functionCalls.find((fc) => isSlowTool(fc.name));
      if (slowCall) {
        fillerFired = true;
        await onSlowTool({ name: slowCall.name, input: safeParseArgs(slowCall.arguments) });
      }
    }

    // Persist exactly what the model produced this round — its function_call
    // items (verbatim, so their id/call_id round-trip correctly) and any
    // accompanying text/message item — before appending the tool results.
    // web_search_call/reasoning bookkeeping items are deliberately dropped:
    // web search is resolved entirely server-side (confirmed via OpenAI's
    // own docs), so there's nothing to replay for it, and reasoning items
    // aren't meant to be fed back as conversation history.
    messages.push(...output.filter((o) => o.type === "function_call" || o.type === "message"));

    // Same truncation strategy as the pre-swap version, still load-bearing:
    // CONFIRMED BY TESTING (against Claude, but the underlying problem is
    // provider-agnostic): GMAIL_FETCH_EMAILS called with no args (i.e.
    // whenever the user just says "check my email") came back with full
    // message bodies large enough to blow well past a model's context
    // window in one tool result alone — one oversized tool result silently
    // wedging the ENTIRE rest of the session, not just the turn that
    // triggered it, since the poisoned content stays in `messages` for
    // every future turn. truncateLongStrings shortens long free-text FIELDS
    // (email bodies, mainly) in place, so every item in an array — however
    // many there are — keeps every other field (dates, senders, subjects)
    // intact; MAX_TOOL_RESULT_TOTAL_CHARS is a hard backstop on top of that.
    const toolOutputs = await Promise.all(
      functionCalls.map(async (fc) => {
        let output: string;
        try {
          const input = safeParseArgs(fc.arguments);
          const result = await executeTool(fc.name, input, { userId, timezone });
          output = JSON.stringify(truncateLongStrings(result));
          if (output.length > MAX_TOOL_RESULT_TOTAL_CHARS) {
            const omitted = output.length - MAX_TOOL_RESULT_TOTAL_CHARS;
            output = `${output.slice(0, MAX_TOOL_RESULT_TOTAL_CHARS)}... [truncated — ${omitted} more characters omitted; ask a narrower question (e.g. "just unread", "just the last 5") if something's missing]`;
          }
        } catch (err: any) {
          output = JSON.stringify({ error: err?.message ?? "That tool failed." });
        }
        return { type: "function_call_output" as const, call_id: fc.call_id, output };
      })
    );
    messages.push(...toolOutputs);

    response = await callModel(messages, instructions, apiTools);
  }

  // Unconditionally push whatever this final response produced — mirrors the
  // pre-swap version's same unconditional push right after the loop, and
  // covers both a clean finish (a plain message item) AND a still-has-
  // function_calls state (the guard cap above was hit before they could be
  // answered).
  const finalOutput: any[] = response.output ?? [];
  messages.push(...finalOutput.filter((o) => o.type === "function_call" || o.type === "message"));

  // CONFIRMED BY TESTING (pre-swap, against Claude, twice, via two different
  // triggers) — a turn left with unresolved function_calls and no matching
  // function_call_output corrupts every future call in the same conversation
  // history: the API requires every function_call to have a matching output
  // somewhere later in `input`, or the request is rejected outright, forever,
  // since `messages` is the session's whole reused history. Fixed the same
  // way regardless of provider: check for orphaned function_calls directly,
  // by content, and satisfy the contract with a synthetic "cancelled" output
  // for each before doing anything else, so history is always valid going
  // forward no matter how this happens next.
  const orphaned = finalOutput.filter((o) => o.type === "function_call");
  if (orphaned.length > 0) {
    const cancelOutputs = orphaned.map((fc) => ({
      type: "function_call_output" as const,
      call_id: fc.call_id,
      output: JSON.stringify({ error: "Paused here — will resume with the next batch of tool calls shortly." }),
    }));
    messages.push(...cancelOutputs);
    // `needsMoreWork: true` tells the caller (liveDelegate.ts) this genuinely
    // isn't finished — a big enough job (e.g. "mark every court holiday this
    // year") needs more rounds than one call here allows. Rather than just
    // giving up, the caller can keep calling this function again with the
    // same `messages` (now left in a valid, resumable state above) as a
    // background job, independent of the live voice turn that kicked it off.
    return { finalText: "This is a bigger job — I'll keep working on it in the background, so ask me anything in the meantime.", messages, needsMoreWork: true };
  }

  // The real answer is whatever text the LAST message item(s) in this final
  // response carry — when web_search ran, the output array can include a
  // web_search_call item followed by the actual answer message (search is
  // resolved inline, no round-trip needed from us), so joining every
  // output_text piece across every message item here (not just the very
  // last block) is what keeps a cited, multi-part answer from being cut off.
  const finalText =
    finalOutput
      .filter((o) => o.type === "message")
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("")
      .trim() || "Sorry, I didn't catch that.";

  return { finalText, messages };
}
