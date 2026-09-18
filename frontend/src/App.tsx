import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";

// NOTE: phone-number accounts (lib/auth.ts, components/LoginScreen.tsx) are
// fully built but not gating the app right now — the backend's routes accept
// requests with no session token and fall back to a single shared "demo-user"
// (see routes/auth.ts's attachUser), so there's nothing to log into while
// just testing Nova/connectors. To turn login back on: import useAuth and
// LoginScreen, and render <LoginScreen /> in place of <Routes> whenever
// useAuth() is null (validating any stored token once on mount first) — this
// file looked exactly like that a moment ago, just ask to have it restored.
export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen w-full bg-ink-950 relative overflow-x-hidden">
        {/* ambient background glow */}
        <div
          className="pointer-events-none fixed inset-0 opacity-[0.15]"
          style={{
            background:
              "radial-gradient(600px circle at 50% 0%, #60a5fa, transparent 60%), radial-gradient(500px circle at 90% 30%, #a78bfa, transparent 55%)",
          }}
        />

        <div className="relative">
          <NavBar />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
