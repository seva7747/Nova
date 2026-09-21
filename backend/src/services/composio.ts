import { env } from "../config.js";

/**
 * Composio integration.
 *
 * NOTE ON STABILITY: Composio's TypeScript SDK (v3 — `@composio/core` plus a
 * provider package like `@composio/openai`) is what most of this file
 * targets, and the method names below (`tools.get`, `tools.execute`,
 * `connectedAccounts.list`) reflect their documented shape as of early 2026.
 * Composio evolves this SDK fairly often — if you see a "X is not a
 * function" error pointing at this file, check https://docs.composio.dev
 * (Providers → OpenAI, and the core SDK reference) for the current method
 * names and adjust the calls below. Everything else in Nova (weather, sports,
 * outbound calling) keeps working even if this integration breaks.
 *
 * initiateConnection() below is the one exception — it was ported OFF the
 * SDK entirely (raw REST) after the pinned SDK version's equivalent method
 * turned out to call an endpoint Composio has since deprecated. See its own
 * comment for details. If tools.get/execute/connectedAccounts.list ever
 * break the same way, the fix is the same: check what the SDK's method
 * actually calls against docs.composio.dev/reference/v3, and port that one
 * function to composioFetch() too rather than upgrading the whole SDK blind.
 */

let clientPromise: Promise<any> | null = null;

async function getClient(): Promise<any | null> {
  if (!env.COMPOSIO_API_KEY) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Composio } = await import("@composio/core");
      // OpenAIProvider, not AnthropicProvider — Nova's brain runs on OpenAI's
      // Responses API now (gpt-4.1-mini, see llm.ts), and Composio shapes
      // tool schemas differently per provider. This returns the
      // Chat-Completions-style {type:"function", function:{name,description,
      // parameters}} shape, which llm.ts's toResponsesTool() flattens into
      // the Responses API's own {type:"function", name, description,
      // parameters} shape (no nested "function" wrapper) before use.
      const { OpenAIProvider } = await import("@composio/openai");
      return new Composio({
        apiKey: env.COMPOSIO_API_KEY,
        provider: new OpenAIProvider(),
      });
    })();
  }
  return clientPromise;
}

// Tool schemas rarely change between requests, but fetching them from
// Composio costs a real network round trip (~600-1000ms measured) — paying
// that on *every single turn* was a big, pointless chunk of Nova's latency.
// Cache per (userId, toolkits) combo: 5 minutes on success, 1 minute on
// failure (so a fixed API key gets picked up again reasonably soon instead
// of being retried, and re-failing, on every turn).
type ToolsCacheEntry = { tools: any[]; expiresAt: number };
const toolsCache = new Map<string, ToolsCacheEntry>();
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

// CONFIRMED BY TESTING: fetching a toolkit "whole" (client.tools.get({toolkits}))
// pulls in EVERY tool Composio has for it — Gmail alone is 62, Calendar ~51,
// and the 6 newer toolkits' full catalogs run the grand total past 400, most
// of them obscure (Slack emoji management, Spotify "check saved audiobooks,"
// etc.) that Nova will never need and that only slow down every turn and
// increase the odds Claude picks the wrong one. Every toolkit — including
// Gmail/Calendar, which this used to fetch "whole" — is hand-picked down here
// to a handful of tools that actually cover what someone would ask Nova for.
const CURATED_TOOLS: Record<string, string[]> = {
  // GMAIL_FETCH_EMAILS is deliberately excluded — Claude uses the
  // purpose-built search_gmail tool instead (see tools/gmailSearch.ts),
  // which wraps this exact Composio tool but does the date-range and
  // received/sent-filter logic in code instead of leaving it to the model.
  GMAIL: [
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_SEND_EMAIL",
    "GMAIL_CREATE_EMAIL_DRAFT",
    "GMAIL_REPLY_TO_THREAD",
    "GMAIL_DELETE_MESSAGE",
    "GMAIL_ADD_LABEL_TO_EMAIL",
  ],
  // GOOGLECALENDAR_CREATE_EVENT / QUICK_ADD are deliberately excluded —
  // Claude uses the purpose-built add_calendar_event tool instead (see
  // tools/calendarEvent.ts), which wraps CREATE_EVENT but checks for an
  // existing same-titled event on that date first, to avoid duplicates.
  GOOGLECALENDAR: [
    "GOOGLECALENDAR_EVENTS_LIST",
    "GOOGLECALENDAR_UPDATE_EVENT",
    "GOOGLECALENDAR_DELETE_EVENT",
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
  ],
  GOOGLEDRIVE: ["GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_PARSE_FILE", "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT"],
  SLACK: ["SLACK_CHAT_POST_MESSAGE", "SLACK_FETCH_CONVERSATION_HISTORY", "SLACK_LIST_ALL_CHANNELS"],
  NOTION: ["NOTION_SEARCH_NOTION_PAGE", "NOTION_CREATE_NOTION_PAGE", "NOTION_ADD_PAGE_CONTENT"],
  TODOIST: ["TODOIST_CREATE_TASK", "TODOIST_GET_ALL_TASKS", "TODOIST_CLOSE_TASK", "TODOIST_GET_ALL_PROJECTS"],
  // WhatsApp's Business API (what Composio's toolkit wraps) can only SEND —
  // Meta doesn't expose a personal-inbox read API to third parties, so
  // there's no equivalent of Gmail's "check my messages" here. Intentional,
  // not a gap to fill later.
  WHATSAPP: ["WHATSAPP_SEND_MESSAGE"],
  SPOTIFY: [
    "SPOTIFY_SEARCH",
    "SPOTIFY_START_RESUME_PLAYBACK",
    "SPOTIFY_PAUSE_PLAYBACK",
    "SPOTIFY_SKIP_TO_NEXT",
    "SPOTIFY_ADD_ITEM_TO_PLAYBACK_QUEUE",
  ],
  // CONFIRMED BY TESTING: Canvas's toolkit has 500+ tools (mostly admin CRUD
  // — creating quizzes, deleting gradebook columns, managing LTI tools, etc.)
  // returned in roughly alphabetical order, so the DYNAMIC_TOOLS_PER_TOOLKIT
  // cap (12) below was cutting off before any tool a student actually wants
  // — the first 12 alphabetically were things like ABORT_QUIZ_REPORT and
  // ADD_COURSE_TO_FAVORITES. Nova genuinely could not see a way to list
  // courses, assignments, or grades even though the account was connected
  // and active — this is why it said it "can't see" Canvas. Curated down to
  // what a student would actually ask Nova for; verified each of these
  // resolves via tools.get AND returns real data when executed against a
  // live connected account (a real course, a real todo item due today).
  CANVAS: [
    "CANVAS_GET_CURRENT_USER",
    "CANVAS_LIST_COURSES",
    "CANVAS_GET_SINGLE_COURSE",
    "CANVAS_LIST_ASSIGNMENTS_FOR_USER",
    "CANVAS_LIST_MISSING_SUBMISSIONS",
    "CANVAS_LIST_TODO_ITEMS",
    "CANVAS_LIST_UPCOMING_ASSIGNMENTS_CALENDAR_EVENTS",
    "CANVAS_LIST_PLANNER_ITEMS",
    "CANVAS_GET_A_USERS_MOST_RECENTLY_GRADED",
    "CANVAS_GET_SINGLE_SUBMISSION",
    "CANVAS_LIST_USER_ENROLLMENTS",
    "CANVAS_LIST_ANNOUNCEMENTS",
  ],
};

// How many tools to auto-fetch for a connected toolkit we haven't
// hand-curated. Composio has ~1,500 toolkits — hand-picking each one the way
// Gmail/Calendar/etc. are below doesn't scale, and most of them can't even
// be tested here since nobody's connected an account for them. This cap is
// what keeps that scale safe: total tool volume is bounded by how many
// EXTRA services a given user actually connects (realistically a handful),
// not by the size of Composio's whole catalog — connecting doesn't expose
// anything until the user deliberately does it via real OAuth.
const DYNAMIC_TOOLS_PER_TOOLKIT = 12;

/**
 * Fetch tool definitions (already shaped for Anthropic's tool-use API) for
 * whichever toolkits this user actually has an ACTIVE connection for —
 * driven by getAccountsByToolkit, not a fixed list — so connecting any new
 * toolkit through the catalog browser (routes/integrations.ts's /catalog
 * endpoint) makes it usable immediately, no code change needed. Toolkits
 * with a hand-curated entry above use that (reliable, tuned against real
 * bugs); anything else gets a capped, un-curated fetch.
 */
export async function getComposioTools(userId: string): Promise<any[]> {
  const client = await getClient();
  if (!client) return [];

  const accountsByToolkit = await getAccountsByToolkit(userId);
  const connectedSlugs = Object.keys(accountsByToolkit).map((s) => s.toUpperCase());
  if (connectedSlugs.length === 0) return [];

  const cacheKey = `${userId}::${[...connectedSlugs].sort().join(",")}`;
  const cached = toolsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  try {
    const curatedSlugs = connectedSlugs.filter((t) => CURATED_TOOLS[t]);
    const dynamicSlugs = connectedSlugs.filter((t) => !CURATED_TOOLS[t]);
    const curatedToolNames = curatedSlugs.flatMap((t) => CURATED_TOOLS[t]);

    // CONFIRMED BY TESTING: tools.get() silently caps at 20 results when no
    // `limit` is passed — with no error or warning. Before this file curated
    // specific tool slugs, it fetched Gmail+Calendar "whole" (113 tools
    // combined) and that default cap meant EVERY GOOGLECALENDAR_* tool and
    // even GMAIL_SEND_EMAIL never made it into the list Claude saw — Gmail
    // could only ever be read, never sent from, and calendar scheduling never
    // worked at all. Not a regression from curation work — it was silently
    // broken from the start. Both calls below pass an explicit limit for
    // exactly this reason.
    const [curatedTools, dynamicTools] = await Promise.all([
      curatedToolNames.length > 0 ? client.tools.get(userId, { tools: curatedToolNames, limit: 100 }) : [],
      dynamicSlugs.length > 0
        ? client.tools.get(userId, { toolkits: dynamicSlugs, limit: dynamicSlugs.length * DYNAMIC_TOOLS_PER_TOOLKIT })
        : [],
    ]);

    const combined = [...(Array.isArray(curatedTools) ? curatedTools : []), ...(Array.isArray(dynamicTools) ? dynamicTools : [])];
    const list = await patchMultiAccountTools(combined, userId);
    toolsCache.set(cacheKey, { tools: list, expiresAt: Date.now() + SUCCESS_TTL_MS });
    return list;
  } catch (err: any) {
    console.error(
      "[composio] failed to fetch tools — Composio-backed tools unavailable this turn:",
      err?.error?.message ?? err?.message ?? err
    );
    toolsCache.set(cacheKey, { tools: [], expiresAt: Date.now() + FAILURE_TTL_MS });
    return [];
  }
}

export type CatalogEntry = { slug: string; name: string; logo?: string; description?: string };
export type CatalogPage = { items: CatalogEntry[]; nextCursor: string | null };

/**
 * Browses (or, with `query`, searches) Composio's full toolkit catalog —
 * confirmed 1,543 toolkits at last check — cursor-paginated, so the
 * Connectors page can show a real "browse everything" list plus live search,
 * not just whatever we've hand-curated. With no query, results come back in
 * Composio's own default order, which put familiar names (Gmail, GitHub,
 * Calendar, Notion, Slack...) first in testing — reasonable as a default
 * browse order.
 */
export async function getToolkitCatalog(query: string, cursor?: string): Promise<CatalogPage> {
  if (!env.COMPOSIO_API_KEY) return { items: [], nextCursor: null };
  const params = new URLSearchParams({ limit: "30" });
  if (query.trim()) params.set("search", query.trim());
  if (cursor) params.set("cursor", cursor);
  const data = await composioFetch(`/toolkits?${params.toString()}`);
  const items: CatalogEntry[] = (data?.items ?? []).map((t: any) => ({
    slug: String(t.slug ?? "").toUpperCase(),
    name: t.name ?? t.slug,
    logo: t.meta?.logo ?? t.logo,
    description: t.meta?.description,
  }));
  return { items, nextCursor: data?.next_cursor ?? null };
}

/**
 * Run a Composio tool (e.g. GMAIL_SEND_EMAIL) on the user's connected account.
 * `connectedAccountId` is a normal argument as far as Claude's tool-calling is
 * concerned (see patchMultiAccountTools) but isn't part of the real tool's
 * input — pull it out here and pass it as Composio's own execute option
 * instead of forwarding it as a tool argument.
 */
export async function executeComposioTool(userId: string, toolName: string, args: Record<string, unknown>) {
  const client = await getClient();
  if (!client) {
    throw new Error("That integration isn't set up yet — add COMPOSIO_API_KEY to backend/.env and connect an account.");
  }
  const { connectedAccountId, ...toolArgs } = args as Record<string, unknown> & { connectedAccountId?: string };
  return client.tools.execute(toolName, {
    userId,
    arguments: toolArgs,
    ...(connectedAccountId ? { connectedAccountId } : {}),
  });
}

// ── Multi-account support ───────────────────────────────────────────────────
// A user can connect more than one account for the same toolkit (two Gmail
// addresses, say). Composio's tools otherwise silently default to "the first
// connected account" — which is exactly as confusing as it sounds when a
// second one exists — so we detect that case and give Nova what she needs to
// ask "which one?" instead: a human-readable label per account, and an
// explicit connectedAccountId input patched onto that toolkit's tools so
// Claude can target the one the user actually meant.

export type ConnectedAccountSummary = { id: string; label: string };

// Toolkits where we know how to resolve a real identity (e.g. an email
// address) for a connected account, and which tool to call for it. Anything
// not listed here still works for disambiguation — it just falls back to a
// generic "Account 1" / "Account 2" label instead of the real address. Add an
// entry whenever a new multi-account-capable toolkit is added below.
const ACCOUNT_LABEL_TOOL: Record<string, string> = {
  gmail: "GMAIL_GET_PROFILE",
};

const labelCache = new Map<string, string>(); // connectedAccountId -> resolved label — effectively permanent, an account's identity doesn't change

async function resolveAccountLabel(connectedAccountId: string, toolkitSlug: string, userId: string, fallback: string): Promise<string> {
  const cached = labelCache.get(connectedAccountId);
  if (cached) return cached;

  const toolName = ACCOUNT_LABEL_TOOL[toolkitSlug];
  if (!toolName) return fallback;

  try {
    const client = await getClient();
    if (!client) return fallback;
    const result: any = await client.tools.execute(toolName, { userId, arguments: {}, connectedAccountId });
    // CONFIRMED BY TESTING: Composio's actual response now nests the real
    // payload one level deeper, under response_data (data.response_data.
    // emailAddress) — data.emailAddress directly (this function's original
    // shape) no longer matches anything, so this was silently falling back
    // to "Account 1"/"Account 2" instead of a real email address. Checking
    // both shapes so this survives if Composio moves it back.
    const email =
      result?.data?.response_data?.emailAddress ?? result?.data?.emailAddress ?? result?.data?.email ?? result?.emailAddress;
    if (typeof email === "string" && email) {
      labelCache.set(connectedAccountId, email);
      return email;
    }
  } catch (err: any) {
    console.error(`[composio] couldn't resolve a label for account ${connectedAccountId}:`, err?.error?.message ?? err?.message ?? err);
  }
  return fallback;
}

type AccountsCacheEntry = { data: Record<string, ConnectedAccountSummary[]>; expiresAt: number };
const accountsCache = new Map<string, AccountsCacheEntry>();
const ACCOUNTS_TTL_MS = 60 * 1000; // short — a user actively connecting a second account mid-session should see it show up quickly

/**
 * ACTIVE connected accounts for a user, grouped by toolkit slug, each with a
 * resolved human-friendly label. `skipCache` bypasses the read (but still
 * refreshes the cache afterward) — CONFIRMED BY TESTING this matters: the
 * Connectors page polls this every 5s right after opening an OAuth tab so it
 * notices a new connection without a manual refresh, but the FIRST poll
 * fires before the user has even finished authorizing, caching an empty
 * result for a full 60s — every later poll in that same polling window then
 * returned that same stale "not connected" regardless of the real state,
 * making a successful connection look like it silently failed. The 60s cache
 * still matters a lot for the OTHER caller (getComposioTools, hit on every
 * single conversation turn) — this only bypasses it for the one place a
 * fresh answer is worth the extra Composio call.
 */
export async function getAccountsByToolkit(userId: string, skipCache = false): Promise<Record<string, ConnectedAccountSummary[]>> {
  const cached = accountsCache.get(userId);
  if (!skipCache && cached && cached.expiresAt > Date.now()) return cached.data;

  const all = await listConnections(userId);
  const active = all.filter((c: any) => String(c.status ?? "").toUpperCase() === "ACTIVE");

  const grouped = new Map<string, any[]>();
  for (const c of active) {
    const slug = String(c.toolkit?.slug ?? "").toLowerCase();
    if (!slug) continue;
    if (!grouped.has(slug)) grouped.set(slug, []);
    grouped.get(slug)!.push(c);
  }

  const result: Record<string, ConnectedAccountSummary[]> = {};
  for (const [slug, accounts] of grouped) {
    result[slug] = await Promise.all(
      accounts.map((c, i) => resolveAccountLabel(c.id, slug, userId, `Account ${i + 1}`).then((label) => ({ id: c.id, label })))
    );
  }

  accountsCache.set(userId, { data: result, expiresAt: Date.now() + ACCOUNTS_TTL_MS });
  return result;
}

/** Adds an optional `connectedAccountId` input to every tool belonging to a toolkit that has more than one connected account, so Claude has a normal way to target a specific one. */
async function patchMultiAccountTools(tools: any[], userId: string): Promise<any[]> {
  const accountsByToolkit = await getAccountsByToolkit(userId).catch(() => ({}));
  const multiAccountSlugs = Object.entries(accountsByToolkit)
    .filter(([, accounts]) => accounts.length > 1)
    .map(([slug]) => slug.toUpperCase());

  if (multiAccountSlugs.length === 0) return tools;

  return tools.map((tool: any) => {
    const belongsToMultiAccountToolkit = multiAccountSlugs.some((slug) => String(tool.name ?? "").toUpperCase().startsWith(slug));
    if (!belongsToMultiAccountToolkit) return tool;
    return {
      ...tool,
      input_schema: {
        ...tool.input_schema,
        properties: {
          ...tool.input_schema?.properties,
          connectedAccountId: {
            type: "string",
            description:
              "Which connected account to use — the user has more than one for this service (see the account list in your instructions). Ask the user which one if it isn't already clear, then pass that account's id here.",
          },
        },
      },
    };
  });
}

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";

/** Raw REST call against Composio's v3 API, with the same 401/wrong-key-type diagnosis on every call site. */
async function composioFetch(path: string, init: RequestInit = {}): Promise<any> {
  const resp = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: { "x-api-key": env.COMPOSIO_API_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const raw = body?.error?.message ?? JSON.stringify(body);
    if (resp.status === 401) {
      // CONFIRMED BY TESTING: Composio has two differently-prefixed keys that
      // are easy to grab the wrong one of, and a wrong-TYPE key fails with
      // the exact same generic "Invalid API key" as a wrong-VALUE key — ck_
      // (a "Connect consumer key", for MCP sessions) vs ak_ (the "Project API
      // key", Developer dashboard → Project Settings → API Keys, which is
      // what server-side calls like this one actually need).
      const hint = env.COMPOSIO_API_KEY.startsWith("ck_")
        ? " That key starts with \"ck_\" — that's a Connect CONSUMER key, not a Project API key. You need the one that starts with \"ak_\", from the Developer dashboard → Project Settings → API Keys (not the Connect dashboard)."
        : " Get a fresh key from composio.dev → Developer dashboard → Project Settings → API Keys and update backend/.env.";
      throw new Error(`Composio rejected the request — COMPOSIO_API_KEY in backend/.env is invalid or the wrong key type (raw error: "${raw}").${hint}`);
    }
    throw new Error(`Composio API error (${resp.status}): ${raw}`);
  }
  return body;
}

// ── Connecting a toolkit — two different paths ──────────────────────────────
// CONFIRMED BY TESTING: not every toolkit supports Composio-managed OAuth —
// Alpaca, for one, has NO managed auth for either of its two schemes (OAuth2,
// which needs a developer's own registered app, or a plain API key). Trying
// the managed-OAuth flow against it 404s with "Composio does not have
// managed credentials for this toolkit" — that's Composio accurately
// reporting a real limitation, not a bug to route around. What we CAN do
// instead, confirmed working end-to-end: when a toolkit's only real option
// is a plain API key (or similar bare credential, no OAuth redirect needed
// at all), create a "custom" (not managed) auth config for that scheme and
// let the user type the actual key in directly — no browser redirect,
// active immediately.

export type ConnectOptions =
  | { mode: "oauth" }
  | { mode: "credentials"; scheme: string; fields: Array<{ name: string; displayName: string; description?: string; isSecret: boolean }> }
  | { mode: "unsupported"; reason: string };

/** Figures out how a given toolkit can actually be connected — Composio-managed one-click OAuth, a direct-credential form, or neither. */
export async function getConnectOptions(toolkitSlug: string): Promise<ConnectOptions> {
  const detail = await composioFetch(`/toolkits/${encodeURIComponent(toolkitSlug.toLowerCase())}`);
  const managedSchemes: string[] = detail?.composio_managed_auth_schemes ?? [];
  if (managedSchemes.length > 0) return { mode: "oauth" };

  const authDetails: any[] = detail?.auth_config_details ?? [];
  // Any non-OAuth scheme (API_KEY, BASIC, etc.) needs no app registration —
  // just the user's own credential value(s) — so that's connectable via a
  // plain form. An OAuth-only toolkit with no managed option genuinely isn't
  // something a "Connect" button can do (it needs a real OAuth app
  // registered with that provider first).
  const credentialScheme = authDetails.find((d) => d.mode && d.mode !== "OAUTH2" && d.mode !== "OAUTH1");
  if (credentialScheme) {
    const required = credentialScheme.fields?.connected_account_initiation?.required ?? [];
    return {
      mode: "credentials",
      scheme: credentialScheme.mode,
      fields: required.map((f: any) => ({
        name: f.name,
        displayName: f.displayName ?? f.name,
        description: f.description,
        isSecret: Boolean(f.is_secret),
      })),
    };
  }

  return {
    mode: "unsupported",
    reason: "This service only supports OAuth with your own registered app — there's no managed or API-key option Composio can offer through a simple connect button.",
  };
}

/**
 * Kick off the hosted OAuth flow for a toolkit; returns a URL the user should open.
 *
 * CONFIRMED BY TESTING (curl against backend.composio.dev/api/v3 directly,
 * Sept 2026): the SDK's `client.toolkits.authorize()` in the version this
 * project has pinned (@composio/core ^0.1.x) calls an endpoint Composio has
 * since deprecated server-side — every call fails with "Creating connections
 * on this endpoint... is no longer supported. Use POST
 * /connected_accounts/link instead," regardless of how valid the API key is.
 * (Composio has shipped several breaking majors since — 0.1.x → 1.0.0-beta —
 * so the installed SDK is well behind current.) Rather than chase that churn,
 * this calls the current REST flow directly, same as live.ts does for
 * OpenAI's equally-young Live API: look up the toolkit's Composio-managed
 * auth config, creating one first if this is the first time anyone's
 * connected this toolkit on the project, then link a connected account to it.
 *
 * CONFIRMED BY TESTING: a managed auth config is NOT auto-provisioned per
 * toolkit the way an earlier version of this comment assumed — Gmail had one
 * only because something upstream (likely Composio's own dashboard/onboarding)
 * created it; Calendar, Slack, and every other toolkit had none at all, so
 * every "Connect" attempt failed with a confusing "no managed auth config"
 * error that looked like a bad slug. Fixed by creating one on demand (POST
 * /auth_configs, use_composio_managed_auth) whenever the lookup comes back
 * empty — verified working end-to-end against the real API for Calendar.
 * Callers should check getConnectOptions() first now, so this only runs for
 * toolkits that actually have a managed option.
 */
export async function initiateConnection(userId: string, toolkitSlug: string): Promise<string> {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error("Composio isn't configured yet — add COMPOSIO_API_KEY to backend/.env");
  }

  const configs = await composioFetch(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&is_composio_managed=true`
  );
  let authConfigId = configs?.items?.[0]?.id;

  if (!authConfigId) {
    const created = await composioFetch("/auth_configs", {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: toolkitSlug },
        auth_config: { type: "use_composio_managed_auth", credentials: {}, restrict_to_following_tools: [] },
      }),
    });
    authConfigId = created?.auth_config?.id;
    if (!authConfigId) {
      throw new Error(`Composio couldn't create a managed auth config for toolkit "${toolkitSlug}".`);
    }
  }

  const link = await composioFetch("/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
  });
  if (!link?.redirect_url) throw new Error("Composio didn't return a connection link.");
  return link.redirect_url;
}

/**
 * Connects a toolkit via a direct credential (API key, etc.) instead of an
 * OAuth redirect — for toolkits getConnectOptions() reports as "credentials"
 * mode. Verified end-to-end against the real API (Alpaca): creates a
 * "custom" (non-managed — there's nothing for Composio to manage, the user
 * supplies the actual key) auth config for the given scheme if one doesn't
 * already exist, then creates the connected account immediately with the
 * supplied values — no browser redirect, active right away. An invalid key
 * won't be caught here (Composio doesn't validate it against the real
 * service at creation time); it'll surface the first time a tool actually
 * tries to use it.
 */
export async function connectWithCredentials(
  userId: string,
  toolkitSlug: string,
  scheme: string,
  credentials: Record<string, string>
): Promise<void> {
  if (!env.COMPOSIO_API_KEY) {
    throw new Error("Composio isn't configured yet — add COMPOSIO_API_KEY to backend/.env");
  }

  const configs = await composioFetch(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}`);
  let authConfigId = (configs?.items ?? []).find((c: any) => c.auth_scheme === scheme && !c.is_composio_managed)?.id;

  if (!authConfigId) {
    const created = await composioFetch("/auth_configs", {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: toolkitSlug },
        auth_config: { type: "use_custom_auth", authScheme: scheme, credentials: {} },
      }),
    });
    authConfigId = created?.auth_config?.id;
    if (!authConfigId) throw new Error(`Composio couldn't set up ${scheme} auth for toolkit "${toolkitSlug}".`);
  }

  await composioFetch("/connected_accounts", {
    method: "POST",
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: { user_id: userId, state: { authScheme: scheme, val: { status: "ACTIVE", ...credentials } } },
    }),
  });
}

/** List the user's connected accounts (used to show "Connected" badges in the UI). */
/**
 * CONFIRMED BY TESTING: the SDK's `client.connectedAccounts.list({ userId })`
 * silently ignores that filter — it was returning EVERY connected account on
 * the whole API key/project, regardless of which userId was actually passed.
 * This went unnoticed for a long time because this app only ever had one
 * real user ("demo-user"), so "everyone's accounts" and "demo-user's
 * accounts" were the same set. It surfaced the moment a second real account
 * existed: signing in as a brand new person showed every integration
 * "demo-user" had ever connected — Gmail, Canvas, Alpaca, all of it —
 * instead of a clean slate, completely defeating per-person isolation. Raw
 * REST with the documented `user_ids` query param filters correctly (verified
 * directly against the API: 0 results for a fresh userId, the real 10 for
 * "demo-user"). Ported off the SDK method the same way initiateConnection()
 * already was, for the same reason (see the file-level comment above).
 */
export async function listConnections(userId: string): Promise<any[]> {
  if (!env.COMPOSIO_API_KEY) return [];
  try {
    const data = await composioFetch(`/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=100`);
    return data?.items ?? [];
  } catch (err: any) {
    console.error("[composio] failed to list connected accounts:", err?.error?.message ?? err?.message ?? err);
    return [];
  }
}
