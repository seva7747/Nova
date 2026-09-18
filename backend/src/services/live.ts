import { env } from "../config.js";

/**
 * Creates a GPT-Live-1 voice session over WebRTC.
 *
 * This is a plain `fetch` against OpenAI's REST endpoint rather than the
 * `openai` npm SDK — Live is a brand-new (Sept 2026) surface and its SDK
 * method names/shapes are a moving target right now, whereas the raw HTTP
 * contract (documented at https://developers.openai.com/api/docs/guides/live)
 * is what's actually stable. Same philosophy as composio.ts's note about a
 * young SDK.
 *
 * Flow: the browser creates an RTCPeerConnection and an SDP offer; we hand
 * that offer to OpenAI along with the session config (which model, what
 * instructions, and — critically — `delegation: { type: "client" }` so OUR
 * backend keeps doing the reasoning instead of an OpenAI model); OpenAI
 * returns an SDP answer plus a session id. The caller completes the peer
 * connection with that answer, and we separately attach a "sideband"
 * connection to the same session id (see liveDelegate.ts) to handle the
 * actual conversation server-side.
 *
 * Note: per OpenAI's docs, creating a WebRTC Live session bills ~15 seconds
 * of voice duration up front as part of session setup, on top of whatever
 * the conversation itself runs — a fixed per-connection cost, not per-retry.
 *
 * CONFIRMED BY TESTING (curl against the real endpoint, Sept 2026) — this
 * takes a plain JSON body, NOT multipart/form-data. An earlier version of
 * this file sent FormData (based on a doc summary that turned out to
 * describe a different endpoint) and OpenAI rejected every request with
 * "Live session requests require Content-Type: application/json" before it
 * ever got far enough to look at the SDP — which is exactly the silent
 * failure that made voice mode do nothing. If this ever breaks again, curl
 * the endpoint directly with a real key first; don't guess from docs alone.
 */
export async function createLiveSession(
  offerSdp: string,
  opts: { instructions: string; voice?: string }
): Promise<{ sessionId: string; answerSdp: string }> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Live voice isn't configured — add OPENAI_API_KEY to backend/.env");
  }

  const body = {
    session: {
      model: env.OPENAI_LIVE_MODEL,
      instructions: opts.instructions,
      delegation: { type: "client" as const },
      // UNVERIFIED beyond "OpenAI's session-create endpoint accepts this key
      // without rejecting the request" (tested via curl) — I haven't been
      // able to confirm end-to-end that it actually changes what you hear,
      // since that needs a real mic/browser session. If it turns out to be a
      // no-op, this is the line to revisit.
      ...(opts.voice ? { voice: opts.voice } : {}),
    },
    transport: { type: "webrtc" as const, sdp: offerSdp },
  };

  const resp = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI Live session creation failed (${resp.status}): ${detail}`);
  }

  const data: any = await resp.json();
  const sessionId = data?.session?.id;
  const answerSdp = data?.transport?.sdp;
  if (!sessionId || !answerSdp) {
    throw new Error("OpenAI Live returned an unexpected response shape (no session id or answer SDP).");
  }

  return { sessionId, answerSdp };
}
