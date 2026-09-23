import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * Sends a text via Twilio's REST API. Used for the real reply to an inbound
 * text — the webhook itself already replied instantly with empty TwiML (see
 * routes/sms.ts) so Twilio never waits on a slow brain/Composio turn — and
 * for background-task completions reaching a user well after their original
 * text.
 */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    console.warn(`[sms] Twilio isn't configured — would have sent to ${to}: ${body}`);
    return;
  }
  const params = new URLSearchParams({ To: to, From: env.TWILIO_PHONE_NUMBER, Body: body });
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

  const resp = await fetch(`${TWILIO_API_BASE}/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Twilio send failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
}

/**
 * Validates the `X-Twilio-Signature` header per Twilio's documented request
 * validation algorithm: base64(HMAC-SHA1(authToken, url + every POST param's
 * "key"+"value" concatenated in sorted-by-key order)). `url` must be the
 * EXACT url Twilio requested — see PUBLIC_BASE_URL in config.ts for why that
 * comes from an env var instead of request headers, which a proxy or a
 * forged request could alter. Without this check, anyone who found the
 * webhook URL could POST a fake `From` number and act as any user — the same
 * class of hole real accounts closed for the web app (see routes/auth.ts).
 * Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(url: string, params: Record<string, unknown>, signature: string | undefined): boolean {
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key]), url);
  const expected = createHmac("sha1", env.TWILIO_AUTH_TOKEN).update(data, "utf8").digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Constant-time comparison — this is a security check, not just equality.
  return a.length === b.length && timingSafeEqual(a, b);
}
