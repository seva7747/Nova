import WebSocket from "ws";
import { env } from "../config.js";
import { runConversationTurn, describeConversationError } from "./llm.js";
import { getComposioTools, getAccountsByToolkit } from "./composio.js";
import {
  startTask,
  finishTask,
  recordProgress,
  actionsSince,
  takeUnannounced,
  restoreUnannounced,
  type Task,
} from "./tasks.js";
import { staticTools } from "../tools/index.js";
import { countWrites, VERIFY_AFTER_WRITES, VERIFY_NOTE, MAX_VERIFY_PASSES } from "./verify.js";

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
 * Claude + web search + make_phone_call + Composio's Gmail/Calendar
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
  let spokenText = "";
  const flushSpoken = () => {
    if (spokenText.trim()) console.log(`[live] session ${sessionId} Nova said → "${spokenText.trim()}"`);
    spokenText = "";
  };
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

  // Every user request goes through this ONE queue, processed strictly one at
  // a time. CONFIRMED BY TESTING (the earlier tool-result-size and
  // orphaned-tool_use bugs): concurrent access to the shared `messages` array
  // is exactly the kind of thing that silently corrupts a whole session.
  // Background tasks don't use this queue — each one runs on its own forked
  // copy of the history (see runBackgroundTask), so they never block a new
  // question and never touch `messages`.
  type QueueItem = { delegationId: string; text: string };
  const queue: QueueItem[] = [];
  let draining = false;

  /**
   * What to call a task. CONFIRMED BY TESTING: a task started from a
   * confirmation ("Nova: delete all 80? — User: Yeah") was named just "Yeah",
   * which is useless both in check_background_tasks and in the by-the-way.
   * Short replies borrow the user's previous request for context.
   */
  function describeRequest(userText: string, beforeTurn: number): string {
    if (userText.trim().split(/\s+/).length >= 4) return userText;
    for (let i = beforeTurn - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "user" && typeof m.content === "string") {
        return `${m.content.split("\n\n[System")[0]} (then: "${userText}")`;
      }
    }
    return userText;
  }

  async function handleDelegation(delegationId: string, userText: string) {
    const turnStart = Date.now();
    console.log(`[live] delegation ${delegationId} → "${userText}"`);
    // Snapshotted so a failed turn can be rolled back below — runConversationTurn
    // mutates `messages` in place as it goes (assistant turn, tool results, ...),
    // so by the time it throws, the bad content is already sitting in the array
    // whether or not `messages = updated` below ever runs.
    const beforeTurn = messages.length;

    // A background task that finished since the last question gets mentioned
    // the moment the user says anything at all — leading with it, not
    // buried as an afterthought — since reconnecting to Nova after a task
    // was running is usually exactly to find out whether it's done.
    const finished = takeUnannounced(ctx.userId);
    let content = userText;
    if (finished.length > 0) {
      const summary = finished.map((t) => `"${t.description}" → ${t.result}`).join(" / ");
      content += `\n\n[System note, not said by the user: a background task you were running just finished: ${summary}. Start your reply with a short, clear "Done — " statement of the outcome, before anything else — this is likely why they're checking in. THEN answer whatever they said above, if it was a real question.]`;
      console.log(`[live] delegation ${delegationId} will lead with ${finished.length} finished task(s)`);
    }
    messages.push({ role: "user", content });

    try {
      console.log(`[live] delegation ${delegationId} checkpoint: fetching tools...`);
      const [composioTools, accountsByToolkit] = await Promise.all([
        getComposioTools(ctx.userId),
        getAccountsByToolkit(ctx.userId),
      ]);
      const tools = [...staticTools, ...composioTools];
      console.log(`[live] delegation ${delegationId} checkpoint: got ${tools.length} tools, calling runConversationTurn...`);

      const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
        messages,
        tools,
        userId: ctx.userId,
        timezone: ctx.timezone,
        accountsByToolkit,
        // No "let me check your Gmail..." filler — GPT-Live already said one
        // request-specific acknowledgment the moment it delegated (see
        // LIVE_INSTRUCTIONS in routes/live.ts); a second one sounds broken.
        onSlowTool: async () => {},
      });
      console.log(`[live] delegation ${delegationId} checkpoint: runConversationTurn returned`);

      messages = updated;
      say(delegationId, finalText);
      console.log(`[live] delegation ${delegationId} answered in ${Date.now() - turnStart}ms → "${finalText}"`);
      // Read before the handoff rewrite below changes the paused results.
      const turnActions = actionsSince(messages, beforeTurn);

      if (needsMoreWork) {
        // A big job (e.g. "mark every court holiday this year"): "this is a
        // bigger job..." is already spoken. The rest runs on its own copy of
        // the history, in parallel, so the user can keep asking other things
        // (including about this task) while it works.
        const taskMessages = structuredClone(messages);
        // The main conversation's copy of the paused tool calls now says
        // they were handed off — otherwise the next question's turn would see
        // "Paused here — will resume" and helpfully redo them itself.
        const last = messages[messages.length - 1];
        if (Array.isArray(last?.content)) {
          last.content = last.content.map((b: any) =>
            b?.type === "tool_result"
              ? { ...b, content: JSON.stringify({ note: "Handed off to a background task that's running separately — don't redo these; use check_background_tasks for its progress." }) }
              : b
          );
        }
        const task = startTask(ctx.userId, describeRequest(userText, beforeTurn));
        recordProgress(task, turnActions);
        void runBackgroundTask(task, taskMessages, "work");
      } else if (countWrites(turnActions) >= VERIFY_AFTER_WRITES) {
        // Finished within one turn but changed several things — double-check
        // it in the background, after the answer's already been spoken, so
        // it costs the user no wait (see services/verify.ts).
        const task = startTask(ctx.userId, `Double-checking: ${describeRequest(userText, beforeTurn)}`);
        void runBackgroundTask(task, structuredClone(messages), "verify");
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
      restoreUnannounced(finished); // the by-the-way never got said — keep it for next time
      say(delegationId, describeConversationError(err));
    }
  }

  /**
   * Drives a background task on its own forked history, fully in parallel
   * with the live conversation, then proves the result before calling it
   * done (see services/verify.ts):
   *   "work"   — continue a big job step by step, then verify it if it
   *              changed anything.
   *   "verify" — the job already finished in a normal turn; only verify.
   *              If that finds nothing to fix it finishes silently (no
   *              by-the-way) — the user already heard it was done.
   * Cancel is honored between steps AND between tool rounds inside a step
   * (shouldStop). Deliberately doesn't speak when it finishes — the result
   * waits for the user's next question as a "by the way", and the frontend
   * turns the task light green meanwhile. Keeps going if the session hangs up.
   */
  async function runBackgroundTask(task: Task, taskMessages: any[], mode: "work" | "verify") {
    console.log(`[live] background task ${task.id} (${mode}) started → "${task.description}"`);
    let step = 0;

    const cancelled = () => {
      if (!task.cancelRequested) return false;
      finishTask(task, "cancelled", `Cancelled after ${task.actions.length} action(s).`, true);
      console.log(`[live] background task ${task.id} cancelled after ${task.actions.length} action(s)`);
      return true;
    };

    /** Runs turns until one finishes (or the step budget runs out). Returns null if cancelled. */
    const runUntilDone = async (maxSteps: number) => {
      for (let i = 0; i < maxSteps; i++) {
        if (cancelled()) return null;
        step++;
        const [composioTools, accountsByToolkit] = await Promise.all([
          getComposioTools(ctx.userId),
          getAccountsByToolkit(ctx.userId),
        ]);
        const before = taskMessages.length;
        const { finalText, messages: updated, needsMoreWork } = await runConversationTurn({
          messages: taskMessages,
          tools: [...staticTools, ...composioTools],
          userId: ctx.userId,
          timezone: ctx.timezone,
          accountsByToolkit,
          onSlowTool: async () => {}, // no one's waiting on this — nothing to say out loud
          shouldStop: () => task.cancelRequested,
        });
        taskMessages = updated;
        recordProgress(task, actionsSince(taskMessages, Math.min(before, taskMessages.length)));
        if (!needsMoreWork) return { finalText, finished: true };
        if (i === maxSteps - 1) return { finalText, finished: false };
      }
      return { finalText: "", finished: false };
    };

    try {
      let report = "";
      if (mode === "work") {
        const result = await runUntilDone(MAX_BACKGROUND_STEPS);
        if (!result) return;
        if (!result.finished) {
          finishTask(task, "done", `I got through as much as I could, but couldn't finish everything: ${result.finalText}`);
          console.log(`[live] background task ${task.id} hit the step cap after ${task.actions.length} action(s)`);
          return;
        }
        report = result.finalText;
      }

      let totalFixes = 0;
      if (mode === "verify" || countWrites(task.actions) > 0) {
        for (let pass = 1; pass <= MAX_VERIFY_PASSES; pass++) {
          taskMessages.push({ role: "user", content: VERIFY_NOTE });
          const actionsBefore = task.actions.length;
          const result = await runUntilDone(4);
          if (!result) return;
          report = result.finalText || report;
          const fixes = countWrites(task.actions.slice(actionsBefore));
          totalFixes += fixes;
          console.log(`[live] background task ${task.id} verify pass ${pass}: ${fixes} fix(es) → "${result.finalText}"`);
          if (fixes === 0 && result.finished) break;
        }
      }

      // A verify-only check that found nothing wrong has nothing new to tell
      // the user — mark it announced so it doesn't turn into a by-the-way.
      const silent = mode === "verify" && totalFixes === 0;
      finishTask(task, "done", report, silent);
      console.log(
        `[live] background task ${task.id} finished after ${step} step(s), ${task.actions.length} action(s), ${totalFixes} fix(es) from verification${silent ? " (verified clean, not announcing)" : ""} → "${report}"`
      );
    } catch (err: any) {
      console.error(`[live] background task ${task.id} failed at step ${step}:`, err?.message ?? err);
      finishTask(
        task,
        "failed",
        describeConversationError(err, `I ran into a problem partway through — ${task.actions.length} action(s) got done before it stopped.`)
      );
    }
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const item = queue.shift()!;
      await handleDelegation(item.delegationId, item.text);
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

    if (process.env.LIVE_DEBUG && !String(event.type).endsWith(".delta")) {
      console.log(`[live-debug] ${JSON.stringify(event).slice(0, 400)}`);
    }
    switch (event.type) {
      case "session.started":
        console.log(`[live] session ${sessionId} ready (client delegation)`);
        break;

      // GPT-Live streams what it heard as it hears it; a delegation doesn't
      // carry the request text itself (just an id), so we accumulate it here
      // and consume the buffer the moment a delegation actually arrives.
      case "session.input_transcript.delta":
        flushSpoken();
        pendingUserText += event.delta ?? "";
        break;

      // What Nova actually says out loud, logged so double acknowledgments
      // and other voice-layer behavior show up in the backend logs instead
      // of only being audible in the browser.
      case "session.output_transcript.delta":
        spokenText += event.delta ?? "";
        break;

      case "session.delegation.created": {
        flushSpoken();
        const delegationId = event.delegation?.id;
        const userText = pendingUserText.trim();
        pendingUserText = "";
        if (!delegationId) break;

        if (!userText) {
          say(delegationId, "Sorry, I didn't catch that — could you say it again?");
          break;
        }

        queue.push({ delegationId, text: userText });
        void drainQueue();
        break;
      }

      case "session.closed":
        flushSpoken();
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
