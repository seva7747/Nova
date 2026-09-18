import express from "express";
import cors from "cors";
import { env } from "./config.js";
import authRouter from "./routes/auth.js";
import integrationsRouter from "./routes/integrations.js";
import liveRouter from "./routes/live.js";
import tasksRouter from "./routes/tasks.js";
import smsRouter from "./routes/sms.js";

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
      brain: Boolean(env.GEMINI_API_KEY),
      composio: Boolean(env.COMPOSIO_API_KEY),
      liveVoice: Boolean(env.OPENAI_API_KEY),
      sms: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER && env.PUBLIC_BASE_URL),
    },
  });
});

app.use("/api/auth", authRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/live", liveRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/sms", smsRouter);

app.listen(env.PORT, () => {
  console.log(`\n  Nova backend ready → http://localhost:${env.PORT}\n`);
});
