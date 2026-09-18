export function Hero() {
  return (
    <header className="w-full flex flex-col items-center text-center pt-20 pb-14 px-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/50 mb-6">
        <span className="w-1.5 h-1.5 rounded-full bg-nova-cyan animate-pulse" />
        Prototype — the site below is a fully working demo, not a mockup
      </div>
      <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight bg-gradient-to-br from-white via-white to-white/60 bg-clip-text text-transparent">
        Meet Nova.
      </h1>
      <p className="mt-5 max-w-xl text-base sm:text-lg text-white/55">
        A voice assistant that actually gets things done — check your email, manage your calendar, catch the
        score, book a table. Just say <span className="text-white/80 font-medium">"Nova."</span>
      </p>
      <a
        href="#demo"
        className="mt-8 inline-flex items-center gap-2 rounded-full bg-white text-ink-950 font-semibold px-6 py-3 text-sm hover:bg-white/90 transition"
      >
        Try the live demo ↓
      </a>
    </header>
  );
}
