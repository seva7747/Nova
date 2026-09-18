const STACK = [
  {
    stage: "Wake word",
    choice: "Picovoice Porcupine (on-device), browser speech recognition as fallback",
    why: "Always-on, free, and runs locally in the tab listening for “Nova” — no OpenAI/Anthropic call happens until it fires.",
  },
  {
    stage: "Listening & speaking",
    choice: "OpenAI · GPT-Live-1",
    why: "One persistent, full-duplex WebRTC voice session — replaces separate transcription and text-to-speech calls with a single always-on connection. Only this part is OpenAI.",
  },
  {
    stage: "Thinking & tool routing",
    choice: "Claude Haiku 4.5",
    why: "GPT-Live-1 delegates every real request here — it never answers on its own. Fast, cheap, and reliable at deciding which tool to call (Gmail, Calendar, web search...).",
  },
  {
    stage: "Live info",
    choice: "Claude's built-in web search",
    why: "Weather, sports scores, news — a real search Claude runs itself, not a guess from training data.",
  },
  {
    stage: "Integrations",
    choice: "Composio",
    why: "One connection layer for Gmail, Google Calendar, and hundreds of other tools.",
  },
];

export function UnderTheHood() {
  return (
    <section className="w-full rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
      <h3 className="font-semibold text-white mb-1">Under the hood</h3>
      <p className="text-sm text-white/45 mb-6">
        Every leg of the round trip was picked for speed first — the goal is an answer in roughly a second or
        two, the same ballpark as Alexa, not "chatbot" pace.
      </p>
      <div className="flex flex-col divide-y divide-white/5">
        {STACK.map((s) => (
          <div key={s.stage} className="py-3.5 grid grid-cols-1 sm:grid-cols-[140px_180px_1fr] gap-1 sm:gap-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-white/35">{s.stage}</div>
            <div className="text-sm font-medium text-white">{s.choice}</div>
            <div className="text-sm text-white/45">{s.why}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
