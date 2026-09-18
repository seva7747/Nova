import "dotenv/config";

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function warnIfMissing(name: string, value: string, feature: string) {
  if (!value) {
    console.warn(`[config] ${name} is not set — ${feature} will not work until you add it to backend/.env`);
  }
}

const ANTHROPIC_API_KEY = optional("ANTHROPIC_API_KEY");
const COMPOSIO_API_KEY = optional("COMPOSIO_API_KEY");
const OPENAI_API_KEY = optional("OPENAI_API_KEY");
const TWILIO_ACCOUNT_SID = optional("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = optional("TWILIO_AUTH_TOKEN");
const TWILIO_PHONE_NUMBER = optional("TWILIO_PHONE_NUMBER");
const PUBLIC_BASE_URL = optional("PUBLIC_BASE_URL");

warnIfMissing("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY, "Nova's reasoning/brain, and web search (weather, sports, news, ...)");
warnIfMissing("COMPOSIO_API_KEY", COMPOSIO_API_KEY, "Gmail / Google Calendar / other integrations");
warnIfMissing("OPENAI_API_KEY", OPENAI_API_KEY, "Nova's voice (GPT-Live-1) — nothing will listen or speak without this");
warnIfMissing("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID, "texting Nova (SMS) — every user's own agent-you-can-text number");
warnIfMissing("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN, "texting Nova (SMS) — also needed to verify inbound webhook calls are really from Twilio");
warnIfMissing("TWILIO_PHONE_NUMBER", TWILIO_PHONE_NUMBER, "texting Nova (SMS) — the number Nova texts FROM, in E.164 form (e.g. +15551234567)");
warnIfMissing("PUBLIC_BASE_URL", PUBLIC_BASE_URL, "texting Nova (SMS) — the public URL Twilio's webhook reaches this server at (ngrok URL in dev)");

export const env = {
  PORT: Number(optional("PORT", "8787")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:5173"),

  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: optional("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
  // History: briefly swapped to Groq (free tier hard-caps at 8,000
  // tokens/minute — Nova's own tool schemas alone need ~21k, so every
  // request failed outright) then Gemini (works, but its OpenAI-compatible
  // endpoint has no built-in search tool at all, so weather/sports/news
  // stopped working). Reverted back to Anthropic once credits were topped
  // up — see llm.ts/composio.ts/tools/index.ts for the corresponding reverts.

  // Note: there's no COMPOSIO_TOOLKITS allowlist anymore — which services
  // Claude can use is now driven entirely by which ones the user has
  // actually connected (see composio.ts's getComposioTools), so connecting
  // any of Composio's ~1,500 toolkits through the Connectors page's catalog
  // search works immediately, with no backend config change needed.
  COMPOSIO_API_KEY,

  OPENAI_API_KEY,
  // gpt-live-1: OpenAI's full-duplex voice model — Nova's ears and mouth.
  // It runs in "client delegation" mode (see services/liveDelegate.ts),
  // meaning it hands the user's words to OUR backend and just speaks back
  // whatever runConversationTurn returns. It does NOT replace Claude or
  // Composio — Nova's brain and tools are unchanged from day one.
  OPENAI_LIVE_MODEL: optional("OPENAI_LIVE_MODEL", "gpt-live-1"),

  TIMEZONE: optional("TIMEZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone,

  // Twilio: gives every Nova account a phone number they can text (and,
  // later, call) — see services/sms.ts and routes/sms.ts. Chosen over
  // Inkbox specifically for this: same "identity layer for agents" idea,
  // but Twilio is the established, cheaper, purpose-built platform for it.
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  // Must be the exact public URL Twilio's webhook reaches this server at
  // (an ngrok URL in dev, the real domain in production) — used to
  // reconstruct the webhook URL for signature verification, since trusting
  // req headers for that would let a reverse proxy or forged header spoof it.
  PUBLIC_BASE_URL,
};
