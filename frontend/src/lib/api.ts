import { API_BASE } from "./env";
import { authHeaders } from "./auth";

export { API_BASE };

export async function fetchIntegrationStatus() {
  const resp = await fetch(`${API_BASE}/api/integrations/status`, { headers: authHeaders() });
  return resp.json();
}

export type ConnectField = { name: string; displayName: string; description?: string; isSecret: boolean };
export type ConnectResult =
  | { redirectUrl: string }
  | { needsCredentials: true; scheme: string; fields: ConnectField[] }
  | { error: string };

/** Starts connecting a toolkit — backend decides whether it's one-click OAuth or needs a credentials form (see ConnectResult). */
export async function connectIntegration(toolkit: string): Promise<ConnectResult> {
  const resp = await fetch(`${API_BASE}/api/integrations/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ toolkit }),
  });
  return resp.json();
}

/** Completes a "needsCredentials" connection with the user's typed-in values — no OAuth redirect. */
export async function connectIntegrationWithCredentials(
  toolkit: string,
  scheme: string,
  credentials: Record<string, string>
): Promise<{ success?: true; error?: string }> {
  const resp = await fetch(`${API_BASE}/api/integrations/connect-with-credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ toolkit, scheme, credentials }),
  });
  return resp.json();
}

export type CatalogEntry = { slug: string; name: string; logo?: string; description?: string };
export type CatalogPage = { items: CatalogEntry[]; nextCursor: string | null };

/** Browses (query="") or searches Composio's full ~1,500-toolkit catalog, cursor-paginated — not limited to the hand-picked cards. Public — no login needed just to browse. */
export async function fetchConnectorCatalog(query: string, cursor?: string): Promise<CatalogPage> {
  try {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query);
    if (cursor) params.set("cursor", cursor);
    const resp = await fetch(`${API_BASE}/api/integrations/catalog?${params.toString()}`);
    if (!resp.ok) return { items: [], nextCursor: null };
    return await resp.json();
  } catch {
    return { items: [], nextCursor: null };
  }
}

export type NovaHealth = {
  ok: boolean;
  configured: { brain: boolean; composio: boolean; liveVoice: boolean; twilio: boolean };
};

export async function fetchHealth(): Promise<NovaHealth | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/health`);
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

/** `active` = a task is running (yellow); `done` = one finished and Nova hasn't mentioned it yet (green). */
export type TaskStatus = {
  active: boolean;
  runningCount?: number;
  description?: string;
  actionsCompleted?: number;
  done?: boolean;
  result?: string;
};

/** Polled while plugged in to drive the "working on something big" orb state — see backend/src/services/tasks.ts. */
export async function fetchTaskStatus(): Promise<TaskStatus | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/tasks/status`, { headers: authHeaders() });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

/** Marks a finished background task as announced backend-side — call this right after proactively speaking its result, so the older reactive "Done — " mention (see liveDelegate.ts) never repeats it. */
export async function markTasksAnnounced(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/tasks/mark-announced`, { method: "POST", headers: authHeaders() });
  } catch {
    // best-effort — worst case the same result gets mentioned once more reactively later
  }
}

/** Polled while plugged in so a reminder set during a past session still gets spoken exactly when due — see backend/src/services/reminders.ts. Each due reminder is only ever returned once (the backend marks it delivered on the way out). */
export async function fetchDueReminder(): Promise<{ message: string } | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/reminders/due`, { headers: authHeaders() });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.due ?? null;
  } catch {
    return null;
  }
}
