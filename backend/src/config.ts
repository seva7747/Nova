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

warnIfMissing("COMPOSIO_API_KEY", COMPOSIO_API_KEY, "Gmail / Google Calendar / other integrations");
warnIfMissing("OPENAI_API_KEY", OPENAI_API_KEY, "Nova's voice (GPT-Live-1), her reasoning/brain, and web search (weather, sports, news, ...) — one key powers all three");
warnIfMissing("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID, "texting Nova (SMS) — every user's own agent-you-can-text number");
warnIfMissing("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN, "texting Nova (SMS) — also needed to verify inbound webhook calls are really from Twilio");
warnIfMissing("TWILIO_PHONE_NUMBER", TWILIO_PHONE_NUMBER, "texting Nova (SMS) — the number Nova texts FROM, in E.164 form (e.g. +15551234567)");
warnIfMissing("PUBLIC_BASE_URL", PUBLIC_BASE_URL, "texting Nova (SMS) — the public URL Twilio's webhook reaches this server at (ngrok URL in dev)");

export const env = {
  PORT: Number(optional("PORT", "8787")),
  CORS_ORIGIN: optional("CORS_ORIGIN", "http://localhost:5173"),

  // Note: there's no COMPOSIO_TOOLKITS allowlist anymore — which services
  // the model can use is now driven entirely by which ones the user has
  // actually connected (see composio.ts's getComposioTools), so connecting
  // any of Composio's ~1,500 toolkits through the Connectors page's catalog
  // search works immediately, with no backend config change needed.
  COMPOSIO_API_KEY,

  // One key now covers all three OpenAI surfaces Nova uses: the Live voice
  // model, the reasoning brain, and the brain's hosted web search.
  OPENAI_API_KEY,
  // gpt-live-1: OpenAI's full-duplex voice model — Nova's ears and mouth.
  // It runs in "client delegation" mode (see services/liveDelegate.ts),
  // meaning it hands the user's words to OUR backend and just speaks back
  // whatever runConversationTurn returns. It is a SEPARATE model from the
  // brain below and does none of the reasoning or tool-calling itself.
  OPENAI_LIVE_MODEL: optional("OPENAI_LIVE_MODEL", "gpt-live-1"),
  // Nova's brain — the model that actually reasons and calls tools, via the
  // Responses API (see services/llm.ts). Responses, not Chat Completions,
  // because it's the only OpenAI surface with a HOSTED web_search tool, and
  // weather/sports/news all depend on that running server-side.
  //
  // History: started on Anthropic (Claude Haiku 4.5), briefly swapped to
  // Groq (free tier hard-caps at 8,000 tokens/minute — Nova's own tool
  // schemas alone need ~21k, so every request failed outright) then Gemini
  // (works, but its OpenAI-compatible endpoint has no built-in search tool
  // at all, so weather/sports/news stopped working). Now on OpenAI, which
  // has both the search tool and the same key as the voice layer.
  OPENAI_BRAIN_MODEL: optional("OPENAI_BRAIN_MODEL", "gpt-5.4-mini"),
  // How hard the brain thinks before answering. gpt-5.x models spend output
  // tokens on reasoning BEFORE emitting a tool call, and this is a live
  // voice loop where every extra second is audible — "low" keeps Nova
  // responsive. Raise to "medium" if multi-step tool requests get sloppy.
  OPENAI_REASONING_EFFORT: optional("OPENAI_REASONING_EFFORT", "low"),

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
