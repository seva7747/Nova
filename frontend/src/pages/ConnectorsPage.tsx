import { IntegrationsPanel } from "../components/IntegrationsPanel";
import { Footer } from "../components/Footer";

export function ConnectorsPage() {
  return (
    <>
      <main className="relative mx-auto flex max-w-3xl flex-col items-center gap-8 px-4 py-16">
        <div className="max-w-lg text-center">
          <h1 className="text-3xl font-bold text-white">Connectors</h1>
          <p className="mt-2 text-sm text-white/50">
            Connect the accounts Nova can act on by voice. Weather, sports, news, and the "call a restaurant" demo
            don't need anything connected here — those run through Nova's own built-in web search (and a
            simulated call, for the restaurant one).
          </p>
        </div>
        <IntegrationsPanel />
      </main>
      <Footer />
    </>
  );
}
