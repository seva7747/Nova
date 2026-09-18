import { useState, type FormEvent } from "react";
import { requestCode, verifyCode } from "../lib/auth";

/**
 * Phone-number + OTP sign-in. Phone number is the actual account identity —
 * the SAME number reaches this account by texting or calling Nova's shared
 * number (see backend/src/services/voiceCallDelegate.ts / smsDelegate.ts),
 * so connecting Gmail/Calendar/etc. here makes them available on every
 * channel, not just the web app. Name is collected too, but it's purely
 * cosmetic (the NavBar greeting) — verifying the phone number is what
 * actually signs you in, not what you type as your name.
 */
export function LoginScreen() {
  const [step, setStep] = useState<"details" | "code">("details");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitDetails = async (e: FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await requestCode(phoneNumber.trim());
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setStep("code");
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const displayName = firstName.trim() && lastName.trim() ? `${firstName.trim()} ${lastName.trim()}` : undefined;
    const result = await verifyCode(phoneNumber.trim(), code.trim(), displayName);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // On success, lib/auth.ts's verifyCode already stored the session token
    // and its pub/sub notifies App.tsx, which swaps this screen out on its
    // own — nothing else to do here.
  };

  return (
    <main className="relative mx-auto flex min-h-[calc(100vh-57px)] max-w-sm flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="text-center">
        <span className="mx-auto mb-4 block h-10 w-10 rounded-full bg-gradient-to-br from-nova-cyan to-nova-violet" />
        <h1 className="text-2xl font-bold text-white">Sign in to Nova</h1>
        <p className="mt-2 text-sm text-white/50">
          {step === "details"
            ? "Your phone number is your Nova account — it's how she'll text and call you too."
            : `Enter the code we sent to ${phoneNumber.trim()}.`}
        </p>
      </div>

      {step === "details" ? (
        <form onSubmit={submitDetails} className="w-full space-y-4">
          <div className="flex gap-3">
            <input
              type="text"
              autoFocus
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-1/2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm text-white outline-none focus:border-nova-blue/50"
            />
            <input
              type="text"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-1/2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm text-white outline-none focus:border-nova-blue/50"
            />
          </div>
          <input
            type="tel"
            inputMode="tel"
            placeholder="(555) 123-4567"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm text-white outline-none focus:border-nova-blue/50"
          />
          {error && <p className="text-center text-xs text-amber-300/80">{error}</p>}
          <button
            type="submit"
            disabled={busy || !phoneNumber.trim()}
            className="w-full rounded-xl bg-gradient-to-br from-nova-cyan to-nova-violet px-4 py-2.5 text-sm font-semibold text-ink-950 transition disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode} className="w-full space-y-4">
          <input
            type="text"
            autoFocus
            inputMode="numeric"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-lg tracking-[0.4em] text-white outline-none focus:border-nova-blue/50"
          />
          {error && <p className="text-center text-xs text-amber-300/80">{error}</p>}
          <button
            type="submit"
            disabled={busy || code.trim().length < 6}
            className="w-full rounded-xl bg-gradient-to-br from-nova-cyan to-nova-violet px-4 py-2.5 text-sm font-semibold text-ink-950 transition disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("details");
              setCode("");
              setError(null);
            }}
            className="w-full text-center text-xs text-white/40 hover:text-white/70"
          >
            Use a different number
          </button>
        </form>
      )}
    </main>
  );
}
