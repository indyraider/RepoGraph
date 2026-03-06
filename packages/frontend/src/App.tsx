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
          <div className="max-w-xl">
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

  return (
    <div className="border-t border-gray-800 px-5 py-3 space-y-3">
      {/* Sync Mode Toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 w-16">Sync:</span>
        {(["off", "webhook", "watcher"] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeChange(m)}
            disabled={saving}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              mode === m
                ? m === "off"
                  ? "bg-gray-700 text-gray-300"
                  : m === "webhook"
                    ? "bg-blue-900/50 text-blue-400"
                    : "bg-green-900/50 text-green-400"
                : "bg-gray-800 text-gray-500 hover:text-gray-300"
            }`}
          >
            {m === "off" ? "Off" : m === "webhook" ? "Webhook" : "Watcher"}
          </button>
        ))}
      </div>

      {/* Webhook Info */}
      {mode === "webhook" && webhookInfo && (
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">URL:</span>
            <code className="bg-gray-800 px-2 py-0.5 rounded text-gray-300 select-all">
              {webhookInfo.url}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(webhookInfo.url)}
              className="text-blue-400 hover:text-blue-300"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Secret:</span>
            <code className="bg-gray-800 px-2 py-0.5 rounded text-gray-300 select-all">
              {webhookInfo.secret.substring(0, 12)}...
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(webhookInfo.secret)}
              className="text-blue-400 hover:text-blue-300"
            >
              Copy
            </button>
          </div>
          <p className="text-gray-600 mt-1">
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
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:border-green-500"
          />
          <input
            type="number"
            value={debounceMs / 1000}
            onChange={(e) =>
              setDebounceMs(Math.max(5, Number(e.target.value)) * 1000)
            }
            className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 text-center focus:outline-none focus:border-green-500"
            title="Debounce seconds"
          />
          <span className="text-xs text-gray-600">s</span>
        </div>
      )}

      {/* Last Synced */}
      {repo.last_synced_at && (
        <div className="text-xs text-gray-500">
          Last synced: {new Date(repo.last_synced_at).toLocaleString()}
        </div>
      )}

      {/* Sync Error */}
      {syncError && (
        <div className="text-xs text-red-400 bg-red-900/20 px-2 py-1 rounded">
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
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          {showEvents ? "Hide" : "Show"} sync log ({events.length})
        </button>
        {showEvents && events.length > 0 && (
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {events.map((evt) => (
              <div
                key={evt.id}
                className="flex items-center gap-3 text-xs py-1"
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    evt.status === "success"
                      ? "bg-green-500"
                      : evt.status === "failed"
                        ? "bg-red-500"
                        : "bg-yellow-500"
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
          <div className="mt-1 text-xs text-gray-600">No sync events yet.</div>
        )}
      </div>
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
        <Suspense fallback={<div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">Loading graph...</div>}>
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
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white">RepoGraph</h1>
              <p className="text-gray-400 mt-1">
                GitHub repository knowledge graph for Claude Code
              </p>
            </div>
            <button
              onClick={() => setView("explore")}
              disabled={repos.length === 0}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-5 py-2.5 rounded-lg font-medium transition-colors text-sm"
            >
              Explore Graph
            </button>
          </div>
          {health && (
            <div className="flex gap-3 mt-3 text-sm">
              <span
                className={`px-2 py-0.5 rounded ${
                  health.neo4j === "connected"
                    ? "bg-green-900/50 text-green-400"
                    : "bg-red-900/50 text-red-400"
                }`}
              >
                Neo4j: {health.neo4j}
              </span>
              <span
                className={`px-2 py-0.5 rounded ${
                  health.supabase === "connected"
                    ? "bg-green-900/50 text-green-400"
                    : "bg-red-900/50 text-red-400"
                }`}
              >
                Supabase: {health.supabase}
              </span>
            </div>
          )}
          {!health && (
            <div className="mt-3 text-sm px-2 py-0.5 rounded bg-red-900/50 text-red-400 inline-block">
              Backend unreachable
            </div>
          )}
        </div>

        {/* Digest Input */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Digest a Repository</h2>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="https://github.com/user/repo or git@github.com:user/repo.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              onKeyDown={(e) => e.key === "Enter" && handleDigest()}
            />
            <input
              type="text"
              placeholder="branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-32 bg-gray-800 border border-gray-700 rounded px-4 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleDigest}
              disabled={digesting || !url.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-6 py-2 rounded font-medium transition-colors"
            >
              {digesting ? "Digesting..." : "Digest"}
            </button>
          </div>
          {error && (
            <div className="mt-3 text-red-400 text-sm bg-red-900/20 px-3 py-2 rounded">
              {errorCode === "PRIVATE_REPO" ? (
                <div className="space-y-2">
                  <div className="font-medium">Private Repository</div>
                  <div className="text-red-300/80">{error}</div>
                  <div className="text-red-300/60 text-xs">
                    To access private repos, add <code className="bg-red-900/40 px-1 rounded">GITHUB_TOKEN=ghp_your_token</code> to
                    your <code className="bg-red-900/40 px-1 rounded">.env</code> file and restart the backend.
                    Generate a token at{" "}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-red-300 hover:text-red-200"
                    >
                      GitHub Settings → Tokens
                    </a>{" "}
                    with <code className="bg-red-900/40 px-1 rounded">repo</code> scope.
                  </div>
                </div>
              ) : (
                error
              )}
            </div>
          )}
          {success && (
            <div className="mt-3 text-green-400 text-sm bg-green-900/20 px-3 py-2 rounded">
              {success}
            </div>
          )}
        </div>

        {/* Repository List */}
        <div>
          <h2 className="text-lg font-semibold mb-4">
            Repositories ({repos.length})
          </h2>
          {repos.length === 0 && (
            <p className="text-gray-500">
              No repositories digested yet. Paste a URL above to get started.
            </p>
          )}
          <div className="space-y-2">
            {repos.map((repo) => (
              <div
                key={repo.id}
                className="bg-gray-900 border border-gray-800 rounded-lg"
              >
                <div className="flex items-center justify-between px-5 py-4">
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() =>
                      setExpandedRepo(
                        expandedRepo === repo.id ? null : repo.id
                      )
                    }
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-white">
                        {repo.name}
                      </span>
                      <span className="text-gray-500 text-sm">
                        {repo.branch}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          repo.status === "idle"
                            ? "bg-green-900/50 text-green-400"
                            : repo.status === "digesting"
                              ? "bg-yellow-900/50 text-yellow-400"
                              : "bg-red-900/50 text-red-400"
                        }`}
                      >
                        {repo.status}
                      </span>
                      {repo.sync_mode !== "off" && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            repo.sync_mode === "webhook"
                              ? "bg-blue-900/50 text-blue-400"
                              : "bg-green-900/50 text-green-400"
                          }`}
                        >
                          {repo.sync_mode}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 text-gray-500 text-xs mt-1">
                      {repo.last_digest_at && (
                        <span>
                          Last digest:{" "}
                          {new Date(repo.last_digest_at).toLocaleString()}
                        </span>
                      )}
                      {repo.last_synced_at && (
                        <span>
                          Last sync:{" "}
                          {new Date(repo.last_synced_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReDigest(repo)}
                      disabled={digesting}
                      className="text-sm text-blue-400 hover:text-blue-300 disabled:text-gray-600 px-3 py-1"
                    >
                      Re-Digest
                    </button>
                    <button
                      onClick={() => handleDelete(repo.id)}
                      className="text-sm text-red-400 hover:text-red-300 px-3 py-1"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {expandedRepo === repo.id && (
                  <div>
                    <div className="border-t border-gray-800 px-5 py-3 text-sm text-gray-400">
                      <div>URL: {repo.url}</div>
                      <div>Commit: {repo.commit_sha || "n/a"}</div>
                    </div>
                    <SyncPanel repo={repo} onRefresh={refreshRepos} />
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
