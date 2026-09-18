import { useCallback, useEffect, useRef, useState } from "react";
import { useWakeWordEngine } from "./useWakeWordEngine";
import { useNovaSettings } from "./useNovaSettings";
import { useNovaLive, type LiveConnection } from "./useNovaLive";
import { fetchTaskStatus, fetchDueReminder } from "../lib/api";

// "live-idle" = a GPT-Live-1 voice session is open and Nova is just waiting
// for you to talk (no wake word needed mid-session) — distinct from
// "wake-listening" (no paid session open yet, only the free local wake-word
// detector is running) so the two mic consumers never fight over the mic.
export type NovaState = "off" | "powering-on" | "wake-listening" | "live-idle" | "recording" | "thinking" | "speaking";
/** Background-task indicator: "running" = yellow pulse, "done" = green until Nova mentions it. */
export type TaskLight = "none" | "running" | "done";
export type LogEntry = { id: string; role: "user" | "nova" | "system"; text: string };

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Matches ONLY when the user's whole utterance is essentially just "stop"
 * (optionally with "Nova", "please", "talking", etc. mixed in) — anchored at
 * both ends specifically so an unrelated sentence that happens to CONTAIN
 * the word ("can you stop by the store") never matches, only a short,
 * dedicated command to be quiet.
 */
const STOP_COMMAND = /^(hey[, ]+)?(nova[, ]+)?(ok(ay)?[, ]+)?(please[, ]+)?(stop|shut up|be quiet|quiet down)([, ]*(talking|nova))?([, ]*(please|now))?[.!?]*$/i;

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
  const liveUserBufferRef = useRef(""); // raw (undisplayed-formatting) text of the CURRENT utterance, just for STOP_COMMAND matching
  const liveNovaEntryIdRef = useRef<string | null>(null);
  const liveNovaSpeakingTimerRef = useRef<number | undefined>(undefined);
  const liveThinkingToIdleTimerRef = useRef<number | undefined>(undefined);
  const [taskLight, setTaskLight] = useState<TaskLight>("none");

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
    let wasDone = false;
    const poll = async () => {
      if (stateRef.current === "off") {
        setTaskLight("none");
        return;
      }
      const status = await fetchTaskStatus();
      if (!status) return;
      // Yellow while anything's running; green once it's finished but Nova
      // hasn't mentioned it yet — it clears when the next question's "by
      // the way" picks it up (backend takes it then).
      setTaskLight(status.active ? "running" : status.done ? "done" : "none");
      const isDone = Boolean(status.done);
      if (isDone && !wasDone && status.result) {
        pushLog({ role: "system", text: `✅ Finished in the background: ${status.result}` });
      }
      wasDone = isDone;
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
   *
   * Deliberately closes on idle EVEN IF a background task is still running —
   * confirmed this is what's actually wanted: the task itself runs on Claude
   * Haiku regardless of whether this ($0.05/min) session stays open (see
   * liveDelegate.ts's runBackgroundTask), so there's no reason to keep
   * paying for GPT-Live to sit there listening to silence while it works.
   * The task keeps going in the background either way; see handleDelegation's
   * "by-the-way" handling for how its result gets announced once you're back.
   */
  const armLiveIdleTimer = useCallback(() => {
    clearLiveIdleTimer();
    const idleMs = Math.max(settingsRef.current.followUpMs || 0, 8000);
    liveIdleTimerRef.current = window.setTimeout(() => liveConnRef.current?.close(), idleMs);
  }, [clearLiveIdleTimer]);

  /**
   * Opens one persistent GPT-Live-1 WebRTC session and drives the orb/
   * transcript state off its events until it closes. `announce`, when
   * given, is for a reminder firing with nobody having said anything —
   * see the reminder-polling effect below — and gets passed through to
   * routes/live.ts so Nova speaks it the instant the session connects,
   * before waiting for the user to talk at all.
   */
  const beginCommand = useCallback(async (announce?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState("powering-on");
    try {
      const conn = await liveConnect({
        timezone: settingsRef.current.timezone || undefined,
        voice: settingsRef.current.liveVoiceName || undefined,
        announce,
        onUserTranscript: (delta) => {
          clearLiveIdleTimer();
          window.clearTimeout(liveThinkingToIdleTimerRef.current); // they're talking — definitely not idle, whatever we were about to conclude
          setState("recording");
          if (liveUserEntryIdRef.current === null) {
            const id = makeId();
            liveUserEntryIdRef.current = id;
            liveUserBufferRef.current = delta;
            setLog((l) => [...l.slice(-40), { id, role: "user", text: delta }]);
          } else {
            const id = liveUserEntryIdRef.current;
            liveUserBufferRef.current += delta;
            setLog((l) => l.map((e) => (e.id === id ? { ...e, text: e.text + delta } : e)));
          }
          // CONFIRMED BY TESTING (real feedback): saying "stop" should shut
          // Nova up and hang up immediately — not go through a full
          // Claude round trip like a normal request, which is both slow and
          // pointless for a plain "be quiet" command. Checked on every delta
          // rather than waiting for the utterance to finish, so it fires the
          // instant enough has been said to match — for a genuine one-word
          // "stop," that's essentially the whole utterance anyway.
          if (STOP_COMMAND.test(liveUserBufferRef.current.trim())) {
            liveConnRef.current?.close();
          }
        },
        onDelegating: () => {
          liveUserEntryIdRef.current = null; // that turn's transcript is complete — next delta starts a fresh bubble
          liveUserBufferRef.current = "";
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
          // sec" and the real answer. So: a short pause now only means "stop
          // growing this speech bubble" and shows "thinking" — only a bit
          // more continued silence after that is treated as actually done.
          //
          // CONFIRMED BY TESTING (real feedback): this second stage used to
          // be 20 seconds, meaning the true total time from Nova's last word
          // to the session actually closing was ~1.8s + 20s + the 8s(min)
          // idle timer below — nearly 30 seconds of billed GPT-Live time
          // after she'd clearly finished, not the "~8 seconds" the idle
          // timer's own number suggests. Cut way down: background tasks
          // don't need the live session to stay open anyway (they keep
          // running regardless — see liveDelegate.ts), so there's much less
          // reason to wait this long before even STARTING the real
          // idle-close countdown. Any further speech (or the user talking)
          // still cancels this at either stage, same as before.
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
          liveUserBufferRef.current = "";
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

  // Polls a plain HTTP endpoint (free — no GPT-Live session needed) so a
  // reminder set during a PAST session still gets spoken exactly when it's
  // due, even though that session (and the $0.05/min it was billing) is long
  // closed by then. Only fires while merely idling on the wake word
  // ("wake-listening") — never while a live session is already open (its own
  // conversation takes priority; the reminder just waits for the next poll)
  // and never while fully unplugged ("off" — the user turned Nova off on
  // purpose, so no auto-connecting behind their back).
  useEffect(() => {
    const poll = async () => {
      if (stateRef.current !== "wake-listening" || busyRef.current) return;
      const due = await fetchDueReminder();
      if (due) beginCommand(due.message);
    };
    const interval = window.setInterval(poll, 2500);
    return () => window.clearInterval(interval);
  }, [beginCommand]);

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
    taskLight,
    plugIn,
    unplug,
    beginCommand,
    orbTap,
    wakeWordSupported,
    wakeWordEngine,
    porcupineError,
  };
}
