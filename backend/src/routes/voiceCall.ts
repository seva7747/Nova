import { Router } from "express";
import { env } from "../config.js";
import { verifyTwilioSignature } from "../services/sms.js";
import { getOutboundCall, finishOutboundCall } from "../services/outboundCall.js";

const router = Router();

/**
 * Escapes text dropped into TwiML XML — only ever the welcome greeting here,
 * but worth doing properly since it's still user-adjacent content.
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Twilio's inbound-VOICE webhook — configure this as the "A call comes in"
 * webhook URL on the Twilio number, as `{PUBLIC_BASE_URL}/api/voice-call/incoming`.
 *
 * Returns TwiML connecting the call to ConversationRelay — Twilio's own
 * speech-to-text/text-to-speech bridge (verified against their docs: it
 * transcribes the caller's speech, sends us plain text over a WebSocket, and
 * synthesizes whatever text we send back). That WebSocket is where the real
 * conversation with Nova's brain happens — see services/voiceCallDelegate.ts
 * and the WS server wired up alongside this router in index.ts. Same
 * "someone else owns the audio, we only exchange text" shape as GPT-Live-1's
 * client delegation and the SMS pipeline, just a third transport for the
 * identical Claude+Composio brain underneath.
 *
 * SECURITY NOTE: this HTTP webhook is signature-verified the same way the
 * SMS one is. The WebSocket it hands off to is a different story — Twilio's
 * docs don't document any signature on the WS upgrade itself, so a shared
 * secret (TWILIO_AUTH_TOKEN, already secret, already known only to us and
 * Twilio's dashboard) is embedded in the URL and re-checked when the socket
 * connects (see index.ts) — not cryptographic, but the URL is never
 * published anywhere except inside this signature-verified response, so in
 * practice only Twilio ever sees it.
 */
router.post("/incoming", (req, res) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${env.PUBLIC_BASE_URL}/api/voice-call/incoming`;
  if (!env.PUBLIC_BASE_URL || !verifyTwilioSignature(url, req.body ?? {}, signature)) {
    console.warn("[voice-call] rejected a webhook call with an invalid or unverifiable Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const wsUrl = `${env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/api/voice-call/stream?auth=${encodeURIComponent(env.TWILIO_AUTH_TOKEN)}`;
  const greeting = escapeXml("Hey, it's Nova. What can I help with?");

  res.set("Content-Type", "text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}" /></Connect></Response>`
  );
});

/**
 * Twilio hits this once an OUTBOUND call (see services/outboundCall.ts's
 * placeOutboundCall) actually gets answered. `callId` round-trips through the
 * query string since Twilio has no other way to tell us which pending call
 * this is for — its own callSid isn't known to us until the initial
 * Calls.json response, which is a separate round trip from this webhook.
 *
 * The signature check reconstructs the exact URL Twilio requested INCLUDING
 * the query string (`req.originalUrl`) — Twilio's signature covers the full
 * URL as requested, and this route (unlike /incoming) actually has one.
 */
router.post("/outbound-twiml", (req, res) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  if (!env.PUBLIC_BASE_URL || !verifyTwilioSignature(url, req.body ?? {}, signature)) {
    console.warn("[voice-call] rejected an outbound-twiml webhook with an invalid or unverifiable Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const callId = String(req.query.callId ?? "");
  const call = getOutboundCall(callId);
  if (!call) {
    console.warn(`[voice-call] outbound-twiml hit for unknown call ${callId} — hanging up`);
    return res.set("Content-Type", "text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  // CONFIRMED BY TESTING — real call failure: Twilio error 12100 "Document
  // parse failure." Both URLs below have TWO query params joined with a raw
  // "&", and inside an XML attribute value "&" must be escaped as "&amp;" —
  // /incoming never hit this because its single-param URL has no "&" at all.
  // Fixed by running every attribute value (not just the greeting) through
  // escapeXml before it goes in the TwiML.
  const wsUrl = escapeXml(
    `${env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/api/voice-call/outbound-stream?auth=${encodeURIComponent(
      env.TWILIO_AUTH_TOKEN
    )}&callId=${encodeURIComponent(callId)}`
  );
  const greeting = escapeXml(call.openingLine);
  // `action` is what makes the ConversationRelay session's "end" message
  // actually hang up the call — see outboundCallDelegate.ts's hangUp() and
  // the /outbound-action route below.
  const actionUrl = escapeXml(`${env.PUBLIC_BASE_URL}/api/voice-call/outbound-action?callId=${encodeURIComponent(callId)}`);

  res.set("Content-Type", "text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${actionUrl}"><ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}" /></Connect></Response>`
  );
});

/**
 * Twilio calls this once the outbound call's ConversationRelay session sends
 * an "end" message (see outboundCallDelegate.ts) — confirmed via Twilio's own
 * docs that "end" hands control back to TwiML here rather than hanging up
 * directly. The outcome itself was already recorded and scheduled to be
 * announced (finishOutboundCall, called from outboundCall.ts before this
 * webhook ever fires) — all that's left to do here is actually hang up.
 */
router.post("/outbound-action", (req, res) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  if (!env.PUBLIC_BASE_URL || !verifyTwilioSignature(url, req.body ?? {}, signature)) {
    console.warn("[voice-call] rejected an outbound-action webhook with an invalid or unverifiable Twilio signature");
    return res.status(403).send("Forbidden");
  }
  res.set("Content-Type", "text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
});

/**
 * Twilio's StatusCallback for an outbound call (see placeOutboundCall) — the
 * only way to learn a call never even connected (no-answer/busy/failed/
 * canceled), since ConversationRelay's websocket never opens for those.
 * finishOutboundCall is a no-op if the call already finished some other way
 * (e.g. it DID connect and finish_call already ran), so this can't double-
 * report the same call.
 */
router.post("/outbound-status", (req, res) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  if (!env.PUBLIC_BASE_URL || !verifyTwilioSignature(url, req.body ?? {}, signature)) {
    console.warn("[voice-call] rejected an outbound-status webhook with an invalid or unverifiable Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const callId = String(req.query.callId ?? "");
  const call = getOutboundCall(callId);
  const callStatus = String(req.body?.CallStatus ?? "");
  const neverConnected = ["no-answer", "busy", "failed", "canceled"];

  if (call && neverConnected.includes(callStatus)) {
    const reason =
      callStatus === "no-answer" ? "didn't answer" : callStatus === "busy" ? "the line was busy" : callStatus === "canceled" ? "the call got canceled" : "the call couldn't connect";
    finishOutboundCall(call.id, `Tried calling ${call.toNumber}, but ${reason} — wasn't able to get to it.`, "failed");
  }

  res.status(204).end();
});

export default router;
