import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { LoginScreen } from "./components/LoginScreen";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";
import { useAuth, validateStoredSession } from "./lib/auth";

export default function App() {
  const auth = useAuth();
  // A token restored from localStorage might be expired or revoked server-side
  // — confirm it's still good once on load rather than trusting it forever.
  // Until that check resolves, `checked` stays false so we show nothing
  // instead of a login-screen flash for an already-logged-in user.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    validateStoredSession().finally(() => setChecked(true));
  }, []);

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
          {!checked ? null : !auth ? (
            <LoginScreen />
          ) : (
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/connectors" element={<ConnectorsPage />} />
            </Routes>
          )}
        </div>
      </div>
    </BrowserRouter>
  );
}
