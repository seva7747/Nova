import { useEffect, useRef } from "react";
import type { LogEntry } from "../hooks/useNovaConversation";

function Bubble({ entry }: { entry: LogEntry }) {
  if (entry.role === "system") {
    return (
      <div className="animate-nova-fade-up text-center text-xs text-white/40 py-1">{entry.text}</div>
    );
  }

  const isUser = entry.role === "user";

  return (
    <div className={`animate-nova-fade-up flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-white/10 text-white rounded-br-sm"
            : "bg-gradient-to-br from-nova-blue/20 to-nova-violet/20 border border-white/10 text-white rounded-bl-sm"
        }`}
      >
        {entry.text}
      </div>
    </div>
  );
}

export function TranscriptPanel({ log }: { log: LogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [log]);

  return (
    <div
      ref={scrollRef}
      className="nova-scroll w-full max-w-md h-72 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-2.5"
    >
      {log.length === 0 ? (
        <div className="m-auto text-center text-sm text-white/30 px-6">
          Plug Nova in, then say "Nova" followed by what you need.
        </div>
      ) : (
        log.map((entry) => <Bubble key={entry.id} entry={entry} />)
      )}
    </div>
  );
}
