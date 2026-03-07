import { useState, useEffect } from "react";
import {
  Loader2,
  Plus,
  Trash2,
  Zap,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Power,
  PowerOff,
  Eye,
  EyeOff,
  Pencil,
  Save,
} from "lucide-react";
import {
  getLogSources,
  getLogSourcePlatforms,
  createLogSource,
  updateLogSource,
  deleteLogSource,
  testLogSourceConnection,
  testSavedLogSource,
  toggleLogSource,
  getRepositories,
  type LogSource,
  type LogSourcePlatform,
  type Repository,
} from "../api";

// Platform-specific config fields (hardcoded since backend doesn't serve these)
const PLATFORM_CONFIG_FIELDS: Record<
  string,
  { key: string; label: string; required: boolean; placeholder: string }[]
> = {
  vercel: [
    { key: "project_id", label: "Project ID", required: true, placeholder: "prj_xxxxxxxxxxxx" },
    { key: "team_slug", label: "Team Slug", required: false, placeholder: "my-team (optional)" },
  ],
  railway: [
    { key: "project_id", label: "Project ID", required: true, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
    { key: "service_id", label: "Service ID", required: true, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
    { key: "environment_id", label: "Environment ID", required: false, placeholder: "production (optional)" },
  ],
};

const MIN_LEVELS = ["debug", "info", "warn", "error", "fatal"];

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AddSourceForm({
  platforms,
  repos,
  onCreated,
  onCancel,
}: {
  platforms: LogSourcePlatform[];
  repos: Repository[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [repoId, setRepoId] = useState("");
  const [platform, setPlatform] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [pollingInterval, setPollingInterval] = useState(30);
  const [minLevel, setMinLevel] = useState("warn");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configFields = PLATFORM_CONFIG_FIELDS[platform] || [];

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testLogSourceConnection({ platform, api_token: apiToken, config });
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
      await createLogSource({
        repo_id: repoId,
        platform,
        display_name: displayName,
        api_token: apiToken,
        config,
        polling_interval_sec: pollingInterval,
        min_level: minLevel,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  const canTest = platform && apiToken;
  const canSave = repoId && platform && displayName && apiToken;

  return (
    <div className="space-y-4 border border-white/5 rounded-lg p-4 bg-gray-900/40">
      <div className="text-sm font-medium text-gray-200">New Log Source</div>

      <div className="grid grid-cols-2 gap-3">
        {/* Repository */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Repository</label>
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          >
            <option value="">Select repo...</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        {/* Platform */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Platform</label>
          <select
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setConfig({});
              setTestResult(null);
            }}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          >
            <option value="">Select platform...</option>
            {platforms.map((p) => (
              <option key={p.platform} value={p.platform}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Display Name */}
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Display Name</label>
          <input
            type="text"
            placeholder="e.g. Production API"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
          />
        </div>

        {/* API Token */}
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">API Token</label>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              placeholder="Enter API token"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Platform-specific config */}
        {configFields.map((field) => (
          <div key={field.key} className={configFields.length === 1 ? "col-span-2" : ""}>
            <label className="text-xs text-gray-500 block mb-1">
              {field.label}
              {!field.required && <span className="text-gray-600 ml-1">(optional)</span>}
            </label>
            <input
              type="text"
              placeholder={field.placeholder}
              value={config[field.key] || ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
            />
          </div>
        ))}

        {/* Polling interval & min level */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Poll Interval (sec)</label>
          <input
            type="number"
            min={10}
            max={3600}
            value={pollingInterval}
            onChange={(e) => setPollingInterval(Number(e.target.value))}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Min Log Level</label>
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          >
            {MIN_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Test result */}
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

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleTest}
          disabled={!canTest || testing}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/10 text-gray-300 hover:text-white hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Test Connection
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Create
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-colors ml-auto"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditSourceForm({
  source,
  onSaved,
  onCancel,
}: {
  source: LogSource;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(source.display_name);
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(source.config).map(([k, v]) => [k, String(v)])
    )
  );
  const [pollingInterval, setPollingInterval] = useState(source.polling_interval_sec);
  const [minLevel, setMinLevel] = useState(source.min_level);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configFields = PLATFORM_CONFIG_FIELDS[source.platform] || [];

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (apiToken) {
        const result = await testLogSourceConnection({
          platform: source.platform,
          api_token: apiToken,
          config,
        });
        setTestResult(result);
      } else {
        const result = await testSavedLogSource(source.id);
        setTestResult(result);
      }
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
      const params: Record<string, unknown> = {};
      if (displayName !== source.display_name) params.display_name = displayName;
      if (apiToken) params.api_token = apiToken;
      if (pollingInterval !== source.polling_interval_sec) params.polling_interval_sec = pollingInterval;
      if (minLevel !== source.min_level) params.min_level = minLevel;

      // Check if config fields changed
      const configChanged = configFields.some(
        (f) => (config[f.key] || "") !== String(source.config[f.key] || "")
      );
      if (configChanged) params.config = config;

      if (Object.keys(params).length === 0) {
        onCancel();
        return;
      }

      await updateLogSource(source.id, params);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Display Name */}
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Display Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
          />
        </div>

        {/* API Token */}
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">
            API Token <span className="text-gray-600 ml-1">(leave blank to keep current)</span>
          </label>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              placeholder="Enter new token to update"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 pr-10 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Platform-specific config */}
        {configFields.map((field) => (
          <div key={field.key} className={configFields.length === 1 ? "col-span-2" : ""}>
            <label className="text-xs text-gray-500 block mb-1">
              {field.label}
              {!field.required && <span className="text-gray-600 ml-1">(optional)</span>}
            </label>
            <input
              type="text"
              placeholder={field.placeholder}
              value={config[field.key] || ""}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
            />
          </div>
        ))}

        {/* Polling interval & min level */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Poll Interval (sec)</label>
          <input
            type="number"
            min={10}
            max={3600}
            value={pollingInterval}
            onChange={(e) => setPollingInterval(Number(e.target.value))}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Min Log Level</label>
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            className="w-full bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-100 input-focus-ring transition-shadow"
          >
            {MIN_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Test result */}
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

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleTest}
          disabled={testing}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/10 text-gray-300 hover:text-white hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Test Connection
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !displayName}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save Changes
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-colors ml-auto"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SourceRow({
  source,
  onToggle,
  onDelete,
  onUpdated,
}: {
  source: LogSource;
  onToggle: () => void;
  onDelete: () => void;
  onUpdated: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await onToggle();
    } finally {
      setToggling(false);
    }
  };

  const statusColor = !source.enabled
    ? "text-gray-500"
    : source.last_error
      ? "text-amber-400"
      : "text-emerald-400";

  const statusLabel = !source.enabled
    ? "Disabled"
    : source.last_error
      ? "Error"
      : "Active";

  return (
    <div className="border border-white/5 rounded-lg overflow-hidden">
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className={`w-2 h-2 rounded-full ${statusColor.replace("text-", "bg-")}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-200 truncate">{source.display_name}</div>
          <div className="text-xs text-gray-500">
            {source.platform} · {statusLabel}
            {source.last_poll_at && ` · polled ${timeAgo(source.last_poll_at)}`}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        )}
      </div>

      {expanded && (
        <div className="px-4 py-3 border-t border-white/5 space-y-3">
          {source.last_error && !editing && (
            <div className="text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/10 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{source.last_error}</span>
            </div>
          )}

          {editing ? (
            <EditSourceForm
              source={source}
              onSaved={() => {
                setEditing(false);
                onUpdated();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <div className="text-gray-500">Platform</div>
                <div className="text-gray-300">{source.platform}</div>
                <div className="text-gray-500">Poll Interval</div>
                <div className="text-gray-300">{source.polling_interval_sec}s</div>
                <div className="text-gray-500">Min Level</div>
                <div className="text-gray-300">{source.min_level}</div>
                <div className="text-gray-500">Created</div>
                <div className="text-gray-300">{new Date(source.created_at).toLocaleDateString()}</div>
                {Object.entries(source.config).map(([k, v]) => (
                  <div key={k} className="contents">
                    <div className="text-gray-500">{k}</div>
                    <div className="text-gray-300 truncate">{String(v)}</div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle();
                  }}
                  disabled={toggling}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/10 text-gray-300 hover:text-white hover:bg-white/[0.04] transition-colors disabled:opacity-40"
                >
                  {toggling ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : source.enabled ? (
                    <PowerOff className="w-3 h-3" />
                  ) : (
                    <Power className="w-3 h-3" />
                  )}
                  {source.enabled ? "Disable" : "Enable"}
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(true);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/10 text-gray-300 hover:text-white hover:bg-white/[0.04] transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>

                {!confirmDelete ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(true);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                ) : (
                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-xs text-gray-500">Are you sure?</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                      className="text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                    >
                      Yes, delete
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(false);
                      }}
                      className="text-xs px-2 py-1 rounded text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function LogSourcePanel() {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [platforms, setPlatforms] = useState<LogSourcePlatform[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    Promise.all([getLogSources(), getLogSourcePlatforms(), getRepositories()])
      .then(([s, p, r]) => {
        setSources(s);
        setPlatforms(p);
        setRepos(r);
      })
      .catch(() => setError("Failed to load log sources"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleToggle = async (id: string) => {
    try {
      const result = await toggleLogSource(id);
      setSources((prev) =>
        prev.map((s) => (s.id === id ? { ...s, enabled: result.enabled } : s))
      );
    } catch {
      setError("Failed to toggle log source");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteLogSource(id);
      setSources((prev) => prev.filter((s) => s.id !== id));
    } catch {
      setError("Failed to delete log source");
    }
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-violet-400" />
          <h2 className="text-base font-semibold text-white">Runtime Log Sources</h2>
          {!loading && sources.length > 0 && (
            <span className="text-xs text-gray-500 ml-1">
              {sources.filter((s) => s.enabled).length} active
            </span>
          )}
        </div>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Source
          </button>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/10">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading log sources...
          </div>
        )}

        {!loading && showAdd && (
          <AddSourceForm
            platforms={platforms}
            repos={repos}
            onCreated={() => {
              setShowAdd(false);
              refresh();
            }}
            onCancel={() => setShowAdd(false)}
          />
        )}

        {!loading && sources.length === 0 && !showAdd && (
          <p className="text-xs text-gray-500 leading-relaxed">
            No log sources configured. Add a Vercel or Railway source to stream production logs
            into your code graph.
          </p>
        )}

        {!loading &&
          sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              onToggle={() => handleToggle(source.id)}
              onDelete={() => handleDelete(source.id)}
              onUpdated={refresh}
            />
          ))}
      </div>
    </>
  );
}
