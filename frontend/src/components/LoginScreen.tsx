import { useState, type FormEvent } from "react";
import { signIn } from "../lib/auth";

/**
 * Name-based sign-in. Nova now has more than one real user (you, your
 * cofounder, and counting) — everything (Composio connections, calendar/
 * email, the live voice session, background tasks) is keyed off the account
 * this screen produces, not a shared "demo-user" string, so connected
 * integrations no longer collide between people. Deliberately lightweight —
 * no password, no verification code, just enough to tell people apart; see
 * lib/auth.ts's signIn for the real tradeoff that makes. Rendered by App.tsx
 * in place of the whole app whenever there's no valid session.
 */
export function LoginScreen() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await signIn(firstName.trim(), lastName.trim());
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // On success, lib/auth.ts's signIn already stored the session token and
    // its pub/sub notifies App.tsx, which swaps this screen out on its own —
    // nothing else to do here.
  };

  return (
    <main className="relative mx-auto flex min-h-[calc(100vh-57px)] max-w-sm flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="text-center">
        <span className="mx-auto mb-4 block h-10 w-10 rounded-full bg-gradient-to-br from-nova-cyan to-nova-violet" />
        <h1 className="text-2xl font-bold text-white">Sign in to Nova</h1>
        <p className="mt-2 text-sm text-white/50">Your name keeps your connected accounts separate from everyone else's.</p>
      </div>

      <form onSubmit={submit} className="w-full space-y-4">
        <input
          type="text"
          autoFocus
          placeholder="First name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm text-white outline-none focus:border-nova-blue/50"
        />
        <input
          type="text"
          placeholder="Last name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-center text-sm text-white outline-none focus:border-nova-blue/50"
        />
        {error && <p className="text-center text-xs text-amber-300/80">{error}</p>}
        <button
          type="submit"
          disabled={busy || !firstName.trim() || !lastName.trim()}
          className="w-full rounded-xl bg-gradient-to-br from-nova-cyan to-nova-violet px-4 py-2.5 text-sm font-semibold text-ink-950 transition disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </main>
  );
}
