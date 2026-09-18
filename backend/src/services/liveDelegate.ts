import WebSocket from "ws";
import { env } from "../config.js";
import { runConversationTurn, describeConversationError } from "./llm.js";
import { getComposioTools, getAccountsByToolkit } from "./composio.js";
import { startTask, finishTask } from "./tasks.js";
import { staticTools, buildFillerText } from "../tools/index.js";

const MAX_BACKGROUND_STEPS = 12; // outer cap on top of runConversationTurn's own per-call round limit — see llm.ts

/**
 * Handles the actual conversation for a GPT-Live-1 session running in
 * "client delegation" mode.
 *
 * GPT-Live-1 owns listening, speaking, and turn-taking; it does NOT own
 * reasoning. Every time it decides a user request needs real thinking, it
 * fires a `session.delegation.created` event instead of answering itself.
 * This function attaches a second ("sideband") WebSocket to that same
 * session — separate from the browser's WebRTC connection, so the OpenAI
 * key and Composio/Anthropic calls never touch the browser — reconstructs
 * what the user said from the transcript deltas GPT-Live streamed alongside
 * the delegation, runs it through Nova's EXISTING brain (runConversationTurn:
 * Claude + web search + the restaurant tool + Composio's Gmail/Calendar
 * tools, unchanged from the classic pipeline), and speaks the result back by
 * appending it as "commentary" on that delegation.
 *
 * Docs: https://developers.openai.com/api/docs/guides/live-delegation
 */
export function attachLiveDelegate(sessionId: string, ctx: { userId: string; timezone?: string }) {
  if (!env.OPENAI_API_KEY) return;

  const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach`, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });

  // Same shape/contract as the classic pipeline's message array (see llm.ts)
  // — this IS Nova's memory for the session, just fed by delegations instead
  // of one-shot HTTP requests.
  let messages: any[] = [];
  let pendingUserText = "";
  let closed = false;

  const genId = () => Math.random().toString(36).slice(2, 10);

  const send = (obj: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  };

  /**
   * Speaks `content` as part of the given delegation. Docs confirm repeated
   * commentary.append calls can continue the same client delegation — that's
   * what makes the whole "keep working in the background, report back
   * later" flow possible: this can be called again long after the original
   * delegation's first response, once a background task tied to it finally
   * finishes, as long as the session (and this socket) is still open.
   */
  const say = (delegationId: string, content: string) => {
    send({ type: "session.commentary.append", event_id: `c_${genId()}`, delegation_id: delegationId, content });
  };

  // Everything that touches `messages` — a fresh user delegation, or the
  // next step of an in-progress background task — goes through this ONE
  // queue, processed strictly one at a time. CONFIRMED BY TESTING (the
  // earlier tool-result-size and orphaned-tool_use bugs): concurrent access
  // to that shared array is exactly the kind of thing that silently corrupts
  // a whole session, so a background task's continuation steps interleave
  // safely with any new question the user asks in the meantime, rather than
  // racing against it.
  type QueueItem = { type: "user"; delegationId: string; text: string } | { type: "continue"; delegationId: string; step: number };
  const queue: QueueItem[] = [];
  let draining = false;

  async function handleDelegation(delegationId: string, userText: string) {
    const turnStart = Date.now();
    console.log(`[live] delegation ${delegationId} → "${userText}"`);
    // Snapshotted so a failed turn can be rolled back below — runConversationTurn
    // mutates `messages` in place as it goes (assistant turn, tool results, ...),
    // so by the time it throws, the bad content is already sitting in the array
    // whether or not `messages = updated` below ever runs.
    const beforeTurn = messages.length;
    messages.push({ role: "user", content: userText });

    try {
      const [composioTools, accountsByToolkit] = await Promise.all([
        getComposioTools(ctx.userId),
        getAccountsByToolkit(ctx.userId),
      ]);
      const tools = [...staticTools, ...composioTools];

      const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
        messages,
        tools,
        userId: ctx.userId,
        timezone: ctx.timezone,
        accountsByToolkit,
        onSlowTool: async (block) => {
          say(delegationId, buildFillerText(block));
        },
      });

      messages = updated;
      say(delegationId, finalText);
      console.log(`[live] delegation ${delegationId} answered in ${Date.now() - turnStart}ms → "${finalText}"`);

      if (needsMoreWork) {
        // A big job (e.g. "mark every court holiday this year") — the quick
        // acknowledgment above is already spoken; the rest continues as a
        // background step queued right behind whatever comes next, so it
        // doesn't block a new question and doesn't race the messages array.
        startTask(ctx.userId, userText);
        queue.push({ type: "continue", delegationId, step: 1 });
        void drainQueue();
      }
    } catch (err: any) {
      console.error(`[live] delegation ${delegationId} failed:`, err?.message ?? err);
      // CONFIRMED BY TESTING: without this, one failed turn (e.g. a tool
      // result that blew the context window) left its bad content sitting in
      // `messages` — every LATER turn in the same session then resent that
      // same poisoned history and failed identically, so a single "check my
      // email" could silently break the rest of the conversation with no way
      // to recover short of hanging up. Discard exactly what this turn added
      // and nothing more, so the next question starts from the last known-good
      // state instead of compounding the failure.
      messages = messages.slice(0, beforeTurn);
      say(delegationId, describeConversationError(err));
    }
  }

  /**
   * One round of an in-progress background task. Runs the SAME turn logic
   * again against the (already-valid, resumable) `messages` history left by
   * the previous step, with no live user waiting on it — no filler needed,
   * and nothing to roll back to if it fails (there's no "before this step"
   * state worth reverting to mid-task; a failure just ends the task).
   */
  async function continueBackgroundStep(delegationId: string, step: number) {
    try {
      const [composioTools, accountsByToolkit] = await Promise.all([
        getComposioTools(ctx.userId),
        getAccountsByToolkit(ctx.userId),
      ]);
      const tools = [...staticTools, ...composioTools];

      const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
        messages,
        tools,
        userId: ctx.userId,
        timezone: ctx.timezone,
        accountsByToolkit,
        onSlowTool: async () => {}, // no one's actively waiting on this step — nothing to acknowledge out loud
      });
      messages = updated;

      if (needsMoreWork && step < MAX_BACKGROUND_STEPS) {
        queue.push({ type: "continue", delegationId, step: step + 1 });
        void drainQueue();
        return;
      }

      const report = needsMoreWork
        ? `I got through as much as I could, but couldn't finish everything: ${finalText}`
        : finalText;
      finishTask(ctx.userId, report);
      say(delegationId, report);
      console.log(`[live] background task for delegation ${delegationId} finished after ${step} step(s)`);
    } catch (err: any) {
      console.error(`[live] background task for delegation ${delegationId} failed at step ${step}:`, err?.message ?? err);
      const description = describeConversationError(err, "Sorry, I ran into a problem partway through that — some of it may not have gotten done.");
      finishTask(ctx.userId, description);
      say(delegationId, description);
    }
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.type === "user") await handleDelegation(item.delegationId, item.text);
      else await continueBackgroundStep(item.delegationId, item.step);
    }
    draining = false;
  }

  ws.on("open", () => {
    console.log(`[live] sideband attached → session ${sessionId}`);
  });

  ws.on("message", (raw) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.started":
        console.log(`[live] session ${sessionId} ready (client delegation)`);
        break;

      // GPT-Live streams what it heard as it hears it; a delegation doesn't
      // carry the request text itself (just an id), so we accumulate it here
      // and consume the buffer the moment a delegation actually arrives.
      case "session.input_transcript.delta":
        pendingUserText += event.delta ?? "";
        break;

      case "session.delegation.created": {
        const delegationId = event.delegation?.id;
        const userText = pendingUserText.trim();
        pendingUserText = "";
        if (!delegationId) break;

        if (!userText) {
          say(delegationId, "Sorry, I didn't catch that — could you say it again?");
          break;
        }

        queue.push({ type: "user", delegationId, text: userText });
        void drainQueue();
        break;
      }

      case "session.closed":
        console.log(`[live] session ${sessionId} closed — usage:`, event.usage ?? "(none reported)");
        closed = true;
        ws.close();
        break;

      case "error":
        console.error(`[live] session ${sessionId} reported an error:`, event.error ?? event);
        break;

      default:
        break; // session.instructions.appended, session.commentary.appended, etc. — nothing to do
    }
  });

  ws.on("close", () => {
    if (!closed) console.log(`[live] sideband for session ${sessionId} disconnected unexpectedly`);
  });

  ws.on("error", (err) => {
    console.error(`[live] sideband socket error for session ${sessionId}:`, err.message);
  });
}
