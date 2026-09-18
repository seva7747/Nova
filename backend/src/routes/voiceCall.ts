import { Router } from "express";
import { env } from "../config.js";
import { verifyTwilioSignature } from "../services/sms.js";

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

export default router;
