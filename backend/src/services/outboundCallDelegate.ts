import type { WebSocket } from "ws";
import { getOutboundCall, runOutboundTurn, finishOutboundCall } from "./outboundCall.js";

/** Speaks `text` on the call — ConversationRelay converts this to speech itself. */
function say(ws: WebSocket, text: string, last = true) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "text", token: text, last }));
}

/**
 * Ends the ConversationRelay session, which triggers Twilio to call the
 * <Connect> action webhook (routes/voiceCall.ts's /outbound-action) — that's
 * what actually hangs up the call. Confirmed via Twilio's own docs: sending
 * `end` doesn't hang up directly, it hands control back to TwiML at the
 * action URL, which is why that route just returns <Hangup/> unconditionally.
 */
function hangUp(ws: WebSocket, outcome: string) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason: "objective-complete", outcome }) }));
}

/**
 * Attaches the goal-driven outbound-call brain (services/outboundCall.ts) to
 * one live call's ConversationRelay websocket. Mirrors voiceCallDelegate.ts's
 * shape (same message types, same "someone else owns the audio" model) but
 * the conversation itself has a completely different purpose: Nova is the one
 * who called, working toward one objective, not answering whatever a
 * household member happens to ask.
 */
export function attachOutboundCallDelegate(ws: WebSocket, callId: string) {
  const call = getOutboundCall(callId);
  if (!call) {
    console.warn(`[outbound-call] no pending call for id ${callId} — closing`);
    ws.close();
    return;
  }

  let ended = false;

  ws.on("message", (raw) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "setup":
        call.status = "active";
        console.log(`[outbound-call] call ${call.id} to ${call.toNumber} connected`);
        break;

      // Same "only act once the whole utterance is transcribed" rule as
      // voiceCallDelegate.ts's identical case.
      case "prompt": {
        if (!event.last || ended) break;
        const text = String(event.voicePrompt ?? "").trim();
        if (!text) break;
        void (async () => {
          try {
            const { reply, done } = await runOutboundTurn(call, text);
            say(ws, reply);
            if (done) {
              ended = true;
              hangUp(ws, call.outcome ?? reply);
            }
          } catch (err: any) {
            console.error(`[outbound-call] turn for call ${call.id} failed:`, err?.message ?? err);
            ended = true;
            finishOutboundCall(call.id, `Called ${call.toNumber}, but ran into a problem partway through and couldn't finish.`, "failed");
            say(ws, "Sorry, I'm having trouble on my end — I'll try again later. Goodbye.");
            hangUp(ws, "error");
          }
        })();
        break;
      }

      case "interrupt":
        // The person started talking over Nova — Twilio already stopped
        // playback. A turn always sends one complete reply, never a stream,
        // so there's nothing in flight to cancel here.
        break;

      case "error":
        console.error(`[outbound-call] ConversationRelay reported an error on call ${call.id}:`, event.description ?? event);
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log(`[outbound-call] call ${call.id} to ${call.toNumber} ended`);
    // Hung up (either side) before finish_call was ever reached — still
    // worth telling the user SOMETHING rather than leaving them wondering
    // what happened to a call they don't even know finished.
    if (!ended && call.status !== "completed" && call.status !== "failed") {
      const reason = call.messages.length === 0 ? "no one said anything" : "it got cut off partway through";
      finishOutboundCall(call.id, `Called ${call.toNumber}, but the call ended before I could finish — ${reason}.`, "failed");
    }
  });

  ws.on("error", (err) => {
    console.error(`[outbound-call] websocket error on call ${call.id}:`, err.message);
  });
}
