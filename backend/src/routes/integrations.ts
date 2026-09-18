import { Router } from "express";
import { env } from "../config.js";
import { initiateConnection, getAccountsByToolkit, getToolkitCatalog, getConnectOptions, connectWithCredentials } from "../services/composio.js";
import { attachUser } from "./auth.js";

const router = Router();

router.get("/status", attachUser, async (req, res) => {
  const userId = (req as any).userId;
  const configured = Boolean(env.COMPOSIO_API_KEY);
  try {
    // accountsByToolkit ({ gmail: [{id, label}, ...] }) is the ONLY status
    // shape the frontend reads now — it's already ACTIVE-only and already
    // has a resolved human label per account (see composio.ts), so it does
    // double duty as both "what's connected" and "what to call each one" —
    // no need to also ship the raw connection list just to check a status field.
    const accountsByToolkit = configured ? await getAccountsByToolkit(userId) : {};
    res.json({ configured, accountsByToolkit });
  } catch (err: any) {
    res.json({ configured, accountsByToolkit: {}, error: err?.message });
  }
});

/** Browse (no `q`) or search Composio's full ~1,543-toolkit catalog, cursor-paginated — the Connectors page's "find any service" list, not limited to whatever's hand-curated in composio.ts. Not user-specific, so no auth needed to just browse. */
router.get("/catalog", async (req, res) => {
  if (!env.COMPOSIO_API_KEY) return res.json({ items: [], nextCursor: null });
  try {
    const q = String(req.query.q ?? "");
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const page = await getToolkitCatalog(q, cursor);
    res.json(page);
  } catch (err: any) {
    res.status(500).json({ items: [], nextCursor: null, error: err?.message ?? "Catalog fetch failed." });
  }
});

/**
 * Start connecting a toolkit. Checks HOW it can be connected first
 * (getConnectOptions) instead of blindly attempting managed OAuth — some
 * toolkits (confirmed: Alpaca) have no managed option at all, and blindly
 * trying produced a confusing 404. Three possible shapes back:
 *   { redirectUrl }                         — one-click OAuth, open this URL
 *   { needsCredentials, scheme, fields }    — show a form, then POST to /connect-with-credentials
 *   { error }                               — genuinely not connectable this way (rare)
 *
 * CONFIRMED BY TESTING (well, by inspection): before requireAuth was added
 * here, `userId` came straight from the request body — meaning anyone could
 * read or connect accounts under ANY user id just by passing a different
 * string. Now it's always the verified session's own id, never client input.
 */
router.post("/connect", attachUser, async (req, res) => {
  const userId = (req as any).userId;
  const { toolkit } = req.body ?? {};
  if (!toolkit) return res.status(400).json({ error: "toolkit is required" });
  try {
    const options = await getConnectOptions(toolkit);
    if (options.mode === "oauth") {
      const redirectUrl = await initiateConnection(userId, toolkit);
      return res.json({ redirectUrl });
    }
    if (options.mode === "credentials") {
      return res.json({ needsCredentials: true, scheme: options.scheme, fields: options.fields });
    }
    res.status(400).json({ error: options.reason });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Couldn't start that connection." });
  }
});

/** Completes a "credentials" mode connection (see /connect above) — the user's typed-in API key etc., no OAuth redirect. */
router.post("/connect-with-credentials", attachUser, async (req, res) => {
  const userId = (req as any).userId;
  const { toolkit, scheme, credentials } = req.body ?? {};
  if (!toolkit || !scheme || !credentials || typeof credentials !== "object") {
    return res.status(400).json({ error: "toolkit, scheme, and credentials are required" });
  }
  try {
    await connectWithCredentials(userId, toolkit, scheme, credentials);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Couldn't complete that connection." });
  }
});

export default router;
