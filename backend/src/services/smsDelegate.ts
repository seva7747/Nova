import { runConversationTurn, describeConversationError } from "./llm.js";
import { getComposioTools, getAccountsByToolkit } from "./composio.js";
import { startTask, finishTask, recordProgress, actionsSince, type Task } from "./tasks.js";
import { staticTools, buildFillerText } from "../tools/index.js";
import { sendSms } from "./sms.js";
import { db } from "./db.js";

const MAX_BACKGROUND_STEPS = 12; // same cap/reasoning as liveDelegate.ts

type QueueItem = { type: "user"; text: string } | { type: "continue"; step: number };
type Session = { messages: any[]; queue: QueueItem[]; draining: boolean; task?: Task };

// Keyed by phone number (== userId everywhere else). Deliberately in-memory,
// matching this project's other per-process state (composio.ts's caches,
// tasks.ts) — conversation history resets on a backend restart. A real
// deployment serving many users indefinitely would want this persisted (e.g.
// a `sms_conversations` table), but that's more than this needs right now.
const sessions = new Map<string, Session>();

function getSession(phoneNumber: string): Session {
  let session = sessions.get(phoneNumber);
  if (!session) {
    session = { messages: [], queue: [], draining: false };
    sessions.set(phoneNumber, session);
  }
  return session;
}

/**
 * Texting the number IS signing up — unlike the web app's OTP flow, Twilio's
 * `From` field is already carrier-verified proof of ownership of that phone
 * number, so there's nothing extra to confirm. Safe no-op for a returning user.
 */
function ensureUser(phoneNumber: string) {
  db.prepare(`INSERT INTO users (id, phone_number, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
    phoneNumber,
    phoneNumber,
    Date.now()
  );
}

/** One real turn: gather this user's tools, run it through Nova's brain, text back the answer. Mirrors liveDelegate.ts's handleDelegation, minus anything voice-specific. */
async function handleUserText(phoneNumber: string, session: Session, text: string) {
  const turnStart = Date.now();
  const beforeTurn = session.messages.length;
  session.messages.push({ role: "user", content: text });

  try {
    const [composioTools, accountsByToolkit] = await Promise.all([
      getComposioTools(phoneNumber),
      getAccountsByToolkit(phoneNumber),
    ]);
    const tools = [...staticTools, ...composioTools];

    // A text conversation is one-shot request/reply, not a live spoken pause
    // — at most one extra "still working on it" text is worth sending, not a
    // running commentary the way GPT-Live's filler speech works.
    let fillerSent = false;
    const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
      messages: session.messages,
      tools,
      userId: phoneNumber,
      accountsByToolkit,
      onSlowTool: async (block) => {
        if (fillerSent) return;
        fillerSent = true;
        await sendSms(phoneNumber, buildFillerText(block));
      },
    });

    session.messages = updated;
    await sendSms(phoneNumber, finalText);
    console.log(`[sms] turn for ${phoneNumber} answered in ${Date.now() - turnStart}ms → "${finalText}"`);

    if (needsMoreWork) {
      session.task = startTask(phoneNumber, text);
      recordProgress(session.task, actionsSince(session.messages, beforeTurn));
      session.queue.push({ type: "continue", step: 1 });
      void drainQueue(phoneNumber, session);
    }
  } catch (err: any) {
    console.error(`[sms] turn for ${phoneNumber} failed:`, err?.message ?? err);
    // Same recovery as liveDelegate.ts — discard exactly what this failed
    // turn added so the next text starts from the last known-good history
    // instead of resending poisoned content forever.
    session.messages = session.messages.slice(0, beforeTurn);
    await sendSms(phoneNumber, describeConversationError(err)).catch(() => {});
  }
}

/** One round of an in-progress background task (see llm.ts's needsMoreWork). Mirrors liveDelegate.ts's continueBackgroundStep. */
async function continueBackgroundStep(phoneNumber: string, session: Session, step: number) {
  const task = session.task;
  if (!task) return;
  if (task.cancelRequested) {
    // The cancel_background_task tool already confirmed this in its own reply text.
    finishTask(task, "cancelled", `Cancelled after ${task.actions.length} action(s).`, true);
    return;
  }
  try {
    const [composioTools, accountsByToolkit] = await Promise.all([
      getComposioTools(phoneNumber),
      getAccountsByToolkit(phoneNumber),
    ]);
    const tools = [...staticTools, ...composioTools];

    const before = session.messages.length;
    const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
      messages: session.messages,
      tools,
      userId: phoneNumber,
      accountsByToolkit,
      onSlowTool: async () => {}, // no one's actively waiting on this step
      shouldStop: () => task.cancelRequested,
    });
    session.messages = updated;
    recordProgress(task, actionsSince(updated, Math.min(before, updated.length)));

    if (needsMoreWork && step < MAX_BACKGROUND_STEPS) {
      session.queue.push({ type: "continue", step: step + 1 });
      void drainQueue(phoneNumber, session);
      return;
    }

    const report = needsMoreWork ? `I got through as much as I could, but couldn't finish everything: ${finalText}` : finalText;
    finishTask(task, "done", report, true); // texted right away below, so nothing to save for a "by the way"
    await sendSms(phoneNumber, report);
    console.log(`[sms] background task for ${phoneNumber} finished after ${step} step(s)`);
  } catch (err: any) {
    console.error(`[sms] background task for ${phoneNumber} failed at step ${step}:`, err?.message ?? err);
    const description = describeConversationError(err, "Sorry, I ran into a problem partway through that — some of it may not have gotten done.");
    finishTask(task, "failed", description, true);
    await sendSms(phoneNumber, description).catch(() => {});
  }
}

// Same "one at a time, strictly serialized" queue as liveDelegate.ts, per
// phone number — a background task's continuation step and a brand new text
// from the same user must never touch `session.messages` concurrently.
async function drainQueue(phoneNumber: string, session: Session) {
  if (session.draining) return;
  session.draining = true;
  while (session.queue.length > 0) {
    const item = session.queue.shift()!;
    if (item.type === "user") await handleUserText(phoneNumber, session, item.text);
    else await continueBackgroundStep(phoneNumber, session, item.step);
  }
  session.draining = false;
}

/**
 * Entry point for an inbound SMS (see routes/sms.ts). Fire-and-forget by
 * design — the webhook route replies to Twilio immediately with empty TwiML
 * so a slow Claude/Composio turn never risks Twilio's ~15s webhook timeout;
 * the real answer goes out later via sendSms once this is done.
 */
export function handleIncomingSms(phoneNumber: string, text: string) {
  ensureUser(phoneNumber);
  const session = getSession(phoneNumber);
  session.queue.push({ type: "user", text });
  void drainQueue(phoneNumber, session);
}
