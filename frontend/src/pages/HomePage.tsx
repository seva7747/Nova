import { Hero } from "../components/Hero";
import { DeviceDemo } from "../components/DeviceDemo";
import { FeatureGrid } from "../components/FeatureGrid";
import { UnderTheHood } from "../components/UnderTheHood";
import { EconomicsNote } from "../components/EconomicsNote";
import { Footer } from "../components/Footer";

export function HomePage() {
  return (
    <>
      <main className="relative mx-auto flex max-w-3xl flex-col items-center gap-16 px-4 pb-24">
        <Hero />
        <DeviceDemo />
        <FeatureGrid />
        <UnderTheHood />
        <EconomicsNote />
      </main>
      <Footer />
    </>
  );
}
