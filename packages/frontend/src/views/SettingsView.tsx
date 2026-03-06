import { useState, useEffect } from "react";
import { checkHealth, type HealthStatus } from "../api";
import {
  Settings,
  Loader2,
  Server,
  Database,
  Globe,
  KeyRound,
  CheckCircle2,
  XCircle,
  WifiOff,
} from "lucide-react";
import { StatusBadge } from "../components/StatusBadge";
import { McpPanel } from "../components/McpPanel";

export default function SettingsView() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refreshHealth = () => {
    setLoading(true);
    setError(false);
    checkHealth()
      .then(setHealth)
      .catch(() => {
        setHealth(null);
        setError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refreshHealth();
  }, []);

  const apiUrl = import.meta.env.VITE_API_URL || "(default: same origin)";
  const hasApiKey = !!import.meta.env.VITE_API_KEY;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Settings</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Connection status and configuration
              </p>
            </div>
          </div>
        </div>

        {/* Connection Status */}
        <div className="card-glass rounded-xl overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-violet-400" />
              <h2 className="text-base font-semibold text-white">Connection Status</h2>
            </div>
            <button
              onClick={refreshHealth}
              disabled={loading}
              className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-md hover:bg-white/[0.04] transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            {loading && (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking connections...
              </div>
            )}

            {!loading && error && (
              <div className="flex items-center gap-2 text-sm">
                <WifiOff className="w-4 h-4 text-red-400" />
                <span className="text-red-400">Backend unreachable</span>
                <span className="text-gray-600 text-xs">— is the server running?</span>
              </div>
            )}

            {!loading && health && (
              <div className="space-y-3">
                {/* Neo4j */}
                <div className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <Database className="w-4 h-4 text-gray-500" />
                    <div>
                      <div className="text-sm text-gray-200">Neo4j Graph Database</div>
                      <div className="text-xs text-gray-600">Knowledge graph storage</div>
                    </div>
                  </div>
                  <StatusBadge
                    connected={health.neo4j === "connected"}
                    label={health.neo4j}
                  />
                </div>

                {/* Supabase */}
                <div className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <Database className="w-4 h-4 text-gray-500" />
                    <div>
                      <div className="text-sm text-gray-200">Supabase</div>
                      <div className="text-xs text-gray-600">Repository metadata & job tracking</div>
                    </div>
                  </div>
                  <StatusBadge
                    connected={health.supabase === "connected"}
                    label={health.supabase}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* API Configuration */}
        <div className="card-glass rounded-xl overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-white/5">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-violet-400" />
              <h2 className="text-base font-semibold text-white">API Configuration</h2>
            </div>
          </div>

          <div className="px-5 py-4 space-y-4">
            {/* API URL */}
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <Globe className="w-4 h-4 text-gray-500" />
                <div>
                  <div className="text-sm text-gray-200">API URL</div>
                  <div className="text-xs text-gray-600">VITE_API_URL</div>
                </div>
              </div>
              <code className="text-xs bg-gray-800/80 px-2.5 py-1 rounded font-mono text-gray-400">
                {apiUrl}
              </code>
            </div>

            {/* API Key */}
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <KeyRound className="w-4 h-4 text-gray-500" />
                <div>
                  <div className="text-sm text-gray-200">API Key</div>
                  <div className="text-xs text-gray-600">VITE_API_KEY</div>
                </div>
              </div>
              <span className={`inline-flex items-center gap-1.5 text-xs ${hasApiKey ? "text-emerald-400" : "text-gray-500"}`}>
                {hasApiKey ? (
                  <>
                    <CheckCircle2 className="w-3 h-3" />
                    Configured
                  </>
                ) : (
                  <>
                    <XCircle className="w-3 h-3" />
                    Not set
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-gray-600 leading-relaxed pt-2 border-t border-white/5">
              These values are set via environment variables at build time. To change them,
              update your <code className="bg-gray-800/80 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-400">.env</code> file
              and rebuild the frontend.
            </p>
          </div>
        </div>

        {/* MCP Configuration */}
        <div className="card-glass rounded-xl overflow-hidden">
          <McpPanel />
        </div>
      </div>
    </div>
  );
}
