import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { env } from "../config.js";
import { scheduleReminder } from "./reminders.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * A real outbound phone call Nova places and leads herself — "call the
 * library and ask if they have this book," "call the restaurant and book a
 * table" — as opposed to every other voice/SMS/live flow in this app, where
 * Nova only ever RESPONDS to someone who reached out to her. Deliberately a
 * separate, narrow conversation from the household Nova brain (llm.ts):
 * that one has ~1,500 toolkits and a big personality; this one has exactly
 * one job (the objective) and one tool (finish_call) to know, deterministically,
 * the instant that job is done — same "don't trust prose to notice something
 * important, make it a real code path" pattern as the multi-account guard and
 * the reminder phrasing.
 */
export type OutboundCall = {
  id: string;
  callSid?: string;
  userId: string;
  toNumber: string;
  objective: string;
  openingLine: string;
  callerName?: string;
  messages: any[];
  status: "dialing" | "active" | "completed" | "failed";
  outcome?: string;
  createdAt: number;
};

// In-memory, matching this project's other per-process state (reminders.ts,
// tasks.ts) — resets on a backend restart, fine for a single-process app.
const calls = new Map<string, OutboundCall>();

const finishCallTool = {
  type: "function" as const,
  name: "finish_call",
  description:
    "Call this the instant you have a real, final result for the objective — success, partial success, or a clear reason it can't be done — or if the call clearly isn't going anywhere (wrong number, no one available) and should end. Always include a short, natural spoken goodbye in your reply TEXT in this SAME response — the call hangs up right after, so this is the last chance to say anything.",
  parameters: {
    type: "object" as const,
    properties: {
      outcome: {
        type: "string",
        description:
          'A complete, plain sentence describing what actually happened on the call — this gets read back to the person Nova called for, so make it specific. E.g. "Called the downtown library — they have Dune in stock and will hold it under Alex\'s name until Friday." Never invent a detail that wasn\'t actually said on the call.',
      },
      success: { type: "boolean", description: "Whether the objective was actually accomplished." },
    },
    required: ["outcome", "success"],
  },
};

function buildOutboundSystem(call: OutboundCall): string {
  return `You are Nova, an AI assistant placing a real phone call on behalf of ${call.callerName || "someone"}, to accomplish exactly this objective: "${call.objective}".

You already said your opening line the instant the call connected. Now have a natural, brief phone conversation with whoever answers to get the objective done. Ask only what's actually necessary. If asked who's calling or why, say you're Nova, an AI assistant calling on behalf of ${call.callerName || "someone"}.

Every reply is spoken out loud on a real phone call — keep it to one or two short sentences, plain conversational language, no lists, no markdown.

The moment you have a real, final result, call finish_call, and in that SAME reply include a short natural goodbye (e.g. "Great, thank you so much, bye!"). Also call finish_call if the call clearly isn't going anywhere — wrong number, no one available, they can't help — using whatever partial information you have as the outcome. Never end a reply that calls finish_call without also saying goodbye in it.`;
}

/**
 * Places the real call via Twilio's REST API. `Url` points Twilio at
 * routes/voiceCall.ts's /outbound-twiml once the call is answered, which
 * looks this call back up by `id` to know what to say and do — Twilio
 * doesn't hand back OUR id anywhere else, so it has to round-trip through
 * the URL. `StatusCallback` with the "completed" event is how a call that's
 * never answered (no-answer/busy/failed/canceled) still gets reported back,
 * since ConversationRelay's own websocket never opens for those.
 */
/**
 * CONFIRMED BY TESTING — a real bad outcome, not hypothetical: a user gave
 * three quick corrections in a row ("actually 7:30", "actually 8pm") while
 * the FIRST call to their friend was still ringing/in progress, and each
 * correction placed a brand new, separate real phone call to the same
 * person rather than updating the one already happening — three calls to
 * one friend within about a minute. Guarded against here rather than left to
 * the household LLM to "remember" it already called someone, matching this
 * project's whole pattern of putting things that actually matter in code.
 */
function hasActiveCallTo(userId: string, toNumber: string): boolean {
  for (const call of calls.values()) {
    if (call.userId === userId && call.toNumber === toNumber && (call.status === "dialing" || call.status === "active")) return true;
  }
  return false;
}

/**
 * A short, recent-first summary of calls this user has placed, meant to be
 * folded into the household brain's system prompt (see llm.ts) so a BRAND
 * NEW session — which starts with zero conversation history of its own —
 * can still correctly answer "who did you call" / "what number was that"
 * instead of saying "I haven't called anyone," which is what happened before
 * this existed (confirmed live: a follow-up question in a new session got
 * exactly that wrong answer, since the calls were placed by an earlier,
 * already-closed session with no memory in common with this one). Capped to
 * a short recent window so a call from days ago doesn't linger in context
 * forever.
 */
export function recentCallsSummary(userId: string): string | null {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
  const mine = [...calls.values()]
    .filter((c) => c.userId === userId && c.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);
  if (mine.length === 0) return null;

  return mine
    .map((c) => {
      const when = new Date(c.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const outcome = c.status === "dialing" || c.status === "active" ? "still in progress right now" : c.outcome ?? "no result recorded";
      return `${c.toNumber} at ${when} — objective: "${c.objective}" — ${outcome}`;
    })
    .join("; ");
}

export async function placeOutboundCall(args: {
  userId: string;
  toNumber: string;
  objective: string;
  openingLine: string;
  callerName?: string;
}): Promise<{ id: string; callSid: string }> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !env.PUBLIC_BASE_URL) {
    throw new Error("Twilio isn't fully configured yet, so I can't place a real call.");
  }
  if (hasActiveCallTo(args.userId, args.toNumber)) {
    throw new Error(
      `Already on a call with ${args.toNumber} right now — don't call them again for this. Tell the user that call is still in progress and their update will be included once it's possible, or that they should wait for it to finish first.`
    );
  }

  const id = randomUUID();
  const call: OutboundCall = {
    id,
    userId: args.userId,
    toNumber: args.toNumber,
    objective: args.objective,
    openingLine: args.openingLine,
    callerName: args.callerName,
    messages: [],
    status: "dialing",
    createdAt: Date.now(),
  };
  calls.set(id, call);

  const params = new URLSearchParams({
    To: args.toNumber,
    From: env.TWILIO_PHONE_NUMBER,
    Url: `${env.PUBLIC_BASE_URL}/api/voice-call/outbound-twiml?callId=${id}`,
    StatusCallback: `${env.PUBLIC_BASE_URL}/api/voice-call/outbound-status?callId=${id}`,
    StatusCallbackEvent: "completed",
  });
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

  const resp = await fetch(`${TWILIO_API_BASE}/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    calls.delete(id);
    const detail = await resp.text().catch(() => "");
    throw new Error(`Twilio call failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  call.callSid = data.sid;
  return { id, callSid: data.sid };
}

export function getOutboundCall(id: string): OutboundCall | undefined {
  return calls.get(id);
}

/**
 * Marks a call finished (however that happened — finish_call, a hangup, or
 * a Twilio status callback for a call that never even connected) and
 * proactively tells the user what happened. Reuses reminders.ts's exact
 * "speak up on her own, the moment she's next listening, at zero GPT-Live
 * cost while waiting" mechanism — there's no reason to build a second
 * version of that for this.
 */
export function finishOutboundCall(id: string, outcome: string, status: "completed" | "failed" = "completed") {
  const call = calls.get(id);
  if (!call || call.status === "completed" || call.status === "failed") return; // only ever finish once
  call.status = status;
  call.outcome = outcome;
  scheduleReminder(call.userId, outcome, 1);
}

/**
 * One round of the outbound call's own goal-driven conversation. Deliberately
 * NOT runConversationTurn (llm.ts) — that's built for a completely different
 * job (a household assistant with ~1,500 possible tools and a long-lived,
 * many-topic conversation). This call has exactly one objective and exactly
 * one tool, so there's no round-limit/background-task machinery to reuse or
 * reimplement here — either finish_call gets called, or the human keeps
 * talking and we keep replying.
 */
export async function runOutboundTurn(call: OutboundCall, humanText: string): Promise<{ reply: string; done: boolean }> {
  call.messages.push({ role: "user", content: humanText });
  const system = buildOutboundSystem(call);

  // "minimal" reasoning, and a bigger token budget than the 300 this used on
  // the previous brain: a live phone call is the most latency-sensitive path
  // in the app (dead air on an open line to a stranger), and reasoning
  // tokens come out of the same budget as the reply itself.
  const response: any = await openai.responses.create({
    model: env.OPENAI_BRAIN_MODEL,
    instructions: system,
    input: call.messages,
    tools: [finishCallTool],
    max_output_tokens: 1024,
    reasoning: { effort: "minimal" },
  } as any);
  call.messages.push(...response.output);

  const output = response.output as any[];
  const finishBlock = output.find((b) => b?.type === "function_call" && b.name === "finish_call");
  const textReply = output
    .filter((b) => b?.type === "message")
    .flatMap((b) => (b.content ?? []) as any[])
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text)
    .join(" ")
    .trim();

  if (finishBlock) {
    let args: any = {};
    try {
      args = JSON.parse(finishBlock.arguments || "{}");
    } catch {
      args = {};
    }
    const outcome = String(args?.outcome ?? "The call ended, but I don't have a clear result to report.");
    finishOutboundCall(call.id, outcome, "completed");
    return { reply: textReply || "Thanks so much, goodbye!", done: true };
  }

  return { reply: textReply || "Sorry, could you say that again?", done: false };
}
