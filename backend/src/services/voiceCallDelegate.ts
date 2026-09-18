import type { WebSocket } from "ws";
import { runConversationTurn, describeConversationError } from "./llm.js";
import { getComposioTools, getAccountsByToolkit } from "./composio.js";
import { startTask, finishTask, recordProgress, actionsSince, type Task } from "./tasks.js";
import { staticTools, buildFillerText } from "../tools/index.js";
import { db } from "./db.js";

const MAX_BACKGROUND_STEPS = 12; // same cap/reasoning as liveDelegate.ts / smsDelegate.ts

type QueueItem = { type: "user"; text: string } | { type: "continue"; step: number };
type Session = { messages: any[]; queue: QueueItem[]; draining: boolean; task?: Task };

// Keyed by phone number (== userId everywhere else), same as smsDelegate.ts
// — a call-back shortly after hanging up picks the conversation back up
// rather than starting cold. In-memory, matching this project's other
// per-process state; resets on a backend restart.
const sessions = new Map<string, Session>();

function getSession(phoneNumber: string): Session {
  let session = sessions.get(phoneNumber);
  if (!session) {
    session = { messages: [], queue: [], draining: false };
    sessions.set(phoneNumber, session);
  }
  return session;
}

/** Calling the number IS signing up — same reasoning as smsDelegate.ts's ensureUser: Twilio's `from` field on the call is carrier-verified, nothing extra to confirm. */
function ensureUser(phoneNumber: string) {
  db.prepare(`INSERT INTO users (id, phone_number, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
    phoneNumber,
    phoneNumber,
    Date.now()
  );
}

/** Speaks `text` on the call — ConversationRelay converts this to speech itself (see routes/voiceCall.ts); we only ever deal in plain text. */
function say(ws: WebSocket, text: string, last = true) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "text", token: text, last }));
}

/** One real turn: gather this user's tools, run it through Nova's brain, speak the answer. Mirrors smsDelegate.ts's handleUserText almost exactly — the only real difference is replies go back over this call's own socket instead of a separate outbound SMS. */
async function handleUserText(ws: WebSocket, phoneNumber: string, session: Session, text: string) {
  const turnStart = Date.now();
  const beforeTurn = session.messages.length;
  session.messages.push({ role: "user", content: text });

  try {
    const [composioTools, accountsByToolkit] = await Promise.all([
      getComposioTools(phoneNumber),
      getAccountsByToolkit(phoneNumber),
    ]);
    const tools = [...staticTools, ...composioTools];

    let fillerSent = false;
    const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
      messages: session.messages,
      tools,
      userId: phoneNumber,
      accountsByToolkit,
      onSlowTool: async (block) => {
        if (fillerSent) return;
        fillerSent = true;
        // `last: false` — more speech (the real answer) is still coming right
        // after this on the same turn, unlike the final reply below.
        say(ws, buildFillerText(block), false);
      },
    });

    session.messages = updated;
    say(ws, finalText);
    console.log(`[voice-call] turn for ${phoneNumber} answered in ${Date.now() - turnStart}ms → "${finalText}"`);

    if (needsMoreWork) {
      session.task = startTask(phoneNumber, text);
      recordProgress(session.task, actionsSince(session.messages, beforeTurn));
      session.queue.push({ type: "continue", step: 1 });
      void drainQueue(ws, phoneNumber, session);
    }
  } catch (err: any) {
    console.error(`[voice-call] turn for ${phoneNumber} failed:`, err?.message ?? err);
    // Same recovery as smsDelegate.ts/liveDelegate.ts — discard exactly what
    // this failed turn added so the next thing they say starts from the last
    // known-good history instead of resending poisoned content forever.
    session.messages = session.messages.slice(0, beforeTurn);
    say(ws, describeConversationError(err));
  }
}

/** One round of an in-progress background task (see llm.ts's needsMoreWork). Mirrors smsDelegate.ts's continueBackgroundStep. */
async function continueBackgroundStep(ws: WebSocket, phoneNumber: string, session: Session, step: number) {
  const task = session.task;
  if (!task) return;
  if (task.cancelRequested) {
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
      void drainQueue(ws, phoneNumber, session);
      return;
    }

    const report = needsMoreWork ? `I got through as much as I could, but couldn't finish everything: ${finalText}` : finalText;
    finishTask(task, "done", report, true); // spoken right away below, so nothing to save for a "by the way"
    say(ws, report);
    console.log(`[voice-call] background task for ${phoneNumber} finished after ${step} step(s)`);
  } catch (err: any) {
    console.error(`[voice-call] background task for ${phoneNumber} failed at step ${step}:`, err?.message ?? err);
    const description = describeConversationError(err, "Sorry, I ran into a problem partway through that — some of it may not have gotten done.");
    finishTask(task, "failed", description, true);
    say(ws, description);
  }
}

// Same "one at a time, strictly serialized" queue as liveDelegate.ts/
// smsDelegate.ts — a background task's continuation step and a brand new
// thing the caller says must never touch `session.messages` concurrently.
async function drainQueue(ws: WebSocket, phoneNumber: string, session: Session) {
  if (session.draining) return;
  session.draining = true;
  while (session.queue.length > 0) {
    const item = session.queue.shift()!;
    if (item.type === "user") await handleUserText(ws, phoneNumber, session, item.text);
    else await continueBackgroundStep(ws, phoneNumber, session, item.step);
  }
  session.draining = false;
}

/**
 * Attaches Nova's brain to one live phone call's ConversationRelay
 * WebSocket (see routes/voiceCall.ts for the TwiML that opens it, and
 * index.ts for where this gets wired to an incoming connection). Twilio
 * itself handles speech-to-text and text-to-speech here — same "someone
 * else owns listening/speaking, we only exchange text" shape as
 * liveDelegate.ts (GPT-Live-1) and smsDelegate.ts, just a third transport
 * for the identical Claude+Composio brain underneath.
 * Docs: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
 */
export function attachVoiceCallDelegate(ws: WebSocket) {
  let phoneNumber: string | null = null;
  let session: Session | null = null;

  ws.on("message", (raw) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      // Fired once, right when the call connects — carries the caller's own
      // number (carrier-verified, same identity model as SMS) and the
      // Twilio call id, nothing else useful to us here.
      case "setup": {
        phoneNumber = typeof event.from === "string" ? event.from : null;
        if (!phoneNumber) {
          console.warn(`[voice-call] setup event had no caller number — call ${event.callSid} can't be attributed to an account`);
          break;
        }
        ensureUser(phoneNumber);
        session = getSession(phoneNumber);
        console.log(`[voice-call] call ${event.callSid} from ${phoneNumber} connected`);
        break;
      }

      // Twilio only marks a prompt `last: true` once the caller's whole
      // utterance is transcribed — anything before that is a stream of
      // partial guesses not worth acting on yet.
      case "prompt": {
        if (!phoneNumber || !session || !event.last) break;
        const text = String(event.voicePrompt ?? "").trim();
        if (!text) break;
        session.queue.push({ type: "user", text });
        void drainQueue(ws, phoneNumber, session);
        break;
      }

      case "interrupt":
        // The caller started talking over Nova's answer — Twilio already
        // stopped playback on its own end. There's nothing in flight on our
        // side to cancel (a turn always sends ONE complete reply, never a
        // stream), so this is just informational.
        break;

      case "error":
        console.error(`[voice-call] ConversationRelay reported an error:`, event.description ?? event);
        break;

      default:
        break; // dtmf, language, etc. — nothing to do with these yet
    }
  });

  ws.on("close", () => {
    if (phoneNumber) console.log(`[voice-call] call from ${phoneNumber} ended`);
  });

  ws.on("error", (err) => {
    console.error(`[voice-call] websocket error:`, err.message);
  });
}
