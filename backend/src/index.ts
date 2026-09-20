import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer } from "ws";
import { env } from "./config.js";
import authRouter from "./routes/auth.js";
import integrationsRouter from "./routes/integrations.js";
import liveRouter from "./routes/live.js";
import tasksRouter from "./routes/tasks.js";
import remindersRouter from "./routes/reminders.js";
import smsRouter from "./routes/sms.js";
import voiceCallRouter from "./routes/voiceCall.js";
import { attachVoiceCallDelegate } from "./services/voiceCallDelegate.js";
import { attachOutboundCallDelegate } from "./services/outboundCallDelegate.js";

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
// Twilio's webhooks POST form-encoded, not JSON — this only kicks in for
// that content-type, so it coexists fine with express.json() above.
app.use(express.urlencoded({ extended: false }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: {
      brain: Boolean(env.ANTHROPIC_API_KEY),
      composio: Boolean(env.COMPOSIO_API_KEY),
      liveVoice: Boolean(env.OPENAI_API_KEY),
      // Covers both texting and calling Nova — same Twilio number/creds
      // power both (see routes/sms.ts and routes/voiceCall.ts).
      twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER && env.PUBLIC_BASE_URL),
    },
  });
});

app.use("/api/auth", authRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/live", liveRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/reminders", remindersRouter);
app.use("/api/sms", smsRouter);
app.use("/api/voice-call", voiceCallRouter);

// A plain http.Server (rather than app.listen()'s implicit one) so a
// WebSocket server can share the same port — needed for phone calls:
// Twilio's ConversationRelay connects here after routes/voiceCall.ts's
// TwiML points it at this path (see that file's own comment for the whole
// flow, and services/voiceCallDelegate.ts for what actually happens once
// connected).
const server = http.createServer(app);

// CONFIRMED BY TESTING — real call failure: Twilio error 64102, "Unable to
// Connect to Websocket URL," but ONLY for the outbound-stream path; the
// inbound /stream path (below) worked fine through the exact same tunnel.
// Root cause: binding two separate `WebSocketServer`s directly to the same
// `server` (each with its own `path` option) makes EACH one attach its own
// 'upgrade' listener — and Node fires every listener for every upgrade
// event. Whichever WebSocketServer was constructed FIRST sees the OTHER
// server's path, decides it doesn't match, and aborts/destroys the socket
// (ws's shouldHandle() → abortHandshake) before the second server's own
// listener ever gets a chance to look at it. So the first path registered
// silently ate every connection meant for the second one. Fixed with ws's
// own documented pattern for multiple paths on one server: both in
// `noServer` mode, with a single manual 'upgrade' handler that inspects the
// pathname itself and routes to the right one.
const wss = new WebSocketServer({ noServer: true });
const outboundWss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  // Lightweight access control in place of a real signature on the WS
  // upgrade (Twilio doesn't document one for ConversationRelay) — see
  // routes/voiceCall.ts's security note for the full reasoning.
  const url = new URL(req.url ?? "", "http://internal");
  if (url.searchParams.get("auth") !== env.TWILIO_AUTH_TOKEN || !env.TWILIO_AUTH_TOKEN) {
    console.warn("[voice-call] rejected a WebSocket connection with a missing/invalid auth token");
    ws.close();
    return;
  }
  attachVoiceCallDelegate(ws);
});

outboundWss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://internal");
  if (url.searchParams.get("auth") !== env.TWILIO_AUTH_TOKEN || !env.TWILIO_AUTH_TOKEN) {
    console.warn("[outbound-call] rejected a WebSocket connection with a missing/invalid auth token");
    ws.close();
    return;
  }
  const callId = url.searchParams.get("callId") ?? "";
  attachOutboundCallDelegate(ws, callId);
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", "http://internal");
  if (pathname === "/api/voice-call/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (pathname === "/api/voice-call/outbound-stream") {
    outboundWss.handleUpgrade(req, socket, head, (ws) => outboundWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(env.PORT, () => {
  console.log(`\n  Nova backend ready → http://localhost:${env.PORT}\n`);
});
