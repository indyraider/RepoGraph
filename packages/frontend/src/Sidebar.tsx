import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import {
  Network,
  LayoutDashboard,
  Activity,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/explore", icon: Network, label: "Explore Graph" },
  { to: "/activity", icon: Activity, label: "Activity Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

const STORAGE_KEY = "repograph-sidebar-collapsed";

export default function Sidebar() {
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
      className={`h-full flex flex-col bg-gray-900/60 border-r border-white/5 flex-shrink-0 transition-[width] duration-200 ease-in-out ${
        collapsed ? "w-[60px]" : "w-[220px]"
      }`}
    >
      {/* Logo area */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-white/5 overflow-hidden">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-violet-500/20">
          <Network className="w-4 h-4 text-white" />
        </div>
        <span
          className={`text-sm font-bold text-white whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? "opacity-0 w-0" : "opacity-100"
          }`}
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
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 group ${
                isActive
                  ? "bg-violet-500/10 text-violet-400 border border-violet-500/20"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] border border-transparent"
              }`
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

      {/* Collapse toggle */}
      <div className="px-2 py-3 border-t border-white/5">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors w-full text-sm"
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
