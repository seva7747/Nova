import type { NovaState, TaskLight } from "../hooks/useNovaConversation";

const STATE_LABEL: Record<NovaState, string> = {
  off: "Tap to plug in",
  "powering-on": "Powering on...",
  "wake-listening": 'Listening for "Nova"',
  "live-idle": "Live — go ahead",
  recording: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
};

function Waveform({ level = 0.5, bars = 5 }: { level?: number; bars?: number }) {
  return (
    <div className="flex items-end gap-1 h-9">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="nova-bar w-1.5 rounded-full bg-white/90"
          style={{
            height: `${100}%`,
            animationDelay: `${i * 0.11}s`,
            transform: `scaleY(${Math.max(0.25, level)})`,
          }}
        />
      ))}
    </div>
  );
}

// Nothing renders in the core during "thinking" — the fast chase ring around
// it is the whole signal, same as real hardware just shows a spinning light.

function PowerGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path d="M12 3v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M7 5.5a8 8 0 1 0 10 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A bright arc chasing around the ring — the actual "light ring" look real
 * smart speakers use. One shared component; speed + brightness convey state
 * (slow, dim idle glimmer vs. a fast, tight, bright sweep while thinking).
 */
function ChaseRing({
  size,
  duration,
  arcWidth = 40,
  colors = "#5eead4, #60a5fa, #a78bfa",
  oneShot = false,
}: {
  size: number;
  duration: string;
  arcWidth?: number;
  colors?: string;
  oneShot?: boolean;
}) {
  return (
    <span
      className={oneShot ? "absolute rounded-full animate-nova-power-on" : "absolute rounded-full animate-nova-rotate"}
      style={{
        width: size,
        height: size,
        animationDuration: duration,
        background: `conic-gradient(from 0deg, transparent 0%, ${colors} ${arcWidth}%, transparent ${arcWidth + 15}%)`,
        WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
        mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))",
      }}
    />
  );
}

const CORE_GRADIENT: Record<NovaState, string> = {
  off: "from-ink-800 to-ink-900",
  "powering-on": "from-nova-blue/70 via-nova-cyan/50 to-nova-violet/60",
  "wake-listening": "from-nova-blue/70 via-nova-cyan/50 to-nova-violet/60",
  "live-idle": "from-emerald-400/70 via-nova-cyan/50 to-nova-blue/60",
  recording: "from-nova-cyan via-nova-blue to-nova-violet",
  thinking: "from-nova-violet via-nova-blue to-nova-cyan",
  speaking: "from-nova-cyan via-nova-blue to-nova-violet",
};

export function NovaOrb({
  state,
  level = 0,
  onTap,
  size = 220,
  taskLight = "none",
}: {
  state: NovaState;
  level?: number;
  onTap?: () => void;
  size?: number;
  /**
   * Background-task light (see backend/src/services/tasks.ts), layered around
   * whatever the current state's own ring is doing since a task outlives any
   * one state: a smooth yellow pulse while it runs, steady green once it's
   * done — until Nova mentions it as a "by the way" on the next question.
   */
  taskLight?: TaskLight;
}) {
  const ringScale = state === "recording" ? 1 + level * 0.3 : 1;
  const interactive = state === "off" || state === "wake-listening" || state === "live-idle";
  const glowing = state !== "off" && state !== "powering-on";

  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <button
        type="button"
        onClick={onTap}
        disabled={!interactive}
        aria-label={interactive ? "Tap to talk to Nova" : "Nova"}
        className="relative flex items-center justify-center outline-none"
        style={{ width: size * 1.55, height: size * 1.55 }}
      >
        {/* outer pulse rings, only while idling and waiting for the wake word (or idling mid live-session) */}
        {(state === "wake-listening" || state === "live-idle") && (
          <>
            <span
              className="absolute rounded-full border border-nova-blue/40 animate-nova-pulse-ring"
              style={{ width: size * 1.15, height: size * 1.15 }}
            />
            <span
              className="absolute rounded-full border border-nova-cyan/30 animate-nova-pulse-ring"
              style={{ width: size * 1.15, height: size * 1.15, animationDelay: "1.2s" }}
            />
          </>
        )}

        {/* soft ambient glow behind everything */}
        <span
          className={`absolute rounded-full blur-3xl transition-opacity duration-500 bg-gradient-to-br ${CORE_GRADIENT[state]} ${
            glowing ? "opacity-40 animate-nova-breathe" : "opacity-0"
          }`}
          style={{ width: size * 1.3, height: size * 1.3 }}
        />

        {/* the light ring itself — a chasing arc whose speed says how "busy" Nova is */}
        {state === "powering-on" && <ChaseRing size={size * 1.1} duration="0.85s" arcWidth={55} oneShot />}
        {state === "wake-listening" && <ChaseRing size={size * 1.08} duration="7s" arcWidth={30} />}
        {state === "live-idle" && <ChaseRing size={size * 1.08} duration="4s" arcWidth={30} colors="#5eead4, #34d399, #60a5fa" />}
        {state === "recording" && <ChaseRing size={size * 1.08} duration="2.1s" arcWidth={32} />}
        {state === "thinking" && <ChaseRing size={size * 1.08} duration="0.65s" arcWidth={22} />}
        {state === "speaking" && <ChaseRing size={size * 1.08} duration="3.2s" arcWidth={45} />}

        {/* background-task light: yellow pulse while running, green when done */}
        {taskLight !== "none" && (
          <span
            key={taskLight}
            className={`absolute rounded-full pointer-events-none ${taskLight === "running" ? "nova-task-running" : "nova-task-done"}`}
            style={{ width: size * 1.24, height: size * 1.24 }}
          />
        )}

        {/* recording ring also reacts to live mic volume */}
        {state === "recording" && (
          <span
            className="absolute rounded-full border-2 border-nova-cyan/70 transition-transform duration-75"
            style={{ width: size * 1.08, height: size * 1.08, transform: `scale(${ringScale})` }}
          />
        )}

        {/* the core sphere */}
        <span
          className={`relative rounded-full flex items-center justify-center shadow-glow bg-gradient-to-br ${CORE_GRADIENT[state]} transition-all duration-500 ${
            interactive ? "hover:brightness-110 active:scale-95 cursor-pointer" : "cursor-default"
          }`}
          style={{
            width: size,
            height: size,
            boxShadow: state === "off" ? "none" : undefined,
          }}
        >
          <span className="absolute inset-0 rounded-full bg-gradient-to-t from-black/25 to-white/10" />
          <span className="relative z-10">
            {state === "off" && <PowerGlyph />}
            {(state === "powering-on" || state === "wake-listening" || state === "live-idle") && (
              <span className="text-[11px] font-semibold tracking-[0.35em] text-white/85 uppercase">Nova</span>
            )}
            {state === "recording" && <Waveform level={level} />}
            {state === "speaking" && <Waveform level={0.8} />}
          </span>
        </span>
      </button>

      <div className="flex flex-col items-center gap-1">
        <div className="text-sm font-medium text-white/60 tracking-wide">{STATE_LABEL[state]}</div>
        {taskLight === "running" && (
          <div className="text-xs text-amber-300/80 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
            Working in the background — keep asking
          </div>
        )}
        {taskLight === "done" && (
          <div className="text-xs text-emerald-300/85 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Background task done — I'll fill you in next time you ask
          </div>
        )}
      </div>
    </div>
  );
}
