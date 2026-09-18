import { Router } from "express";
import { env } from "../config.js";
import { createLiveSession } from "../services/live.js";
import { attachLiveDelegate } from "../services/liveDelegate.js";
import { attachUser } from "./auth.js";

const router = Router();

// GPT-Live-1's own persona/behavior instructions. It never answers from its
// own knowledge here — every real request gets delegated so Nova's actual
// personality (STATIC_INSTRUCTIONS in services/llm.ts) and tools stay in one
// place instead of being duplicated/out of sync across two models. Tuned for
// Alexa-style pacing: quick acknowledgment the instant she hears you, then
// silence (not narration) until the backend actually has something to say.
const LIVE_INSTRUCTIONS = `You are the real-time voice layer for Nova, a warm, quick, witty smart-speaker assistant — think Alexa, but named Nova. You have no knowledge or opinions of your own and you never answer from your own training data.

Every single thing the user says must be delegated to the backend — it does the real thinking, remembers the conversation, and can check the weather, sports, news, Gmail, Google Calendar, Canvas, and book restaurants. Delegate the instant the user finishes a thought; don't wait for extra confirmation.

The moment you delegate, say exactly ONE short acknowledgment that is specific to what they asked — say what Nova is about to do, in under 12 words: "Let me check what's due tonight on Canvas." / "Pulling up your latest emails." / "Let me check today's weather in Campbell." Never a bare generic word like "Sure." or "I'll check that." on its own, and never two acknowledgments — one sentence, then go quiet. It must NOT contain any answer, fact, number, time, or guess — you don't have the data yet. For small talk or a simple yes/no reply to something Nova just asked, skip the acknowledgment entirely.

When the backend's commentary arrives, that is the real answer: speak it naturally in your own voice and pacing, as if it were your own words. Don't repeat your acknowledgment first. You may smooth its phrasing for spoken delivery, but never contradict it, drop information from it, or add facts it didn't give you. Speak it in one continuous breath — don't pause mid-answer waiting for anything once you've started.

If the user starts talking while you're speaking, stop immediately and listen — treat what they say as a brand new request. Background noise or a short "mm" from the user isn't a new request — only stop for actual speech.`;

/**
 * WebRTC signaling endpoint for GPT-Live-1: the browser posts its SDP offer
 * here, we exchange it for an answer with OpenAI (with the OPENAI_API_KEY
 * that never leaves the server), and attach a backend "sideband" connection
 * to the new session so Claude + Composio can drive it (see liveDelegate.ts).
 */
router.post("/session", attachUser, async (req, res) => {
  const start = Date.now();
  try {
    const userId = (req as any).userId;
    const { sdp, timezone, voice } = req.body ?? {};
    if (typeof sdp !== "string" || !sdp.trim()) {
      return res.status(400).json({ error: "An SDP offer is required" });
    }
    if (!env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "Live voice isn't configured — add OPENAI_API_KEY to backend/.env" });
    }

    // Timed so "how long does it take to connect" has a real answer instead
    // of a guess — this is the OpenAI round trip only; it doesn't include the
    // browser's own mic-permission/ICE-gathering time before this request
    // was even sent, so the user-perceived "powering on" delay runs a bit
    // longer than this number.
    const { sessionId, answerSdp } = await createLiveSession(sdp, {
      instructions: LIVE_INSTRUCTIONS,
      voice: typeof voice === "string" && voice ? voice : undefined,
    });
    console.log(`[live] session ${sessionId} created in ${Date.now() - start}ms`);
    attachLiveDelegate(sessionId, { userId, timezone: timezone || undefined });

    res.status(201).json({ sessionId, sdp: answerSdp });
  } catch (err: any) {
    console.error(`[live] session creation failed after ${Date.now() - start}ms:`, err?.message ?? err);
    res.status(502).json({ error: err?.message ?? "Live session creation failed" });
  }
});

export default router;
