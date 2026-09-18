import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNovaSettings } from "../hooks/useNovaSettings";
import { fetchHealth } from "../lib/api";
import { Footer } from "../components/Footer";

const FALLBACK_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function getTimezoneOptions(): string[] {
  try {
    if (typeof (Intl as any).supportedValuesOf === "function") {
      return (Intl as any).supportedValuesOf("timeZone");
    }
  } catch {
    /* fall through to the curated list */
  }
  return FALLBACK_TIMEZONES;
}

function SectionCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="w-full rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
      <h2 className="font-semibold text-white mb-1">{title}</h2>
      <p className="text-sm text-white/45 mb-6">{description}</p>
      {children}
    </section>
  );
}

function SavedFlash({ show }: { show: boolean }) {
  return (
    <span className={`text-xs text-nova-cyan transition-opacity duration-500 ${show ? "opacity-100" : "opacity-0"}`}>
      Saved
    </span>
  );
}

export function SettingsPage() {
  const [settings, updateSettings] = useNovaSettings();
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [liveVoiceConfigured, setLiveVoiceConfigured] = useState<boolean | null>(null);

  const timezoneOptions = useMemo(getTimezoneOptions, []);
  const detectedTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    fetchHealth().then((h) => setLiveVoiceConfigured(h?.configured.liveVoice ?? false));
  }, []);

  const flash = (field: string) => {
    setSavedFlash(field);
    window.setTimeout(() => setSavedFlash((f) => (f === field ? null : f)), 1500);
  };

  return (
    <>
      <main className="relative mx-auto flex max-w-3xl flex-col items-center gap-8 px-4 py-16">
        <div className="max-w-lg text-center">
          <h1 className="text-3xl font-bold text-white">Settings</h1>
          <p className="mt-2 text-sm text-white/50">
            Changes save instantly to this browser and apply to your very next question — no need to unplug Nova.
          </p>
        </div>

        <SectionCard
          title="Nova's voice"
          description="Which of OpenAI's built-in voices GPT-Live-1 speaks with."
        >
          {liveVoiceConfigured === false ? (
            <p className="text-xs text-amber-300/70">
              OPENAI_API_KEY isn't set on the backend yet — add it to backend/.env. Nova can't hear or speak at all
              without it.
            </p>
          ) : (
            <>
              <p className="text-xs text-white/40 mb-2">
                Unverified — OpenAI's API accepts this setting without complaint, but I haven't been able to confirm
                it actually changes what you hear (needs a live mic test). Try it and let me know.
              </p>
              <select
                value={settings.liveVoiceName}
                onChange={(e) => {
                  updateSettings({ liveVoiceName: e.target.value });
                  flash("liveVoiceName");
                }}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white outline-none focus:border-nova-blue/50"
              >
                <option value="">OpenAI default</option>
                {["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <div className="flex justify-end pt-2">
                <SavedFlash show={savedFlash === "liveVoiceName"} />
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard
          title="Timezone"
          description={`Used to resolve things like "this Thursday at 4." Your browser reports ${detectedTimezone} — leave on Auto to just use that.`}
        >
          <select
            value={settings.timezone}
            onChange={(e) => {
              updateSettings({ timezone: e.target.value });
              flash("timezone");
            }}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white outline-none focus:border-nova-blue/50"
          >
            <option value="">Auto ({detectedTimezone})</option>
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <div className="flex justify-end pt-2">
            <SavedFlash show={savedFlash === "timezone"} />
          </div>
        </SectionCard>

        <SectionCard
          title="Follow-up listening"
          description="How long a live session stays open, listening with no wake word needed, after Nova finishes talking with nobody responding — before she hangs up (an 8-second minimum always applies, since a live session bills $0.05/minute open, separate from Claude/Composio usage)."
        >
          <select
            value={settings.followUpMs}
            onChange={(e) => {
              updateSettings({ followUpMs: Number(e.target.value) });
              flash("followup");
            }}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white outline-none focus:border-nova-blue/50"
          >
            <option value={0}>Off (8s minimum still applies)</option>
            <option value={8000}>8 seconds</option>
            <option value={10000}>10 seconds</option>
            <option value={15000}>15 seconds</option>
            <option value={20000}>20 seconds</option>
          </select>
          <div className="flex justify-end pt-2">
            <SavedFlash show={savedFlash === "followup"} />
          </div>
        </SectionCard>
      </main>
      <Footer />
    </>
  );
}
