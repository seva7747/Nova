import { useCallback, useEffect, useState } from "react";

export type NovaSettings = {
  /** IANA timezone, e.g. "America/Chicago". Empty string = use the server's own timezone. */
  timezone: string;
  /** How long (ms) an idle live session stays open (no wake word needed) after Nova finishes talking, before hanging up. 8s minimum regardless of this value. */
  followUpMs: number;
  /**
   * Which built-in voice GPT-Live-1 speaks with. Empty = OpenAI's own
   * default. NOTE: this is unverified end-to-end — OpenAI's session-create
   * endpoint accepts the field without complaint, but changing what you
   * actually hear needs a live mic test to confirm.
   */
  liveVoiceName: string;
};

const STORAGE_KEY = "nova-settings";
const DEFAULTS: NovaSettings = { timezone: "", followUpMs: 4000, liveVoiceName: "" };

function load(): NovaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS; // private browsing, disabled storage, corrupted value, etc.
  }
}

// A tiny module-level store with pub/sub, so the settings page (which writes)
// and the conversation hook (which reads) both stay in sync without needing
// a React context provider wrapping the app.
let current: NovaSettings = load();
const listeners = new Set<(s: NovaSettings) => void>();

function commit(patch: Partial<NovaSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore write failures — the in-memory value still updates for this session */
  }
  listeners.forEach((l) => l(current));
}

export function useNovaSettings() {
  const [settings, setSettings] = useState<NovaSettings>(current);

  useEffect(() => {
    const listener = (s: NovaSettings) => setSettings(s);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback((patch: Partial<NovaSettings>) => commit(patch), []);

  return [settings, update] as const;
}
