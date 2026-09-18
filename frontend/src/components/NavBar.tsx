import { NavLink } from "react-router-dom";

const LINKS = [
  { to: "/", label: "Home" },
  { to: "/connectors", label: "Connectors" },
  { to: "/settings", label: "Settings" },
];

export function NavBar() {
  return (
    <nav className="sticky top-0 z-20 w-full border-b border-white/5 bg-ink-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <NavLink to="/" className="flex items-center gap-2 text-sm font-bold text-white">
          <span className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-nova-cyan to-nova-violet" />
          Nova
        </NavLink>
        <div className="flex items-center gap-1">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                `rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  isActive ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5 hover:text-white"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
