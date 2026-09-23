import { placeOutboundCall } from "../services/outboundCall.js";

/**
 * Replaces the old simulated call_restaurant tool with a REAL outbound
 * phone call, now that Twilio Voice is wired up (see services/outboundCall.ts
 * and services/outboundCallDelegate.ts) — general-purpose, not restaurant-
 * specific, since the same mechanism covers "call the library," "call my
 * friend and wish them happy birthday," or a reservation equally well.
 */
export const makePhoneCallTool = {
  type: "function" as const,
  name: "make_phone_call",
  description:
    "Places a REAL outbound phone call on the user's behalf to accomplish something over the phone — asking a library if they have a book, booking a restaurant reservation, wishing someone happy birthday, anything that genuinely needs a live phone conversation. Nova conducts the ENTIRE call herself once it connects, start to finish — you (the household assistant) don't stay on the line and won't see it happen live. Use web_search first if you need to find a business's phone number; ask the user if you need a personal contact's number and don't already have it. This tool returns immediately once the call is placed — the outcome isn't known yet. Tell the user you're calling now; you'll be able to tell them what happened once it's done (delivered automatically the moment it finishes, or ask again in a bit). If the user gives a correction or a change of detail (\"actually make it 8pm instead\") WHILE a call to that same number is still in progress, do NOT call this tool again for it — check your recent-calls context first; either tell the user that call is already happening and the change will have to wait for the next one, or just note it for later. Calling the same person twice in a row for one request is a real mistake, not a safe default.",
  parameters: {
    type: "object" as const,
    properties: {
      toNumber: {
        type: "string",
        description: "The phone number to call, in E.164 form (e.g. +15105551234). Find it with web_search if it's a business and you don't already have it.",
      },
      objective: {
        type: "string",
        description:
          "Exactly what Nova should accomplish on this call, written as plain instructions to herself — e.g. \"Ask if they have Dune by Frank Herbert in stock, and if so ask to hold it under the name Alex.\" or \"Book a table for 4 people tonight at 7pm under the name Alex; if they don't take reservations, ask what the wait is like instead.\"",
      },
      openingLine: {
        type: "string",
        description:
          'The very first thing Nova should say the instant the call is answered, before waiting for a reply — short, natural, and states who she\'s calling on behalf of and why. E.g. "Hi, this is Nova, an assistant calling on behalf of Alex to ask about a book you might have in stock."',
      },
      callerName: {
        type: "string",
        description: "The user's name, so Nova can say who she's calling on behalf of if asked.",
      },
    },
    required: ["toNumber", "objective", "openingLine"],
  },
};

export async function runMakePhoneCall(input: any, ctx: { userId: string }) {
  const { id, callSid } = await placeOutboundCall({
    userId: ctx.userId,
    toNumber: String(input.toNumber),
    objective: String(input.objective),
    openingLine: String(input.openingLine),
    callerName: input.callerName ? String(input.callerName) : undefined,
  });
  return { calling: true, callId: id, callSid, to: input.toNumber };
}
