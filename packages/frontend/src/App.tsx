import { useState, useEffect, useCallback } from "react";
import {
  checkHealth,
  startDigest,
  getRepositories,
  deleteRepository,
  updateSyncMode,
  getSyncEvents,
  type Repository,
  type HealthStatus,
  type SyncEvent,
} from "./api";
import { lazy, Suspense, Component, type ErrorInfo, type ReactNode } from "react";
import {
  GitBranch,
  Network,
  Database,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Webhook,
  Eye,
  EyeOff,
  FolderSync,
  CircleDot,
  Link2,
  KeyRound,
  FileCode2,
  Inbox,
  Wifi,
  WifiOff,
  Activity,
  ArrowRight,
} from "lucide-react";
const GraphExplorer = lazy(() => import("./GraphExplorer"));
import "./App.css";

class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[GraphExplorer crash]", error, info);
  }
  render() {
    if (this.state.error) {
      return this.props.fallback?.(this.state.error) ?? (
        <div className="min-h-screen bg-gray-950 text-red-400 flex items-center justify-center p-8">
          <div className="max-w-xl text-center">
            <XCircle className="w-10 h-10 mx-auto mb-4 opacity-60" />
            <h2 className="text-xl font-bold mb-2">Graph Explorer Error</h2>
            <pre className="text-sm whitespace-pre-wrap">{this.state.error.message}</pre>
            <pre className="text-xs text-gray-600 mt-2 whitespace-pre-wrap">{this.state.error.stack}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-gray-400 hover:text-violet-400 transition-colors p-1 rounded hover:bg-white/5"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function StatusBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        connected
          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
          : "bg-red-500/10 text-red-400 border border-red-500/20"
      }`}
    >
      {connected ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label}
    </span>
  );
}

function SyncPanel({ repo, onRefresh }: { repo: Repository; onRefresh: () => void }) {
  const [mode, setMode] = useState(repo.sync_mode || "off");
  const [localPath, setLocalPath] = useState(
    (repo.sync_config?.local_path as string) || ""
  );
  const [debounceMs, setDebounceMs] = useState(
    (repo.sync_config?.debounce_ms as number) || 30000
  );
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<{
    url: string;
    secret: string;
  } | null>(
    repo.sync_mode === "webhook"
      ? {
          url: `${window.location.origin}/api/webhooks/github`,
          secret: (repo.sync_config?.webhook_secret as string) || "",
        }
      : null
  );

  const loadEvents = useCallback(async () => {
    try {
      const data = await getSyncEvents(repo.id);
      setEvents(data);
    } catch {
      // ignore
    }
  }, [repo.id]);

  useEffect(() => {
    if (showEvents) loadEvents();
  }, [showEvents, loadEvents]);

  const handleModeChange = async (newMode: string) => {
    setSaving(true);
    setSyncError(null);
    try {
      const config: Record<string, unknown> = {};
      if (newMode === "watcher") {
        if (!localPath.trim()) {
          setSyncError("Local path is required for watcher mode");
          setSaving(false);
          return;
        }
        config.local_path = localPath.trim();
        config.debounce_ms = debounceMs;
      }

      const result = await updateSyncMode(repo.id, newMode, config);

      if (result.error) {
        setSyncError(result.error);
      } else {
        setMode(newMode);
        if (newMode === "webhook" && result.webhookSecret) {
          setWebhookInfo({
            url: `${window.location.origin}/api/webhooks/github`,
            secret: result.webhookSecret,
          });
        } else if (newMode !== "webhook") {
          setWebhookInfo(null);
        }
        onRefresh();
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Failed to update sync mode");
    } finally {
      setSaving(false);
    }
  };

  const syncModes = [
    { key: "off", label: "Off", icon: WifiOff, activeClass: "bg-gray-700/60 text-gray-300 border-gray-600" },
    { key: "webhook", label: "Webhook", icon: Webhook, activeClass: "bg-blue-500/10 text-blue-400 border-blue-500/30" },
    { key: "watcher", label: "Watcher", icon: FolderSync, activeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  ] as const;

  return (
    <div className="border-t border-white/5 px-5 py-4 space-y-3">
      {/* Sync Mode Toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 w-14 flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          Sync
        </span>
        <div className="flex gap-1.5">
          {syncModes.map(({ key, label, icon: Icon, activeClass }) => (
            <button
              key={key}
              onClick={() => handleModeChange(key)}
              disabled={saving}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all duration-200 ${
                mode === key
                  ? activeClass
                  : "bg-transparent border-white/5 text-gray-500 hover:text-gray-300 hover:border-white/10"
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
              {saving && mode !== key && <Loader2 className="w-3 h-3 animate-spin" />}
            </button>
          ))}
        </div>
      </div>

      {/* Webhook Info */}
      {mode === "webhook" && webhookInfo && (
        <div className="text-xs space-y-2 bg-blue-500/5 rounded-lg p-3 border border-blue-500/10">
          <div className="flex items-center gap-2">
            <Link2 className="w-3 h-3 text-gray-500 flex-shrink-0" />
            <span className="text-gray-500">URL:</span>
            <code className="bg-gray-800/80 px-2 py-0.5 rounded text-gray-300 select-all font-mono text-[11px]">
              {webhookInfo.url}
            </code>
            <CopyButton text={webhookInfo.url} />
          </div>
          <div className="flex items-center gap-2">
            <KeyRound className="w-3 h-3 text-gray-500 flex-shrink-0" />
            <span className="text-gray-500">Secret:</span>
            <code className="bg-gray-800/80 px-2 py-0.5 rounded text-gray-300 select-all font-mono text-[11px]">
              {webhookInfo.secret.substring(0, 12)}...
            </code>
            <CopyButton text={webhookInfo.secret} />
          </div>
          <p className="text-gray-500 mt-1 leading-relaxed">
            Add this webhook in GitHub: Settings &gt; Webhooks &gt; Add webhook. Select &quot;push&quot; events.
          </p>
        </div>
      )}

      {/* Watcher Config */}
      {(mode === "watcher" || mode === "off") && (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="/path/to/local/repo"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            className="flex-1 bg-gray-800/60 border border-white/5 rounded-md px-3 py-1.5 text-xs text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
          />
          <input
            type="number"
            value={debounceMs / 1000}
            onChange={(e) =>
              setDebounceMs(Math.max(5, Number(e.target.value)) * 1000)
            }
            className="w-16 bg-gray-800/60 border border-white/5 rounded-md px-2 py-1.5 text-xs text-gray-100 text-center input-focus-ring transition-shadow"
            title="Debounce seconds"
          />
          <span className="text-xs text-gray-600">sec</span>
        </div>
      )}

      {/* Last Synced */}
      {repo.last_synced_at && (
        <div className="text-xs text-gray-500 flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          Last synced: {new Date(repo.last_synced_at).toLocaleString()}
        </div>
      )}

      {/* Sync Error */}
      {syncError && (
        <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-md flex items-start gap-2 border border-red-500/10">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          {syncError}
        </div>
      )}

      {/* Sync Events Log */}
      <div>
        <button
          onClick={() => {
            setShowEvents(!showEvents);
            if (!showEvents) loadEvents();
          }}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5"
        >
          {showEvents ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {showEvents ? "Hide" : "Show"} sync log ({events.length})
        </button>
        {showEvents && events.length > 0 && (
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {events.map((evt) => (
              <div
                key={evt.id}
                className="flex items-center gap-3 text-xs py-1.5 px-2 rounded hover:bg-white/[0.02] transition-colors"
              >
                <CircleDot
                  className={`w-3 h-3 flex-shrink-0 ${
                    evt.status === "success"
                      ? "text-emerald-500"
                      : evt.status === "failed"
                        ? "text-red-500"
                        : "text-yellow-500"
                  }`}
                />
                <span className="text-gray-500">
                  {new Date(evt.started_at).toLocaleTimeString()}
                </span>
                <span className="text-gray-400">{evt.trigger}</span>
                {evt.files_changed > 0 && (
                  <span className="text-gray-500">
                    {evt.files_changed} changed
                  </span>
                )}
                {evt.duration_ms && (
                  <span className="text-gray-600">
                    {(evt.duration_ms / 1000).toFixed(1)}s
                  </span>
                )}
                {evt.error_log && (
                  <span className="text-red-400 truncate max-w-48" title={evt.error_log}>
                    {evt.error_log}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {showEvents && events.length === 0 && (
          <div className="mt-2 text-xs text-gray-600 flex items-center gap-1.5">
            <Inbox className="w-3 h-3" />
            No sync events yet.
          </div>
        )}
      </div>
    </div>
  );
}

function McpPanel() {
  const [copied, setCopied] = useState(false);

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        repograph: {
          command: "npx",
          args: ["-y", "@repograph/mcp-server"],
          env: {
            NEO4J_URI: "neo4j+s://3c68f875.databases.neo4j.io",
            NEO4J_USERNAME: "neo4j",
            NEO4J_PASSWORD: "<your-neo4j-password>",
            NEO4J_DATABASE: "neo4j",
            SUPABASE_URL: "https://rnjlipgcgrfacvsitwov.supabase.co",
            SUPABASE_SERVICE_KEY: "<your-supabase-key>",
          },
        },
      },
    },
    null,
    2
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(mcpConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="border-t border-white/5 px-5 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 flex items-center gap-1.5">
          <Network className="w-3 h-3" />
          MCP Connection
        </span>
        <button
          onClick={handleCopy}
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all duration-200 ${
            copied
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : "bg-violet-500/10 text-violet-400 border-violet-500/30 hover:bg-violet-500/20"
          }`}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy .mcp.json
            </>
          )}
        </button>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">
        Paste into <code className="bg-gray-800/80 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-400">.mcp.json</code> in
        any project root to connect Claude Code to this graph.
      </p>
      <pre className="bg-gray-900/80 border border-white/5 rounded-lg p-3 text-[11px] font-mono text-gray-400 overflow-x-auto leading-relaxed max-h-48 overflow-y-auto">
        {mcpConfig}
      </pre>
    </div>
  );
}

function App() {
  const [view, setView] = useState<"digest" | "explore">("digest");
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [digesting, setDigesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  const refreshRepos = useCallback(async () => {
    try {
      const data = await getRepositories();
      setRepos(data);
    } catch {
      // Backend might not be running
    }
  }, []);

  useEffect(() => {
    checkHealth().then(setHealth).catch(() => setHealth(null));
    refreshRepos();
  }, [refreshRepos]);

  if (view === "explore") {
    return (
      <ErrorBoundary>
        <Suspense fallback={
          <div className="min-h-screen bg-gray-950 text-gray-400 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
            <span>Loading graph...</span>
          </div>
        }>
          <GraphExplorer onBack={() => setView("digest")} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  const handleDigest = async () => {
    if (!url.trim()) return;
    setDigesting(true);
    setError(null);
    setErrorCode(null);
    setSuccess(null);

    try {
      const result = await startDigest(url.trim(), branch);
      setSuccess(
        `Digested ${result.stats?.fileCount ?? 0} files in ${((result.stats?.durationMs ?? 0) / 1000).toFixed(1)}s`
      );
      setUrl("");
      await refreshRepos();
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setErrorCode(code || null);
      setError(err instanceof Error ? err.message : "Digest failed");
    } finally {
      setDigesting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRepository(id);
      await refreshRepos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleReDigest = async (repo: Repository) => {
    setDigesting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await startDigest(repo.url, repo.branch);
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(
          `Re-digested ${result.stats?.fileCount ?? 0} files in ${((result.stats?.durationMs ?? 0) / 1000).toFixed(1)}s`
        );
        await refreshRepos();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-digest failed");
    } finally {
      setDigesting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Subtle top accent line */}
      <div className="h-px bg-gradient-to-r from-transparent via-violet-500/40 to-transparent" />

      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                <Network className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">RepoGraph</h1>
                <p className="text-sm text-gray-500 mt-0.5">
                  Repository knowledge graph for Claude Code
                </p>
              </div>
            </div>
            <button
              onClick={() => setView("explore")}
              disabled={repos.length === 0}
              className="group inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:border-transparent text-white px-5 py-2.5 rounded-lg font-medium transition-all duration-200 text-sm border border-violet-500/30 shadow-lg shadow-violet-500/10 hover:shadow-violet-500/20 disabled:shadow-none"
            >
              <Network className="w-4 h-4" />
              Explore Graph
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>

          {/* Health badges */}
          <div className="flex gap-2 mt-4">
            {health ? (
              <>
                <StatusBadge connected={health.neo4j === "connected"} label={`Neo4j: ${health.neo4j}`} />
                <StatusBadge connected={health.supabase === "connected"} label={`Supabase: ${health.supabase}`} />
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                <WifiOff className="w-3 h-3" />
                Backend unreachable
              </span>
            )}
          </div>
        </div>

        {/* Digest Input */}
        <div className="card-glass rounded-xl p-6 mb-8">
          <div className="flex items-center gap-2 mb-5">
            <Plus className="w-4 h-4 text-violet-400" />
            <h2 className="text-base font-semibold text-white">Digest a Repository</h2>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <GitBranch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              <input
                type="text"
                placeholder="https://github.com/user/repo or git@github.com:user/repo.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full bg-gray-800/60 border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
                onKeyDown={(e) => e.key === "Enter" && handleDigest()}
              />
            </div>
            <input
              type="text"
              placeholder="branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-28 bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 text-center input-focus-ring transition-shadow"
            />
            <button
              onClick={handleDigest}
              disabled={digesting || !url.trim()}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white px-5 py-2.5 rounded-lg font-medium transition-all duration-200 text-sm border border-blue-500/20 disabled:border-transparent shadow-lg shadow-blue-500/10 hover:shadow-blue-500/20 disabled:shadow-none"
            >
              {digesting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Digesting...
                </>
              ) : (
                <>
                  <Database className="w-4 h-4" />
                  Digest
                </>
              )}
            </button>
          </div>
          {error && (
            <div className="mt-4 text-red-400 text-sm bg-red-500/10 px-4 py-3 rounded-lg border border-red-500/10">
              {errorCode === "PRIVATE_REPO" ? (
                <div className="space-y-2">
                  <div className="font-medium flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Private Repository
                  </div>
                  <div className="text-red-300/80">{error}</div>
                  <div className="text-red-300/60 text-xs leading-relaxed">
                    To access private repos, add <code className="bg-red-900/40 px-1.5 py-0.5 rounded font-mono">GITHUB_TOKEN=ghp_your_token</code> to
                    your <code className="bg-red-900/40 px-1.5 py-0.5 rounded font-mono">.env</code> file and restart the backend.
                    Generate a token at{" "}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-red-300 hover:text-red-200"
                    >
                      GitHub Settings &rarr; Tokens
                    </a>{" "}
                    with <code className="bg-red-900/40 px-1.5 py-0.5 rounded font-mono">repo</code> scope.
                  </div>
                </div>
              ) : (
                <span className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </span>
              )}
            </div>
          )}
          {success && (
            <div className="mt-4 text-emerald-400 text-sm bg-emerald-500/10 px-4 py-3 rounded-lg flex items-center gap-2 border border-emerald-500/10">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              {success}
            </div>
          )}
        </div>

        {/* Repository List */}
        <div>
          <div className="flex items-center gap-2 mb-5">
            <FileCode2 className="w-4 h-4 text-gray-400" />
            <h2 className="text-base font-semibold text-white">
              Repositories
            </h2>
            <span className="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded-full">
              {repos.length}
            </span>
          </div>
          {repos.length === 0 && (
            <div className="card-glass rounded-xl p-12 text-center">
              <Inbox className="w-10 h-10 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">
                No repositories digested yet.
              </p>
              <p className="text-gray-600 text-xs mt-1">
                Paste a GitHub URL above to get started.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {repos.map((repo) => (
              <div
                key={repo.id}
                className="card-glass rounded-xl overflow-hidden transition-all duration-200 hover:border-white/10"
              >
                <div className="flex items-center justify-between px-5 py-4">
                  <div
                    className="flex-1 cursor-pointer group"
                    onClick={() =>
                      setExpandedRepo(
                        expandedRepo === repo.id ? null : repo.id
                      )
                    }
                  >
                    <div className="flex items-center gap-3">
                      {expandedRepo === repo.id ? (
                        <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0 transition-transform group-hover:translate-x-0.5" />
                      )}
                      <span className="font-medium text-white">
                        {repo.name}
                      </span>
                      <span className="text-gray-500 text-xs flex items-center gap-1">
                        <GitBranch className="w-3 h-3" />
                        {repo.branch}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md font-medium ${
                          repo.status === "idle"
                            ? "bg-emerald-500/10 text-emerald-400"
                            : repo.status === "digesting"
                              ? "bg-yellow-500/10 text-yellow-400 animate-pulse-soft"
                              : "bg-red-500/10 text-red-400"
                        }`}
                      >
                        {repo.status === "idle" && <CheckCircle2 className="w-3 h-3" />}
                        {repo.status === "digesting" && <Loader2 className="w-3 h-3 animate-spin" />}
                        {repo.status === "error" && <XCircle className="w-3 h-3" />}
                        {repo.status}
                      </span>
                      {repo.sync_mode !== "off" && (
                        <span
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md ${
                            repo.sync_mode === "webhook"
                              ? "bg-blue-500/10 text-blue-400"
                              : "bg-emerald-500/10 text-emerald-400"
                          }`}
                        >
                          {repo.sync_mode === "webhook" ? <Webhook className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
                          {repo.sync_mode}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 text-gray-500 text-xs mt-1.5 ml-7">
                      {repo.last_digest_at && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Digest: {new Date(repo.last_digest_at).toLocaleString()}
                        </span>
                      )}
                      {repo.last_synced_at && (
                        <span className="flex items-center gap-1">
                          <RefreshCw className="w-3 h-3" />
                          Sync: {new Date(repo.last_synced_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleReDigest(repo)}
                      disabled={digesting}
                      className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 disabled:text-gray-600 px-3 py-1.5 rounded-md hover:bg-blue-500/10 transition-colors"
                      title="Re-digest repository"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Re-Digest
                    </button>
                    <button
                      onClick={() => handleDelete(repo.id)}
                      className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 px-3 py-1.5 rounded-md hover:bg-red-500/10 transition-colors"
                      title="Delete repository"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
                {expandedRepo === repo.id && (
                  <div>
                    <div className="border-t border-white/5 px-5 py-3 text-sm text-gray-400 space-y-1">
                      <div className="flex items-center gap-2">
                        <Link2 className="w-3.5 h-3.5 text-gray-500" />
                        {repo.url}
                      </div>
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <GitBranch className="w-3.5 h-3.5 text-gray-500" />
                        {repo.commit_sha || "n/a"}
                      </div>
                    </div>
                    <SyncPanel repo={repo} onRefresh={refreshRepos} />
                    <McpPanel />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
