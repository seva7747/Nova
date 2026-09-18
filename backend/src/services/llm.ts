import { env } from "../config.js";
import { executeTool, isSlowTool } from "../tools/index.js";

// Nova's brain runs on Gemini's OpenAI-compatible chat completions endpoint
// — see config.ts for the full history of why (Anthropic → Groq → here).
// Kept as a plain constant, not an env var, since it's fixed for this
// provider; the whole surface below only cares about base URL + key + model,
// so swapping to yet another OpenAI-compatible provider is a config change
// here, not a rewrite.
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

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
//
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
- You do NOT currently have a way to search the web or look up live information — no tool for weather, sports scores/schedules, news, prices, or anything else that changes over time or postdates your training. If asked something like that, say plainly that you can't look that up right now rather than guessing or answering from possibly-stale training data.
- You also have a tool to call a restaurant and book a table, tools for Gmail search/send/reply, and tools for whichever other services the user has connected through the Connectors page — that list varies per user and can be any of roughly 1,500 possible services (Calendar, Drive, Slack, Notion, Todoist, WhatsApp, Spotify, and many more), not a fixed set, so go by whatever tools are actually available to you in a given conversation rather than assuming a specific list. Only call a tool when the request actually needs it. WhatsApp (when connected) can only send messages, not read them — if asked to check WhatsApp messages, say that isn't something you can do rather than guessing.
- For anything about Gmail — searching, counting, "did I get an email from X," "how many yesterday" — always use search_gmail, never try to guess at Gmail's raw search syntax or do date-range math yourself. Say what you mean in its terms (sinceDaysAgo/untilDaysAgo as plain small numbers — 0 = today, 1 = yesterday, 7 = a week ago; onlyReceived defaults to true) and it handles timezones and query-building correctly. For a count, use returnedCount when countIsExact is true — that's a real, complete count. totalMatching is Gmail's own rough ESTIMATE and can be badly wrong (confirmed: 201 vs a true 49) — only fall back to it, and call it approximate out loud, when countIsExact is false and fetching everything genuinely isn't practical. Leave includeContent false unless you actually need to read what's inside specific emails — it's faster and more reliable that way. If a name search comes back empty, Gmail matches text not phonetics — ask the user to confirm the spelling before concluding there's nothing. Never state a specific date, sender, or detail that isn't literally in the returned data — if you're summarizing many messages, describe what's actually there, don't invent or extrapolate examples.
- For Canvas (school courses/assignments/grades), figure out course/assignment ids by calling the list tools first (e.g. CANVAS_LIST_COURSES) rather than guessing them — nearly every per-course Canvas tool needs a real numeric id, not a course name. A grade, score, or due date is exactly the kind of thing that's actively harmful to get wrong — never state one that isn't literally in a tool's returned data, and never round, estimate, or infer one from partial information.
- To add anything to the calendar, always use add_calendar_event, never GOOGLECALENDAR_CREATE_EVENT directly — it checks for an existing same-titled event on that date first and skips creating it again, so a repeated or re-run bulk request (e.g. marking a list of holidays) never creates duplicates. Omit startTime for an all-day marker (holidays, reminders) — that's the normal case; only set it for an actual timed event. Whenever the user gives (or implies) an end time — a class, a meeting, anything with a real duration — pass endTime, not durationMinutes; endTime is the reliable one for anything longer than an hour.
- Composio-backed tools and the restaurant tool represent real, slower actions. Go ahead and call them as soon as you have what you need — the app already tells the user you're working on it, so you don't need to add filler text like "give me a moment" yourself. Just answer normally once the tool result comes back.
- When one request needs several separate actions (e.g. "add all of these to my calendar" for a whole list of items), call the tool once per item, one at a time across as many turns as it takes, rather than trying to fit many calls into a single response — that's both more reliable and lets you confirm progress as you go.
- Be proactive, not just a reader: when an email (or anything else you look up) contains something with an obvious next step, don't just read it back and stop — offer the obvious next action in the same breath, specific to what's actually in it and to whichever connected tools actually apply. Draw on ALL the services currently connected, not just calendar/reply — e.g. "Want me to add that to your calendar?", "Want me to reply and let them know?", "Want me to add that as a task in Notion?", "Want me to add this to Todoist?", whatever fits what you actually have connected and what the content calls for. Keep it short, and only offer when there's a real, concrete action to take — don't tack this onto every routine email that has nothing to act on. If the user says yes, go do it; don't ask a second confirming question first.`;

type AccountsByToolkit = Record<string, { id: string; label: string }[]>;

/**
 * Builds the system message as one string — this API's chat completions
 * shape has no separate top-level `system` field the way Anthropic's does,
 * just a normal {role:"system"} message first in the array.
 */
function buildSystemPrompt(timezone?: string, accountsByToolkit?: AccountsByToolkit): string {
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

  let system = `${STATIC_INSTRUCTIONS}\n\nRight now it is ${when}. Resolve any relative day/time the user gives you ("this Thursday", "tomorrow at 4", "in an hour") against that moment and timezone.`;

  // Multiple accounts connected for the same service (e.g. two Gmail
  // addresses) — see composio.ts's patchMultiAccountTools, which is what
  // actually adds the connectedAccountId field these tools now accept.
  const multi = Object.entries(accountsByToolkit ?? {}).filter(([, accounts]) => accounts.length > 1);
  if (multi.length > 0) {
    const desc = multi
      .map(([slug, accounts]) => `${slug} — ${accounts.map((a) => `"${a.label}" (id: ${a.id})`).join(", ")}`)
      .join("; ");
    system += `\n\nThe user has more than one account connected for some services: ${desc}. If a request could apply to any of them and it isn't already clear which one, ask the user which account before calling a tool for that service — don't just guess or default to one. Once you know (they said, or only one makes sense for the request), pass that account's id as the tool's "connectedAccountId" input.`;
  }

  return system;
}

/**
 * Every tool this codebase defines itself (search_gmail, add_calendar_event,
 * call_restaurant) still exports the same {name, description, input_schema}
 * shape it always has — that's plain JSON Schema either way, so there was no
 * need to touch those files for the provider swap. Composio's tools already
 * arrive correctly shaped (see services/composio.ts's OpenAIProvider) as
 * {type:"function", function:{...}} and pass through unchanged; any built-in
 * server-side search tool (see tools/index.ts) does too, whatever shape this
 * provider expects for it. This just wraps the ones that need it.
 */
function toApiTool(t: any): any {
  if (!t.input_schema) return t; // already correctly shaped (Composio's function tools) or a non-function built-in tool entry
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
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
const MAX_HISTORY_CHARS = 400_000;

/**
 * Drops the oldest whole turns from `messages` once its total size crosses
 * MAX_HISTORY_CHARS, always keeping at least the most recent turn. In this
 * API's shape a tool result is its own {role:"tool"} message (never role
 * "user"), so — unlike the Anthropic version of this function — EVERY
 * {role:"user"} message is a genuine turn boundary; no need to distinguish
 * real user text from a tool result glued onto the same role. Cutting only
 * at these boundaries means every tool_calls/tool-result set that survives
 * the trim is always complete — never orphaned the way the session-
 * corruption bug elsewhere in this file was.
 */
function trimMessageHistory(messages: any[]): any[] {
  const originalSize = JSON.stringify(messages).length;
  if (originalSize <= MAX_HISTORY_CHARS) return messages;

  const turnStarts = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);

  for (let i = 0; i < turnStarts.length - 1; i++) {
    const candidate = messages.slice(turnStarts[i + 1]);
    if (JSON.stringify(candidate).length <= MAX_HISTORY_CHARS) {
      console.log(
        `[llm] trimmed conversation history: ${messages.length} messages (${originalSize} chars) → ${candidate.length} messages, dropped ${i + 1} oldest turn(s)`
      );
      return candidate;
    }
  }
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
};

/**
 * Turns a failed turn into what Nova should actually say. Most failures are
 * genuinely opaque and get the generic apology — but a couple of specific,
 * common causes are worth naming instead of leaving the user debugging a
 * phantom code issue: a rate limit (429) or a low account balance, from
 * whichever provider is currently wired up here (see the history in
 * config.ts) — both patterns kept generic/regex-based rather than tied to
 * one provider's exact wording, on purpose, since this has already changed
 * providers twice.
 */
export function describeConversationError(err: any, fallback = "Sorry, something went wrong on my end just now."): string {
  const message = String(err?.message ?? "");
  if (err?.status === 429 || /rate.?limit/i.test(message)) {
    return "I'm getting rate-limited right now — give it a few seconds and try again.";
  }
  if (/credit balance is too low|insufficient.?quota/i.test(message)) {
    return "My brain's out of credits — the account behind me needs more added before I can keep going.";
  }
  return fallback;
}

export async function runConversationTurn({ messages, tools, userId, timezone, accountsByToolkit, onSlowTool }: ConversationTurnArgs) {
  if (!env.GEMINI_API_KEY) {
    return {
      finalText: "Nova's brain isn't hooked up yet — add GEMINI_API_KEY to backend/.env.",
      messages,
    };
  }

  messages = trimMessageHistory(messages);

  const systemPrompt = buildSystemPrompt(timezone, accountsByToolkit);
  const apiTools = tools.map(toApiTool);
  const model = env.GEMINI_MODEL;
  // Same reasoning as the old maxTokens: sized for spoken replies, but also
  // needs enough room for structured tool-call JSON when several tool calls
  // come back in one response (e.g. several calendar events at once).
  const maxCompletionTokens = 1024;

  async function callModel(): Promise<any> {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GEMINI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools: apiTools,
        tool_choice: "auto",
        max_completion_tokens: maxCompletionTokens,
      }),
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err: any = new Error(json?.error?.message ?? `Gemini API error (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return json.choices[0];
  }

  let choice = await callModel();

  let fillerFired = false;
  let guard = 0;
  const MAX_TOOL_ROUNDS = 6; // was 4 — too tight for e.g. "look this up, then create several calendar events," which needs more than one round-trip per event

  while (choice.finish_reason === "tool_calls" && guard < MAX_TOOL_ROUNDS) {
    guard++;
    const toolCalls: any[] = choice.message.tool_calls ?? [];

    if (!fillerFired) {
      const slowCall = toolCalls.find((tc) => isSlowTool(tc.function.name));
      if (slowCall) {
        fillerFired = true;
        await onSlowTool({ name: slowCall.function.name, input: safeParseArgs(slowCall.function.arguments) });
      }
    }

    // Reconstructed as a clean {role, content, tool_calls} message rather
    // than replaying the API's raw response object — gpt-oss models attach
    // extra vendor fields (`reasoning`, `executed_tools`) that don't need to
    // round-trip back into history.
    messages.push({ role: "assistant", content: choice.message.content ?? null, tool_calls: toolCalls });

    // Same truncation strategy as before the Groq swap, still load-bearing —
    // see MAX_TOOL_RESULT_TOTAL_CHARS's comment above for why this matters
    // even more now (Groq's TPM budget is far tighter than Claude's context
    // window ever was).
    const toolResultMessages = await Promise.all(
      toolCalls.map(async (tc) => {
        let content: string;
        try {
          const input = safeParseArgs(tc.function.arguments);
          const result = await executeTool(tc.function.name, input, { userId, timezone });
          content = JSON.stringify(truncateLongStrings(result));
          if (content.length > MAX_TOOL_RESULT_TOTAL_CHARS) {
            const omitted = content.length - MAX_TOOL_RESULT_TOTAL_CHARS;
            content = `${content.slice(0, MAX_TOOL_RESULT_TOTAL_CHARS)}... [truncated — ${omitted} more characters omitted; ask a narrower question (e.g. "just unread", "just the last 5") if something's missing]`;
          }
        } catch (err: any) {
          content = JSON.stringify({ error: err?.message ?? "That tool failed." });
        }
        return { role: "tool" as const, tool_call_id: tc.id, content };
      })
    );
    messages.push(...toolResultMessages);

    choice = await callModel();
  }

  // Unconditionally push the final assistant turn — mirrors the pre-Groq
  // version's same unconditional push right after the loop, and covers both
  // a clean finish AND a still-has-tool_calls state (the guard cap above was
  // hit, or finish_reason came back "length" with partial tool_calls that
  // never entered the loop at all — same failure shape Claude's max_tokens
  // mid-tool-call case was, just under a different name here).
  messages.push({
    role: "assistant",
    content: choice.message.content ?? null,
    ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
  });

  // CONFIRMED BY TESTING (pre-Groq, against Claude, twice, via two different
  // triggers) — an assistant message left with tool_calls and no matching
  // tool response corrupts every future call in the same conversation history
  // forever. Same fix here regardless of provider: check for orphaned tool
  // calls directly, by content, and satisfy the contract with a synthetic
  // "cancelled" result for each before doing anything else.
  const orphaned: any[] = choice.message.tool_calls ?? [];
  if (orphaned.length > 0) {
    const cancelResults = orphaned.map((tc) => ({
      role: "tool" as const,
      tool_call_id: tc.id,
      content: JSON.stringify({ error: "Paused here — will resume with the next batch of tool calls shortly." }),
    }));
    messages.push(...cancelResults);
    // `needsMoreWork: true` tells the caller (liveDelegate.ts/smsDelegate.ts)
    // this genuinely isn't finished — a big enough job needs more rounds than
    // one call here allows. The caller can keep calling this function again
    // with the same `messages` (left in a valid, resumable state above) as a
    // background job, independent of whatever kicked it off.
    return { finalText: "This is a bigger job — I'll keep working on it and let you know when it's done.", messages, needsMoreWork: true };
  }

  const finalText = (choice.message.content ?? "").trim() || "Sorry, I didn't catch that.";
  return { finalText, messages };
}
