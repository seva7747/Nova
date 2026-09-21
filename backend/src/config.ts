import "dotenv/config";

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function warnIfMissing(name: string, value: string, feature: string) {
  if (!value) {
    console.warn(`[config] ${name} is not set — ${feature} will not work until you add it to backend/.env`);
  }
}

const COMPOSIO_API_KEY = optional("COMPOSIO_API_KEY");
const OPENAI_API_KEY = optional("OPENAI_API_KEY");
const TWILIO_ACCOUNT_SID = optional("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = optional("TWILIO_AUTH_TOKEN");
const TWILIO_PHONE_NUMBER = optional("TWILIO_PHONE_NUMBER");
const PUBLIC_BASE_URL = optional("PUBLIC_BASE_URL");

warnIfMissing(
  "OPENAI_API_KEY",
  OPENAI_API_KEY,
  "Nova's reasoning/brain (gpt-4.1-mini), her voice (GPT-Live-1), AND web search (weather, sports, news, ...) — one key now covers all three"
);
warnIfMissing("COMPOSIO_API_KEY", COMPOSIO_API_KEY, "Gmail / Google Calendar / other integrations");
warnIfMissing("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID, "texting Nova (SMS) — every user's own agent-you-can-text number");
warnIfMissing("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN, "texting Nova (SMS) — also needed to verify inbound webhook calls are really from Twilio");
warnIfMissing("TWILIO_PHONE_NUMBER", TWILIO_PHONE_NUMBER, "texting Nova (SMS) — the number Nova texts FROM, in E.164 form (e.g. +15551234567)");
warnIfMissing("PUBLIC_BASE_URL", PUBLIC_BASE_URL, "texting Nova (SMS) — the public URL Twilio's webhook reaches this server at (ngrok URL in dev)");

export const env = {
  PORT: Number(optional("PORT", "8787")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:5173"),

  // Note: there's no COMPOSIO_TOOLKITS allowlist anymore — which services
  // Nova can use is now driven entirely by which ones the user has actually
  // connected (see composio.ts's getComposioTools), so connecting any of
  // Composio's ~1,500 toolkits through the Connectors page's catalog search
  // works immediately, with no backend config change needed.
  COMPOSIO_API_KEY,

  OPENAI_API_KEY,
  // gpt-live-1: OpenAI's full-duplex voice model — Nova's ears and mouth. It
  // runs in "client delegation" mode (see services/liveDelegate.ts), meaning
  // it hands the user's words to OUR backend and just speaks back whatever
  // runConversationTurn returns.
  OPENAI_LIVE_MODEL: optional("OPENAI_LIVE_MODEL", "gpt-live-1"),
  // Nova's actual reasoning/tool-calling brain (llm.ts, outboundCall.ts) —
  // was Claude Haiku 4.5 ($1/$5 per 1M in/out tokens) until this swap.
  // CONFIRMED BY RESEARCH: gpt-4o-mini (the obvious cheap pick) is a dead
  // end — its search-capable variant was deprecated and shut down
  // 2026-07-23, and plain gpt-4o-mini has no path to OpenAI's built-in
  // web_search tool in the Responses API at all, which would silently break
  // weather/sports/news the exact same way the earlier Gemini attempt did.
  // gpt-4.1-mini is the one that's both current (Responses API web_search
  // works with it) and still meaningfully cheaper than Haiku ($0.40/$1.60
  // per 1M in/out — roughly 2.5-3x less, not the ~7x gpt-4o-mini would have
  // been, but real, and without losing anything).
  OPENAI_REASONING_MODEL: optional("OPENAI_REASONING_MODEL", "gpt-4.1-mini"),

  TIMEZONE: optional("TIMEZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone,

  // Twilio: gives every Nova account a phone number they can text and call —
  // see services/sms.ts, routes/sms.ts, services/outboundCall.ts. Chosen
  // over Inkbox specifically for this: same "identity layer for agents"
  // idea, but Twilio is the established, cheaper, purpose-built platform.
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  // Must be the exact public URL Twilio's webhook reaches this server at
  // (an ngrok URL in dev, the real domain in production) — used to
  // reconstruct the webhook URL for signature verification, since trusting
  // req headers for that would let a reverse proxy or forged header spoof it.
  PUBLIC_BASE_URL,
};
