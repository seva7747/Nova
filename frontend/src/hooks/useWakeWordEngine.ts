import { useWakeWord } from "./useWakeWord";
import { usePorcupineWakeWord } from "./usePorcupineWakeWord";

const ACCESS_KEY = import.meta.env.VITE_PICOVOICE_ACCESS_KEY ?? "";
const KEYWORD_PATH = "/nova.ppn";
const MODEL_PATH = "/porcupine_params.pv";

type Options = {
  enabled: boolean;
  onWake: () => void;
};

/**
 * Picks the best wake-word engine available and hides the choice from the
 * rest of the app: Porcupine (real, on-device, reliable) when it's actually
 * set up, the browser's speech recognizer (works everywhere, no setup, less
 * reliable) otherwise — including automatically, if Porcupine is configured
 * but fails to load for some reason (e.g. nova.ppn missing).
 */
export function useWakeWordEngine({ enabled, onWake }: Options) {
  const hasAccessKey = Boolean(ACCESS_KEY);

  const porcupine = usePorcupineWakeWord({
    enabled: enabled && hasAccessKey,
    onWake,
    accessKey: ACCESS_KEY,
    keywordPath: KEYWORD_PATH,
    modelPath: MODEL_PATH,
  });

  const porcupineUsable = hasAccessKey && !porcupine.error;
  const useBrowserFallback = !porcupineUsable;

  const browser = useWakeWord({
    enabled: enabled && useBrowserFallback,
    onWake,
  });

  if (porcupineUsable) {
    return { engine: "porcupine" as const, supported: true, ready: porcupine.ready };
  }
  return {
    engine: "browser" as const,
    supported: browser.supported,
    ready: true,
    porcupineError: hasAccessKey ? porcupine.error : undefined,
  };
}
