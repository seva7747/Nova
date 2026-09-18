import { useCallback, useEffect, useRef, useState } from "react";
import { useWakeWordEngine } from "./useWakeWordEngine";
import { useNovaSettings } from "./useNovaSettings";
import { useNovaLive, type LiveConnection } from "./useNovaLive";
import { fetchTaskStatus } from "../lib/api";

// "live-idle" = a GPT-Live-1 voice session is open and Nova is just waiting
// for you to talk (no wake word needed mid-session) — distinct from
// "wake-listening" (no paid session open yet, only the free local wake-word
// detector is running) so the two mic consumers never fight over the mic.
export type NovaState = "off" | "powering-on" | "wake-listening" | "live-idle" | "recording" | "thinking" | "speaking";
export type LogEntry = { id: string; role: "user" | "nova" | "system"; text: string };

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Nova's whole voice pipeline is GPT-Live-1 (see useNovaLive.ts for the
 * WebRTC transport, backend/src/services/liveDelegate.ts for how it hands
 * off to Claude + Composio). This hook is the state machine wrapped around
 * that: it gates the paid live session behind a free local wake-word
 * detector, tracks conversation state for the orb/transcript UI, and closes
 * the session again after things go quiet.
 */
export function useNovaConversation() {
  const [state, setState] = useState<NovaState>("off");
  const [log, setLog] = useState<LogEntry[]>([]);
  const busyRef = useRef(false);
  const [settings] = useNovaSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const { connect: liveConnect, level } = useNovaLive();
  const liveConnRef = useRef<LiveConnection | null>(null);
  const liveIdleTimerRef = useRef<number | undefined>(undefined);
  const liveUserEntryIdRef = useRef<string | null>(null);
  const liveNovaEntryIdRef = useRef<string | null>(null);
  const liveNovaSpeakingTimerRef = useRef<number | undefined>(undefined);
  const liveThinkingToIdleTimerRef = useRef<number | undefined>(undefined);
  const [longTaskActive, setLongTaskActive] = useState(false);

  const pushLog = useCallback((entry: Omit<LogEntry, "id">) => {
    setLog((l) => [...l.slice(-40), { ...entry, id: makeId() }]);
  }, []);

  // Polls a plain HTTP endpoint (free — no GPT-Live session needed) so a
  // background task (see backend/src/services/liveDelegate.ts and tasks.ts)
  // still shows up and gets announced in the transcript even if the paid
  // voice session that started it has since closed by the time it finishes.
  // Set up ONCE (not keyed on `state`, which changes far more often than
  // every 2.5s) so the interval and the "was it active last time I checked"
  // tracking both survive state changes cleanly instead of tearing down and
  // losing track mid-task.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    let wasActive = false;
    const poll = async () => {
      if (stateRef.current === "off") {
        setLongTaskActive(false);
        return;
      }
      const status = await fetchTaskStatus();
      if (!status) return;
      setLongTaskActive(status.active);
      if (wasActive && !status.active && status.result) {
        pushLog({ role: "system", text: `✅ Finished: ${status.result}` });
      }
      wasActive = status.active;
    };
    poll();
    const interval = window.setInterval(poll, 2500);
    return () => window.clearInterval(interval);
  }, [pushLog]);

  const clearLiveIdleTimer = useCallback(() => {
    window.clearTimeout(liveIdleTimerRef.current);
  }, []);

  /**
   * Keeps the (paid, $0.05/min) live session open for a little while after
   * Nova finishes talking with nobody responding, rather than hanging up
   * after every single turn and eating the ~15s setup cost/latency again on
   * the very next thing the user says. Reuses the "follow-up listening"
   * setting as that grace period, with a floor so turning that setting off
   * doesn't mean "hang up instantly."
   */
  const armLiveIdleTimer = useCallback(() => {
    clearLiveIdleTimer();
    const idleMs = Math.max(settingsRef.current.followUpMs || 0, 8000);
    liveIdleTimerRef.current = window.setTimeout(() => liveConnRef.current?.close(), idleMs);
  }, [clearLiveIdleTimer]);

  /** Opens one persistent GPT-Live-1 WebRTC session and drives the orb/transcript state off its events until it closes. */
  const beginCommand = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState("powering-on");
    try {
      const conn = await liveConnect({
        timezone: settingsRef.current.timezone || undefined,
        voice: settingsRef.current.liveVoiceName || undefined,
        onUserTranscript: (delta) => {
          clearLiveIdleTimer();
          window.clearTimeout(liveThinkingToIdleTimerRef.current); // they're talking — definitely not idle, whatever we were about to conclude
          setState("recording");
          if (liveUserEntryIdRef.current === null) {
            const id = makeId();
            liveUserEntryIdRef.current = id;
            setLog((l) => [...l.slice(-40), { id, role: "user", text: delta }]);
          } else {
            const id = liveUserEntryIdRef.current;
            setLog((l) => l.map((e) => (e.id === id ? { ...e, text: e.text + delta } : e)));
          }
        },
        onDelegating: () => {
          liveUserEntryIdRef.current = null; // that turn's transcript is complete — next delta starts a fresh bubble
          window.clearTimeout(liveThinkingToIdleTimerRef.current); // a new request is definitely not "idle"
          setState("thinking");
        },
        onNovaTranscript: (delta) => {
          window.clearTimeout(liveNovaSpeakingTimerRef.current);
          window.clearTimeout(liveThinkingToIdleTimerRef.current);
          // Any new speech from Nova is proof the session is still very much
          // alive, even if the "has she stopped talking?" guess below fired
          // early on a natural pause — always cancel a pending idle-close.
          clearLiveIdleTimer();
          setState("speaking");
          if (liveNovaEntryIdRef.current === null) {
            const id = makeId();
            liveNovaEntryIdRef.current = id;
            setLog((l) => [...l.slice(-40), { id, role: "nova", text: delta }]);
          } else {
            const id = liveNovaEntryIdRef.current;
            setLog((l) => l.map((e) => (e.id === id ? { ...e, text: e.text + delta } : e)));
          }
          // GPT-Live doesn't send an explicit "done speaking" event, so this
          // is a two-stage guess instead of a single cutoff. CONFIRMED BY
          // TESTING: a single ~2s cutoff straight to "live-idle" made the orb
          // look finished within a couple seconds of ANY pause — including
          // the completely normal gap between Nova's instant "sure, one
          // sec" and the real answer, which routinely takes several seconds
          // once a Composio/Claude tool call is involved. So: a short pause
          // now only means "stop growing this speech bubble" and shows
          // "thinking" (still working, just not talking this instant) — only
          // a much longer continued silence after that is treated as
          // actually done and allowed to go idle / start the paid-session
          // close countdown. Any further speech (or the user talking)
          // cancels this at either stage.
          liveNovaSpeakingTimerRef.current = window.setTimeout(() => {
            liveNovaEntryIdRef.current = null;
            setState((s) => (s === "off" ? s : "thinking"));
            liveThinkingToIdleTimerRef.current = window.setTimeout(() => {
              setState((s) => (s === "off" ? s : "live-idle"));
              armLiveIdleTimer();
            }, 20000);
          }, 1800);
        },
        onClosed: () => {
          liveConnRef.current = null;
          liveUserEntryIdRef.current = null;
          liveNovaEntryIdRef.current = null;
          window.clearTimeout(liveNovaSpeakingTimerRef.current);
          window.clearTimeout(liveThinkingToIdleTimerRef.current);
          clearLiveIdleTimer();
          busyRef.current = false;
          setState((s) => (s === "off" ? s : "wake-listening"));
        },
        onError: (message) => pushLog({ role: "system", text: message }),
      });
      liveConnRef.current = conn;
      setState("live-idle");
      armLiveIdleTimer();
    } catch (err: any) {
      console.error(err);
      busyRef.current = false;
      pushLog({ role: "system", text: err?.message ?? "Couldn't start live voice." });
      setState((s) => (s === "off" ? s : "wake-listening"));
    }
  }, [liveConnect, pushLog, armLiveIdleTimer, clearLiveIdleTimer]);

  const {
    supported: wakeWordSupported,
    engine: wakeWordEngine,
    porcupineError,
  } = useWakeWordEngine({
    enabled: state === "wake-listening",
    onWake: () => {
      if (!busyRef.current) beginCommand();
    },
  });

  const plugIn = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setState("powering-on");
      pushLog({ role: "system", text: 'Nova is plugged in. Say "Nova" to wake her up — or tap the orb.' });
      // Brief light-up moment before she actually starts listening — purely
      // cosmetic (matches the power-on animation), not a real delay.
      window.setTimeout(() => {
        // Only advance if still mid-power-on — guards against the user
        // unplugging again during that brief window.
        setState((s) => (s === "powering-on" ? "wake-listening" : s));
      }, 850);
    } catch {
      pushLog({ role: "system", text: "Nova needs microphone access to listen for the wake word." });
    }
  }, [pushLog]);

  const unplug = useCallback(() => {
    busyRef.current = false;
    liveConnRef.current?.close();
    liveConnRef.current = null;
    clearLiveIdleTimer();
    window.clearTimeout(liveNovaSpeakingTimerRef.current);
    window.clearTimeout(liveThinkingToIdleTimerRef.current);
    setState("off");
  }, [clearLiveIdleTimer]);

  const orbTap = useCallback(() => {
    if (state === "off") plugIn();
    else if (state === "wake-listening") beginCommand();
    else if (state === "live-idle") liveConnRef.current?.close(); // tap to hang up a live session early
  }, [state, plugIn, beginCommand]);

  return {
    state,
    log,
    level,
    longTaskActive,
    plugIn,
    unplug,
    beginCommand,
    orbTap,
    wakeWordSupported,
    wakeWordEngine,
    porcupineError,
  };
}
