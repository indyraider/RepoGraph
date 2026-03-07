import { useState, useEffect } from "react";
import {
  checkHealth,
  getConnections,
  saveConnection,
  deleteConnection,
  testNeo4jConnection,
  type HealthStatus,
  type UserConnection,
} from "../api";
import {
  Settings,
  Loader2,
  Server,
  Database,
  Globe,
  CheckCircle2,
  XCircle,
  WifiOff,
  Plug,
  Trash2,
  Zap,
  Save,
  Eye,
  EyeOff,
} from "lucide-react";
import { StatusBadge } from "../components/StatusBadge";
import { McpPanel } from "../components/McpPanel";
import { LogSourcePanel } from "../components/LogSourcePanel";

function Neo4jConnectionForm({
  existing,
  onSaved,
}: {
  existing: UserConnection | null;
  onSaved: () => void;
}) {
  const [uri, setUri] = useState("");
  const [username, setUsername] = useState("neo4j");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("neo4j");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testNeo4jConnection(uri, username, password);
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: "Connection test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveConnection("neo4j", { uri, username, password, database });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteConnection("neo4j");
      setUri("");
      setUsername("neo4j");
      setPassword("");
      setDatabase("neo4j");
      onSaved();
    } catch {
      setError("Failed to delete connection");
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Connection URI</label>
          <input
            type="text"
            placeholder="neo4j+s://xxxxx.databases.neo4j.io"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Database</label>
          <input
            type="text"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              placeholder={existing ? "••••••••" : "Enter password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {testResult && (
        <div
          className={`text-xs px-3 py-2 rounded-lg flex items-center gap-2 ${
            testResult.ok
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10"
              : "bg-red-500/10 text-red-400 border border-red-500/10"
          }`}
        >
          {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {testResult.ok ? "Connection successful" : testResult.error}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/10">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleTest}
          disabled={!uri || !username || !password || testing}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/10 text-gray-300 hover:text-white hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Test Connection
        </button>
        <button
          onClick={handleSave}
          disabled={!uri || !username || !password || saving}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </button>
        {existing && (
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors ml-auto"
          >
            <Trash2 className="w-3 h-3" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function SupabaseConnectionForm({
  existing,
  onSaved,
}: {
  existing: UserConnection | null;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState("");
  const [serviceKey, setServiceKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveConnection("supabase", { url, service_key: serviceKey });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteConnection("supabase");
      setUrl("");
      setServiceKey("");
      onSaved();
    } catch {
      setError("Failed to delete connection");
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-gray-500 block mb-1">Project URL</label>
        <input
          type="text"
          placeholder="https://xxxxx.supabase.co"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 block mb-1">Service Role Key</label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            placeholder={existing ? "••••••••" : "eyJhbGci..."}
            value={serviceKey}
            onChange={(e) => setServiceKey(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/10">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={!url || !serviceKey || saving}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </button>
        {existing && (
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors ml-auto"
          >
            <Trash2 className="w-3 h-3" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export default function SettingsView() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connections, setConnections] = useState<UserConnection[]>([]);

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

  const refreshConnections = () => {
    getConnections().then(setConnections).catch(() => {});
  };

  useEffect(() => {
    refreshHealth();
    refreshConnections();
  }, []);

  const neo4jConn = connections.find((c) => c.provider === "neo4j") || null;
  const supabaseConn = connections.find((c) => c.provider === "supabase") || null;

  const apiUrl = import.meta.env.VITE_API_URL || "(default: same origin)";

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

        {/* Neo4j Connection */}
        <div className="card-glass rounded-xl overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-white/5">
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-violet-400" />
              <h2 className="text-base font-semibold text-white">Neo4j Connection</h2>
              {neo4jConn && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Connect your Neo4j Aura instance. Credentials are encrypted before storage.
            </p>
          </div>
          <div className="px-5 py-4">
            <Neo4jConnectionForm existing={neo4jConn} onSaved={refreshConnections} />
          </div>
        </div>

        {/* Supabase Connection */}
        <div className="card-glass rounded-xl overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-white/5">
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-violet-400" />
              <h2 className="text-base font-semibold text-white">Supabase Connection</h2>
              {supabaseConn && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Connect your Supabase project for metadata storage. Credentials are encrypted before storage.
            </p>
          </div>
          <div className="px-5 py-4">
            <SupabaseConnectionForm existing={supabaseConn} onSaved={refreshConnections} />
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

            <p className="text-xs text-gray-600 leading-relaxed pt-2 border-t border-white/5">
              This value is set via environment variable at build time. To change it,
              update your <code className="bg-gray-800/80 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-400">.env</code> file
              and rebuild the frontend.
            </p>
          </div>
        </div>

        {/* MCP Configuration */}
        <div className="card-glass rounded-xl overflow-hidden mb-6">
          <McpPanel />
        </div>

        {/* Runtime Log Sources */}
        <div className="card-glass rounded-xl overflow-hidden">
          <LogSourcePanel />
        </div>
      </div>
    </div>
  );
}
