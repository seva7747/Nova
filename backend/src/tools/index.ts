import { makePhoneCallTool, runMakePhoneCall } from "./phoneCall.js";
import { gmailSearchTool, runGmailSearch } from "./gmailSearch.js";
import { addCalendarEventTool, runAddCalendarEvent } from "./calendarEvent.js";
import { executeComposioTool } from "../services/composio.js";
import { addLocalTimes } from "./localTimes.js";
import {
  checkBackgroundTasksTool,
  cancelBackgroundTaskTool,
  runCheckBackgroundTasks,
  runCancelBackgroundTask,
} from "./backgroundTasks.js";
import { setReminderTool, runSetReminder } from "./reminder.js";
import { env } from "../config.js";

/**
 * OpenAI's built-in web search tool (Responses API). Unlike the tools below,
 * this one runs entirely on OpenAI's servers — the model decides to search,
 * the API fetches real results, and it answers with them, all inside a
 * single API call. We never see a "function_call" item for it and never
 * execute anything ourselves; it just needs to be listed in `tools`. This is
 * what answers weather, sports scores/schedules, news, prices — anything
 * that changes over time and can't come from the model's training data
 * alone. CONFIRMED BY RESEARCH: only certain models support this in the
 * Responses API — gpt-4o-mini's search-capable variant was deprecated and
 * shut down 2026-07-23, which is exactly why Nova's brain is on gpt-4.1-mini
 * (config.ts's OPENAI_REASONING_MODEL) and not the cheaper gpt-4o-mini.
 * Docs: https://developers.openai.com/api/docs/guides/tools-web-search
 */
const webSearchTool = { type: "web_search" };

// search_gmail replaces direct access to Composio's GMAIL_FETCH_EMAILS
// entirely (see gmailSearch.ts's comment for why) — it isn't a Composio
// toolkit tool, so it's listed here as a static tool the same way
// make_phone_call is, and composio.ts's CURATED_TOOLS.GMAIL no longer
// includes GMAIL_FETCH_EMAILS.
export const staticTools = [
  webSearchTool,
  makePhoneCallTool,
  gmailSearchTool,
  addCalendarEventTool,
  checkBackgroundTasksTool,
  cancelBackgroundTaskTool,
  setReminderTool,
];

/**
 * Tool names/prefixes that represent a "real world" action worth talking
 * over. make_phone_call is deliberately NOT here — placing the call itself
 * resolves in well under a second (it's just an API call to Twilio, not the
 * call itself), and the tool's own description already has Nova say "calling
 * now" as her real answer, so a separate filler line would just be redundant.
 */
const SLOW_STATIC_TOOLS = new Set(["search_gmail", "add_calendar_event"]);
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
  return "Give me a moment, I'm on it...";
}

export async function executeTool(name: string, input: any, ctx: { userId: string; timezone?: string }) {
  switch (name) {
    case "make_phone_call":
      return runMakePhoneCall(input, ctx);
    case "search_gmail":
      return runGmailSearch(input, ctx);
    case "add_calendar_event":
      return runAddCalendarEvent(input, ctx);
    case "check_background_tasks":
      return runCheckBackgroundTasks(ctx);
    case "cancel_background_task":
      return runCancelBackgroundTask(input, ctx);
    case "set_reminder":
      return runSetReminder(input, ctx);
    default: {
      // Anything not defined above is assumed to be a Composio-provided tool
      // (e.g. GMAIL_SEND_EMAIL, GOOGLECALENDAR_CREATE_EVENT). web_search never
      // lands here — Anthropic resolves it server-side before we see a response.
      const result = await executeComposioTool(ctx.userId, name, input);
      // Canvas dates are all raw UTC — see localTimes.ts for the bug this fixes.
      if (name.toUpperCase().startsWith("CANVAS")) return addLocalTimes(result, ctx.timezone || env.TIMEZONE);
      return result;
    }
  }
}
