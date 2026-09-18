import { useEffect, useRef, useState } from "react";

type Options = {
  wakeWord?: string;
  enabled: boolean;
  onWake: () => void;
};

/** Cheap edit distance so slightly-misheard words ("novah", "nover") still trigger. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Generic web speech recognition was built for dictation, not for spotting a
 * single short trigger word — it regularly mishears "Nova" as "over", splits
 * it into two or three syllable-tokens, or garbles it entirely. A strict
 * transcript.includes("nova") check misses a lot of that. This instead:
 *  1. Checks every word, adjacent word PAIR, and adjacent word TRIPLE
 *     (concatenated) within edit distance 2 of "nova" — catches it whether
 *     the recognizer heard it as one word, two syllables, or three.
 */
function containsWakeWord(transcript: string, wakeWord: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const isClose = (candidate: string) => levenshtein(candidate, wakeWord) <= 2;

  for (let i = 0; i < words.length; i++) {
    if (isClose(words[i])) return true;
    if (i + 1 < words.length && isClose(words[i] + words[i + 1])) return true;
    if (i + 2 < words.length && isClose(words[i] + words[i + 1] + words[i + 2])) return true;
  }
  return false;
}

/**
 * Listens continuously with the browser's built-in speech recognition
 * (Web Speech API — free, no server round trip) for the wake word. This is
 * a simpler stand-in for what a real device does with an always-on,
 * on-device wake-word model (e.g. Picovoice Porcupine) — it's noticeably
 * less reliable than that (it's cloud dictation repurposed as a keyword
 * spotter, not built for the job), but needs zero extra setup or API keys.
 *
 * Reliability fixes beyond the basic restart-on-end loop:
 *  1. Fuzzy word/pair/triple matching (see containsWakeWord), loosened to
 *     edit-distance 2 across the board — favors catching real triggers over
 *     rejecting the occasional false one.
 *  2. A JSGF SpeechGrammarList biasing recognition toward "nova" / "hey nova"
 *     when the browser supports it (Chrome does) — this is a real, if
 *     under-documented, part of the Web Speech API for exactly this case:
 *     nudging the recognizer's language model toward specific phrases.
 *  3. Real recognition errors force an immediate restart instead of waiting.
 *  4. A proactive restart every 8 seconds regardless of activity — Chrome's
 *     continuous-mode recognizer is known to gradually degrade the longer a
 *     single session runs, well before it errors or goes silent; periodic
 *     fresh restarts are a known community workaround.
 *  5. A watchdog force-restarts recognition if nothing's been heard in 12s,
 *     as a backstop for the rarer case where it goes silently unresponsive.
 *
 * Saying "Hey Nova" instead of just "Nova" also genuinely helps: two words
 * give the recognizer far more phonetic context than one short word alone.
 *
 * Only Chrome/Edge support this today (`webkitSpeechRecognition`) — the
 * `supported` flag lets the UI fall back to a "type instead" input on other
 * browsers such as Firefox or Safari.
 */
export function useWakeWord({ wakeWord = "nova", enabled, onWake }: Options) {
  const recognitionRef = useRef<any>(null);
  const enabledRef = useRef(enabled);
  const onWakeRef = useRef(onWake);
  const watchdogRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastResultAtRef = useRef(Date.now());
  const [supported, setSupported] = useState(true);

  enabledRef.current = enabled;
  onWakeRef.current = onWake;

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 3;

    // Bias the recognizer toward the phrases we actually care about. Support
    // is inconsistent across browsers (mainly Chrome), so this is wrapped
    // defensively — it's a bonus when it works, a no-op when it doesn't.
    const SpeechGrammarList = (window as any).SpeechGrammarList || (window as any).webkitSpeechGrammarList;
    if (SpeechGrammarList) {
      try {
        const grammar = `#JSGF V1.0; grammar wakeword; public <wakeword> = hey nova | ok nova | okay nova | nova;`;
        const list = new SpeechGrammarList();
        list.addFromString(grammar, 1);
        recognition.grammars = list;
      } catch {
        /* not supported on this browser build — fine, matching still works without it */
      }
    }

    recognition.onresult = (event: any) => {
      lastResultAtRef.current = Date.now();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Check every alternative transcript the recognizer offers, not just
        // its top guess — "nova" is short enough that the correct hearing is
        // sometimes ranked second or third.
        for (let a = 0; a < result.length; a++) {
          const transcript = String(result[a]?.transcript || "");
          if (containsWakeWord(transcript, wakeWord)) {
            onWakeRef.current();
            return;
          }
        }
      }
    };

    recognition.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      console.warn("[wake word] recognition error:", e.error);
      // Real errors (network hiccup, audio-capture glitch, etc.) don't
      // always trigger onend on their own — force a restart rather than
      // silently sitting there not listening until the watchdog notices.
      if (enabledRef.current) {
        try {
          recognition.stop();
          recognition.start();
        } catch {
          /* already in the desired state */
        }
      }
    };

    // Chrome auto-stops recognition after periods of silence even with
    // continuous:true — restart it for as long as we're supposed to be
    // listening.
    recognition.onend = () => {
      if (enabledRef.current) {
        try {
          recognition.start();
        } catch {
          /* already starting — ignore */
        }
      }
    };

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* ignore */
      }
    };
  }, [wakeWord]);

  // Proactive refresh: restart every 8s regardless of whether anything went
  // wrong. Continuous Chrome recognition sessions are known to quietly get
  // less responsive the longer they run — a cheap restart keeps it fresh.
  useEffect(() => {
    if (!enabled) return;
    refreshTimerRef.current = window.setInterval(() => {
      try {
        recognitionRef.current?.stop(); // onend handler restarts it
      } catch {
        /* ignore */
      }
    }, 8000);
    return () => {
      if (refreshTimerRef.current) window.clearInterval(refreshTimerRef.current);
    };
  }, [enabled]);

  // Watchdog backstop: if we haven't heard anything in a while (the silent-
  // hang case, distinct from the proactive refresh above), force a restart.
  useEffect(() => {
    if (!enabled) return;
    lastResultAtRef.current = Date.now();
    watchdogRef.current = window.setInterval(() => {
      const idleFor = Date.now() - lastResultAtRef.current;
      if (idleFor > 12000) {
        lastResultAtRef.current = Date.now();
        try {
          recognitionRef.current?.stop();
        } catch {
          /* ignore */
        }
      }
    }, 5000);
    return () => {
      if (watchdogRef.current) window.clearInterval(watchdogRef.current);
    };
  }, [enabled]);

  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (enabled) {
      try {
        recognition.start();
      } catch {
        /* already running */
      }
    } else {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    }
  }, [enabled]);

  return { supported };
}
