import { useState } from "react";
import { Link } from "react-router-dom";
import { useNovaConversation } from "../hooks/useNovaConversation";
import { NovaOrb } from "./NovaOrb";
import { TranscriptPanel } from "./TranscriptPanel";

export function DeviceDemo() {
  const { state, log, level, taskLight, plugIn, unplug, orbTap, wakeWordSupported, wakeWordEngine, porcupineError } =
    useNovaConversation();
  const [showTranscript, setShowTranscript] = useState(false);

  const lastEntry = log[log.length - 1];
  const hasUnseenAlert = !showTranscript && lastEntry?.role === "system";

  return (
    <div
      id="demo"
      className="w-full flex flex-col items-center gap-8 rounded-3xl border border-white/10 bg-white/[0.02] px-6 py-12 sm:px-12"
    >
      <div className="text-center max-w-lg">
        <h2 className="text-2xl font-bold text-white">Try Nova right here</h2>
        <p className="mt-2 text-sm text-white/50">
          This runs the real pipeline — GPT-Live-1 for full-duplex voice, Claude with tool-use for the actual
          thinking — against whatever accounts you've connected on the{" "}
          <Link to="/connectors" className="text-nova-cyan/80 hover:text-nova-cyan underline underline-offset-2">
            Connectors
          </Link>{" "}
          page. No physical hardware needed.
        </p>
      </div>

      <NovaOrb state={state} level={level} onTap={orbTap} taskLight={taskLight} />

      {state === "off" && (
        <p className="text-xs text-white/35 -mt-2">Click the orb to plug Nova in and grant microphone access.</p>
      )}

      {state !== "off" && !wakeWordSupported && (
        <p className="text-xs text-amber-300/70 -mt-2 max-w-sm text-center">
          Your browser doesn't support live wake-word listening (try Chrome or Edge) — tap the orb to talk to Nova
          instead.
        </p>
      )}

      {state !== "off" && wakeWordEngine === "porcupine" && (
        <p className="text-xs text-nova-cyan/60 -mt-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-nova-cyan" />
          Porcupine wake word engine active
        </p>
      )}

      {state !== "off" && wakeWordEngine === "browser" && porcupineError && (
        <p className="text-xs text-amber-300/70 -mt-2 max-w-sm text-center">
          Porcupine didn't load ({porcupineError}) — falling back to the browser's built-in recognizer.
        </p>
      )}

      {state !== "off" && (
        <button
          onClick={() => setShowTranscript((v) => !v)}
          className="text-xs text-white/35 hover:text-white/60 transition flex items-center gap-1.5 -mt-2"
        >
          {hasUnseenAlert && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
          {showTranscript ? "Hide conversation ▲" : "Show conversation ▾"}
        </button>
      )}

      {showTranscript && <TranscriptPanel log={log} />}

      <div className="flex items-center gap-4 text-xs text-white/30">
        {state === "off" ? (
          <button onClick={plugIn} className="hover:text-white/60 transition">
            Plug Nova in
          </button>
        ) : (
          <button onClick={unplug} className="hover:text-white/60 transition">
            Unplug Nova
          </button>
        )}
      </div>
    </div>
  );
}
