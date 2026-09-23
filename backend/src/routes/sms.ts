import { Router } from "express";
import { env } from "../config.js";
import { verifyTwilioSignature } from "../services/sms.js";
import { handleIncomingSms } from "../services/smsDelegate.js";
import { normalizePhoneNumber } from "../services/auth.js";

const router = Router();

/**
 * Twilio's inbound-SMS webhook — configure this as the "A message comes in"
 * webhook URL on the Twilio number, as `{PUBLIC_BASE_URL}/api/sms/webhook`.
 *
 * Always replies with empty TwiML immediately, before the real brain +
 * Composio turn even starts — Twilio times out a webhook after ~15s, and a
 * multi-tool turn can easily take longer (see smsDelegate.ts's own timing
 * logs). The actual answer is sent afterward as a normal outbound text via
 * the REST API (sendSms), same "ack fast, answer later" shape as the live
 * voice pipeline's delegation queue.
 */
router.post("/webhook", (req, res) => {
  const signature = req.header("X-Twilio-Signature");
  const url = `${env.PUBLIC_BASE_URL}/api/sms/webhook`;
  if (!env.PUBLIC_BASE_URL || !verifyTwilioSignature(url, req.body ?? {}, signature)) {
    console.warn("[sms] rejected a webhook call with an invalid or unverifiable Twilio signature");
    return res.status(403).send("Forbidden");
  }

  const from = normalizePhoneNumber(String(req.body?.From ?? ""));
  const body = String(req.body?.Body ?? "").trim();

  res.set("Content-Type", "text/xml").send("<Response></Response>");

  if (from && body) handleIncomingSms(from, body);
});

export default router;
