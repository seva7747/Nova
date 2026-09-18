import { callRestaurant, restaurantTool } from "./restaurant.js";
import { gmailSearchTool, runGmailSearch } from "./gmailSearch.js";
import { addCalendarEventTool, runAddCalendarEvent } from "./calendarEvent.js";
import { executeComposioTool } from "../services/composio.js";

/**
 * Anthropic's built-in web search tool. Unlike the tools below, this one runs
 * entirely on Anthropic's servers — Claude decides to search, the API
 * fetches real results, and Claude answers with them, all inside a single
 * API call. We never see a "tool_use" block for it and never execute
 * anything ourselves; it just needs to be listed here. This is what answers
 * weather, sports scores/schedules, news, prices — anything that changes
 * over time and can't come from the model's training data alone.
 * Docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3, // caps cost/latency per turn — most questions need 1 search
};

// search_gmail replaces direct access to Composio's GMAIL_FETCH_EMAILS
// entirely (see gmailSearch.ts's comment for why) — it isn't a Composio
// toolkit tool, so it's listed here as a static tool the same way
// call_restaurant is, and composio.ts's CURATED_TOOLS.GMAIL no longer
// includes GMAIL_FETCH_EMAILS.
export const staticTools = [webSearchTool, restaurantTool, gmailSearchTool, addCalendarEventTool];

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
