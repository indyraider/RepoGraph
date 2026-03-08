import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
  Network,
  LayoutDashboard,
  Activity,
  ScrollText,
  GitCommitHorizontal,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
} from "lucide-react";
import { useAuth } from "./AuthProvider";

const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/explore", icon: Network, label: "Explore Graph" },
  { to: "/activity", icon: Activity, label: "Activity Log" },
  { to: "/logs", icon: ScrollText, label: "Runtime Logs" },
  { to: "/history", icon: GitCommitHorizontal, label: "History" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

const STORAGE_KEY = "repograph-sidebar-collapsed";

export default function Sidebar() {
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // ignore
    }
  }, [collapsed]);

  return (
    <aside
      className={`h-full flex flex-col flex-shrink-0 transition-[width] duration-200 ease-in-out ${
        collapsed ? "w-[60px]" : "w-[220px]"
      }`}
      style={{ background: "var(--bg-deep)", borderRight: "1px solid var(--border-subtle)" }}
    >
      {/* Logo area */}
      <div className="flex items-center gap-3 px-4 h-14 overflow-hidden" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "linear-gradient(135deg, #4ECDC4, #0284C7)", boxShadow: "0 4px 12px rgba(78, 205, 196, 0.25)" }}>
          <Network className="w-4 h-4 text-white" />
        </div>
        <span
          className={`text-sm font-bold text-white whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? "opacity-0 w-0" : "opacity-100"
          }`}
          style={{ textShadow: "0 0 15px rgba(78, 205, 196, 0.3)" }}
        >
          RepoGraph
        </span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-3 px-2 space-y-1">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 group border ${
                isActive
                  ? ""
                  : "border-transparent hover:bg-white/[0.04]"
              }`
            }
            style={({ isActive }) =>
              isActive
                ? { background: "rgba(78, 205, 196, 0.08)", color: "#4ECDC4", borderColor: "rgba(78, 205, 196, 0.2)" }
                : { color: "#6B7B8D" }
            }
          >
            <Icon className="w-4.5 h-4.5 flex-shrink-0" />
            <span
              className={`whitespace-nowrap transition-opacity duration-200 ${
                collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
              }`}
            >
              {label}
            </span>
          </NavLink>
        ))}
      </nav>

      {/* User + controls */}
      <div className="px-2 py-3 space-y-1" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        {/* User info */}
        {user && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg overflow-hidden">
            <img
              src={user.avatar_url}
              alt={user.login}
              className="w-7 h-7 rounded-full flex-shrink-0 ring-1 ring-white/10"
            />
            <div
              className={`min-w-0 transition-opacity duration-200 ${
                collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
              }`}
            >
              <div className="text-xs font-medium truncate" style={{ color: "var(--text-primary)" }}>
                {user.name || user.login}
              </div>
              <div className="text-[10px] truncate" style={{ color: "var(--text-secondary)" }}>@{user.login}</div>
            </div>
          </div>
        )}

        {/* Logout */}
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:text-red-400 hover:bg-red-500/[0.06] transition-colors w-full text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          <LogOut className="w-4.5 h-4.5 flex-shrink-0" />
          <span
            className={`whitespace-nowrap transition-opacity duration-200 ${
              collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
            }`}
          >
            Sign out
          </span>
        </button>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.04] transition-colors w-full text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          {collapsed ? (
            <PanelLeftOpen className="w-4.5 h-4.5 flex-shrink-0" />
          ) : (
            <PanelLeftClose className="w-4.5 h-4.5 flex-shrink-0" />
          )}
          <span
            className={`whitespace-nowrap transition-opacity duration-200 ${
              collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
            }`}
          >
            Collapse
          </span>
        </button>
      </div>
    </aside>
  );
}
