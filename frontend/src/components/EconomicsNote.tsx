const ROWS = [
  { label: "One-time sale price (est.)", value: "$75", tone: "text-white" },
  { label: "Hardware bill of materials (est.)", value: "~$15 / unit", tone: "text-white/70" },
  { label: "API costs, per unit (est.)", value: "~$30 / month", tone: "text-white/70" },
];

export function EconomicsNote() {
  return (
    <section className="w-full rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-6 sm:p-8">
      <h3 className="font-semibold text-white mb-1">The honest economics</h3>
      <p className="text-sm text-white/50 mb-5 max-w-2xl">
        This is a hardware-shaped product with a software-shaped cost problem: the sale is one-time, but OpenAI
        (GPT-Live-1 at $0.05/minute of open voice session, plus the brain's tokens and searches) and Composio both
        bill monthly, for as long as the device is used. (The estimate below predates both the GPT-Live-1 switch
        and the move to an OpenAI brain, and is worth re-checking against real usage.)
      </p>

      <div className="flex flex-col gap-2 mb-5">
        {ROWS.map((r) => (
          <div key={r.label} className="flex items-center justify-between text-sm border-b border-white/5 pb-2">
            <span className="text-white/45">{r.label}</span>
            <span className={`font-semibold ${r.tone}`}>{r.value}</span>
          </div>
        ))}
      </div>

      <p className="text-sm text-white/55 leading-relaxed">
        At a $75 one-time price with a ~$15 build cost, one month of usage roughly breaks even — every month
        after that, the API bill is a loss unless it's offset somehow. As it's scoped today, this isn't a
        profitable business on a one-time purchase alone. Options worth weighing before building hardware:
        a subscription or "API costs included for N months, then bring your own key" model, a cheaper voice/LLM
        tier for idle chit-chat with the current stack reserved for real tool-use, or leaning on each user's own
        API keys (BYO-key) instead of a shared bill. None of that changes the demo below — it's here so the
        numbers you gave stay attached to the build, not lost in it.
      </p>
    </section>
  );
}
