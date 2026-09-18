const FEATURES = [
  {
    title: "Email, handled",
    desc: '"Check my email" — Nova reads through your inbox and tells you what actually matters.',
    icon: "✉️",
  },
  {
    title: "Your calendar, by voice",
    desc: '"Schedule a dentist appointment for 4pm this Thursday" — done, no app required.',
    icon: "🗓️",
  },
  {
    title: "Weather & scores, instantly",
    desc: "Ask what it's like outside or when your team plays next — answered in about a second.",
    icon: "⛅",
  },
  {
    title: "Real-world errands",
    desc: '"Call up Armadillo Willy\'s and book a table for four Thursday at 7" — Nova tells you it\'s on it, then handles it.',
    icon: "📞",
  },
];

export function FeatureGrid() {
  return (
    <section className="w-full grid grid-cols-1 sm:grid-cols-2 gap-4 px-2">
      {FEATURES.map((f) => (
        <div
          key={f.title}
          className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:bg-white/[0.04] transition"
        >
          <div className="text-2xl mb-3">{f.icon}</div>
          <h3 className="font-semibold text-white mb-1.5">{f.title}</h3>
          <p className="text-sm text-white/50 leading-relaxed">{f.desc}</p>
        </div>
      ))}
    </section>
  );
}
