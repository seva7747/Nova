import { useEffect, useState } from "react";
import {
  connectIntegration,
  connectIntegrationWithCredentials,
  fetchIntegrationStatus,
  fetchConnectorCatalog,
  type CatalogEntry,
  type ConnectField,
} from "../lib/api";

type Account = { id: string; label: string };
type Status = { configured: boolean; accountsByToolkit: Record<string, Account[]>; error?: string };

/** The inline form shown when a toolkit needs a direct credential (e.g. an API key) instead of one-click OAuth — see composio.ts's getConnectOptions. */
function CredentialsForm({
  toolkit,
  scheme,
  fields,
  onDone,
  onCancel,
}: {
  toolkit: string;
  scheme: string;
  fields: ConnectField[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    const result = await connectIntegrationWithCredentials(toolkit, scheme, values);
    setSubmitting(false);
    if (result.success) onDone();
    else setError(result.error ?? "Couldn't connect — check the values and try again.");
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-white/5 pt-3">
      <p className="text-xs text-white/40">
        This service doesn't offer one-click connect — enter its credentials directly instead.
      </p>
      {fields.map((f) => (
        <div key={f.name}>
          <label className="block text-xs text-white/50 mb-1">{f.displayName}</label>
          <input
            type={f.isSecret ? "password" : "text"}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            placeholder={f.description}
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-xs text-white placeholder:text-white/25 outline-none focus:border-nova-blue/50"
          />
        </div>
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="text-xs text-white/40 hover:text-white/60 px-3 py-1.5 transition">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting || fields.some((f) => !values[f.name]?.trim())}
          className="text-xs font-medium rounded-full border border-nova-cyan/40 hover:border-nova-cyan/70 disabled:opacity-40 px-3.5 py-1.5 text-nova-cyan transition"
        >
          {submitting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
}

function ConnectorRow({
  slug,
  label,
  blurb,
  logo,
  accounts,
  configured,
  onRefresh,
}: {
  slug: string;
  label: string;
  blurb?: string;
  logo?: string;
  accounts: Account[];
  configured: boolean;
  onRefresh: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [pendingForm, setPendingForm] = useState<{ scheme: string; fields: ConnectField[] } | null>(null);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await connectIntegration(slug);
      if ("redirectUrl" in result) {
        window.open(result.redirectUrl, "_blank", "noopener,noreferrer");
        // The OAuth flow finishes in that new tab — poll for a bit so this
        // page notices the new connection without a manual refresh.
        let attempts = 0;
        const poll = setInterval(() => {
          attempts++;
          onRefresh();
          if (attempts >= 12) clearInterval(poll);
        }, 5000);
      } else if ("needsCredentials" in result) {
        setPendingForm({ scheme: result.scheme, fields: result.fields });
      } else {
        alert(result.error ?? "Couldn't start that connection — check the backend logs.");
      }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2.5">
          {logo && <img src={logo} alt="" className="w-5 h-5 rounded shrink-0" />}
          <div className="min-w-0">
            <div className="text-sm font-medium text-white truncate">{label}</div>
            {blurb && <div className="text-xs text-white/40 truncate">{blurb}</div>}
          </div>
        </div>
        <button
          onClick={handleConnect}
          disabled={!configured || connecting || Boolean(pendingForm)}
          className="text-xs font-medium rounded-full border border-white/15 hover:border-white/30 disabled:opacity-40 px-3.5 py-1.5 text-white/80 hover:text-white transition shrink-0"
        >
          {connecting ? "Opening..." : accounts.length > 0 ? "+ Connect another" : "Connect"}
        </button>
      </div>
      {accounts.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-white/5 pt-2.5">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 text-xs text-nova-cyan">
              <span className="w-1.5 h-1.5 rounded-full bg-nova-cyan shrink-0" />
              <span className="text-white/70 truncate">{a.label}</span>
            </div>
          ))}
        </div>
      )}
      {pendingForm && (
        <CredentialsForm
          toolkit={slug}
          scheme={pendingForm.scheme}
          fields={pendingForm.fields}
          onCancel={() => setPendingForm(null)}
          onDone={() => {
            setPendingForm(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

export function IntegrationsPanel() {
  const [status, setStatus] = useState<Status>({ configured: false, accountsByToolkit: {} });
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const refreshStatus = () =>
    fetchIntegrationStatus()
      .then((s) => setStatus(s))
      .catch(() => {})
      .finally(() => setLoaded(true));

  useEffect(() => {
    refreshStatus();
  }, []);

  // Debounced: browses the catalog (query="") by default, or searches it —
  // either way it's the SAME live ~1,500-toolkit catalog, cursor-paginated,
  // not a fixed hand-picked list.
  useEffect(() => {
    setInitialLoading(true);
    const t = window.setTimeout(async () => {
      const page = await fetchConnectorCatalog(query);
      setEntries(page.items);
      setCursor(page.nextCursor);
      setInitialLoading(false);
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    const page = await fetchConnectorCatalog(query, cursor);
    setEntries((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setLoadingMore(false);
  };

  return (
    <section className="w-full rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
      <h3 className="font-semibold text-white mb-1">Connect your accounts</h3>
      <p className="text-sm text-white/45 mb-6">
        Browse or search Composio's full catalog of roughly 1,500 services below. Connect an account once — Nova
        starts using it automatically, no setup beyond connecting. You can connect more than one account for the
        same service (e.g. two Gmail addresses) — Nova will ask which one when it matters. A few services (no
        one-click OAuth available) ask for an API key directly instead.
      </p>

      {loaded && !status.configured && (
        <div className="mb-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200/80">
          Composio isn't configured on the backend yet — add <code className="text-amber-100">COMPOSIO_API_KEY</code>{" "}
          to <code className="text-amber-100">backend/.env</code> to enable connecting accounts.
        </div>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search any service — Trello, LinkedIn, Alpaca, HubSpot..."
        className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-nova-blue/50 mb-5"
      />

      <div className="flex flex-col gap-3">
        {initialLoading && entries.length === 0 && <p className="text-xs text-white/30 px-1">Loading...</p>}
        {!initialLoading && entries.length === 0 && (
          <p className="text-xs text-white/30 px-1">No matches for "{query}".</p>
        )}
        {entries.map((e) => (
          <ConnectorRow
            key={e.slug}
            slug={e.slug}
            label={e.name}
            blurb={e.description}
            logo={e.logo}
            accounts={status.accountsByToolkit?.[e.slug.toLowerCase()] ?? []}
            configured={status.configured}
            onRefresh={refreshStatus}
          />
        ))}
      </div>

      {cursor && (
        <div className="flex justify-center mt-4">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="text-xs text-white/50 hover:text-white/80 disabled:opacity-40 rounded-full border border-white/10 hover:border-white/20 px-4 py-1.5 transition"
          >
            {loadingMore ? "Loading..." : "Show more"}
          </button>
        </div>
      )}

      <p className="mt-5 text-xs text-white/30 leading-relaxed">
        Weather, sports scores, and "call a restaurant" don't need a connection — weather and sports run through
        Claude's own live web search, and restaurant calls are simulated in this demo (there's no public API for
        phoning a restaurant; a real product would plug in a voice-calling service for that).
      </p>
    </section>
  );
}
