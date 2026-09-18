import { useEffect, useState } from "react";
import { API_BASE } from "./env";

export type AuthState = { token: string; userId: string; displayName: string } | null;

const STORAGE_KEY = "nova-auth";

function load(): AuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private browsing, disabled storage, corrupted value, etc.
  }
}

// Same module-level store + pub/sub pattern as useNovaSettings.ts, so every
// consumer (NavBar's logout button, the login gate in App.tsx, api.ts's auth
// header helper) stays in sync without a context provider.
let current: AuthState = load();
const listeners = new Set<(s: AuthState) => void>();

function commit(next: AuthState) {
  current = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore write failures — the in-memory value still updates for this session */
  }
  listeners.forEach((l) => l(current));
}

/** Read the current session token outside of React (for api.ts's fetch calls). */
export function getToken(): string | null {
  return current?.token ?? null;
}

/** Spread into a fetch's `headers` — empty object when logged out, so callers don't need to branch. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Subscribes a component to the current login state. Null = logged out. */
export function useAuth() {
  const [auth, setAuth] = useState<AuthState>(current);
  useEffect(() => {
    listeners.add(setAuth);
    return () => {
      listeners.delete(setAuth);
    };
  }, []);
  return auth;
}

/**
 * Signs in with just a first + last name — no password, no verification
 * step. Creates the account on first use; the same name always returns to
 * the same account (see backend/src/services/auth.ts's signIn for the real
 * tradeoff this makes — good enough to tell people apart and keep connected
 * integrations separate, not real security).
 */
export async function signIn(firstName: string, lastName: string): Promise<{ error?: string }> {
  try {
    const resp = await fetch(`${API_BASE}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName }),
    });
    const data = await resp.json();
    if (!resp.ok) return { error: data?.error ?? "Couldn't sign in." };
    commit({ token: data.token, userId: data.userId, displayName: data.displayName });
    return {};
  } catch {
    return { error: "Nova's backend isn't reachable — is it running on port 8787?" };
  }
}

export function logout() {
  const token = getToken();
  commit(null);
  if (token) {
    // Best-effort — the client-side session is already cleared either way.
    fetch(`${API_BASE}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
}

/**
 * Confirms a token restored from localStorage is still valid (not expired,
 * not revoked) rather than trusting it forever — call once on app start.
 * Also refreshes the stored display name in case it changed elsewhere.
 * Left alone on a network error (offline shouldn't look like logged-out).
 */
export async function validateStoredSession() {
  const token = getToken();
  if (!token) return;
  try {
    const resp = await fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      commit(null);
      return;
    }
    const data = await resp.json();
    if (current) commit({ ...current, displayName: data?.displayName ?? current.displayName });
  } catch {
    /* offline — keep the token, don't log the user out just because we couldn't check */
  }
}
