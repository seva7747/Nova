import { callRestaurant, restaurantTool } from "./restaurant.js";
import { gmailSearchTool, runGmailSearch } from "./gmailSearch.js";
import { addCalendarEventTool, runAddCalendarEvent } from "./calendarEvent.js";
import { executeComposioTool } from "../services/composio.js";

// NOTE: there is currently NO web/live-info search tool. Anthropic (built-in
// web_search) and Groq (built-in browser_search, on gpt-oss models) both
// offered a server-side search tool that could sit in the `tools` array next
// to real function tools — CONFIRMED (via Google's own docs) Gemini's
// OpenAI-compatible endpoint has no equivalent: Google Search grounding is
// only exposed through Gemini's native API, not through this compatibility
// layer, and not alongside custom function-calling at all. So weather,
// sports scores, news, prices, "who won last night" — anything STATIC_
// INSTRUCTIONS in llm.ts calls out as needing a search — currently has no
// tool to actually do it; Nova will either answer from stale training data
// or (per those same instructions) decline rather than guess. Restoring this
// needs a real search API (e.g. Tavily, Brave Search, Bing) wired in as its
// own custom tool, the same pattern as call_restaurant/search_gmail below —
// not done yet, since that needs its own API key this project doesn't have.

// search_gmail replaces direct access to Composio's GMAIL_FETCH_EMAILS
// entirely (see gmailSearch.ts's comment for why) — it isn't a Composio
// toolkit tool, so it's listed here as a static tool the same way
// call_restaurant is, and composio.ts's CURATED_TOOLS.GMAIL no longer
// includes GMAIL_FETCH_EMAILS.
export const staticTools = [restaurantTool, gmailSearchTool, addCalendarEventTool];

/** Tool names/prefixes that represent a "real world" action worth talking over. */
const SLOW_STATIC_TOOLS = new Set(["call_restaurant", "search_gmail", "add_calendar_event"]);
const SLOW_TOOLKIT_PREFIXES = [
  "GMAIL",
  "GOOGLECALENDAR",
  "GOOGLE_CALENDAR",
  "GOOGLEDRIVE",
  "SLACK",
  "NOTION",
  "TODOIST",
  "WHATSAPP",
  "SPOTIFY",
  "CANVAS",
];

export function isSlowTool(name: string): boolean {
  if (SLOW_STATIC_TOOLS.has(name)) return true;
  const upper = name.toUpperCase();
  return SLOW_TOOLKIT_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Builds the short "give me a minute" line Nova says before running a slow tool. */
export function buildFillerText(block: { name: string; input: any }): string {
  const upper = block.name.toUpperCase();

  if (upper === "SEARCH_GMAIL" || upper.startsWith("GMAIL")) return "Give me a moment, let me check your Gmail...";
  if (upper === "ADD_CALENDAR_EVENT" || upper.startsWith("GOOGLECALENDAR") || upper.startsWith("GOOGLE_CALENDAR")) {
    return "One second, let me get that on your calendar...";
  }
  if (upper.startsWith("GOOGLEDRIVE")) return "One second, let me check your Drive...";
  if (upper.startsWith("SLACK")) return "One moment, let me check Slack...";
  if (upper.startsWith("NOTION")) return "Give me a second, let me check Notion...";
  if (upper.startsWith("TODOIST")) return "One second, let me check your tasks...";
  if (upper.startsWith("WHATSAPP")) return "One moment, let me check WhatsApp...";
  if (upper.startsWith("SPOTIFY")) return "One second, let me get that going on Spotify...";
  if (upper.startsWith("CANVAS")) return "One second, let me check Canvas...";
  if (upper === "CALL_RESTAURANT") {
    const name = block.input?.restaurantName;
    return name ? `Give me a minute, let me call up ${name} for you...` : "Give me a minute, let me make that call...";
  }
  return "Give me a moment, I'm on it...";
}

export async function executeTool(name: string, input: any, ctx: { userId: string; timezone?: string }) {
  switch (name) {
    case "call_restaurant":
      return callRestaurant(input);
    case "search_gmail":
      return runGmailSearch(input, ctx);
    case "add_calendar_event":
      return runAddCalendarEvent(input, ctx);
    default:
      // Anything not defined above is assumed to be a Composio-provided tool
      // (e.g. GMAIL_SEND_EMAIL, GOOGLECALENDAR_CREATE_EVENT). web_search never
      // lands here — Anthropic resolves it server-side before we see a response.
      return executeComposioTool(ctx.userId, name, input);
  }
}
