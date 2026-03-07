import { useState, useEffect, useCallback } from "react";
import {
  getRepositories,
  getSyncEvents,
  getDigestJobs,
  type Repository,
  type SyncEvent,
  type DigestJob,
} from "../api";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Database,
  FileCode2,
  FileMinus2,
  GitCommitHorizontal,
  Inbox,
  Loader2,
  AlertTriangle,
  Filter,
} from "lucide-react";

const DELTA_LABELS: Record<string, string> = {
  fileCount: "files",
  symbolCount: "symbols",
  importCount: "imports",
  directImportCount: "direct imports",
  resolvedImports: "resolved",
  unresolvedImports: "unresolved",
  nodeCount: "nodes",
  edgeCount: "edges",
  packageCount: "packages",
  exportedSymbolCount: "exported symbols",
};

function computeJobDelta(
  job: DigestJob,
  previousJob: DigestJob | undefined
): { label: string; value: number }[] {
  if (!previousJob?.stats || !job.stats) return [];
  const keys = Object.keys(DELTA_LABELS);
  const entries: { label: string; value: number }[] = [];
  for (const k of keys) {
    const curr = (job.stats as Record<string, number>)[k] ?? 0;
    const prev = (previousJob.stats as Record<string, number>)[k] ?? 0;
    const diff = curr - prev;
    if (diff !== 0) entries.push({ label: DELTA_LABELS[k], value: diff });
  }
  return entries;
}

export default function ActivityLogView() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [tab, setTab] = useState<"sync" | "digests">("digests");
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [jobs, setJobs] = useState<DigestJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);

  // Load repos on mount
  useEffect(() => {
    getRepositories()
      .then((r) => {
        setRepos(r);
        if (r.length > 0) setSelectedRepoId(r[0].id);
      })
      .catch(() => setError("Failed to load repositories"))
      .finally(() => setLoading(false));
  }, []);

  // Load data when repo or tab changes
  const loadData = useCallback(async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    setError(null);
    try {
      if (tab === "sync") {
        const data = await getSyncEvents(selectedRepoId);
        setEvents(data);
      } else {
        const data = await getDigestJobs(selectedRepoId);
        setJobs(data);
      }
    } catch {
      setError(tab === "sync" ? "Failed to load sync events" : "Failed to load digest jobs");
      if (tab === "sync") setEvents([]);
      else setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId, tab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);

  const filteredEvents = filterStatus
    ? events.filter((e) => e.status === filterStatus)
    : events;

  const filteredJobs = filterStatus
    ? jobs.filter((j) => j.status === filterStatus)
    : jobs;

  const items = tab === "sync" ? events : jobs;
  const statusCounts = items.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Activity Log</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Sync events and digest history
              </p>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-4 mb-6">
          {/* Repo selector */}
          <div className="relative">
            <select
              value={selectedRepoId || ""}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              className="appearance-none bg-gray-800/60 border border-white/5 rounded-lg pl-3 pr-9 py-2.5 text-sm text-gray-100 input-focus-ring transition-shadow cursor-pointer min-w-[200px]"
            >
              {repos.length === 0 && <option value="">No repositories</option>}
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.branch})
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-gray-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Tab toggle */}
          <div className="flex gap-1.5">
            <button
              onClick={() => { setTab("digests"); setFilterStatus(null); }}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all ${
                tab === "digests"
                  ? "bg-violet-500/10 text-violet-400 border-violet-500/30"
                  : "text-gray-500 border-white/5 hover:text-gray-300"
              }`}
            >
              <Database className="w-3 h-3" />
              Digests
            </button>
            <button
              onClick={() => { setTab("sync"); setFilterStatus(null); }}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all ${
                tab === "sync"
                  ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                  : "text-gray-500 border-white/5 hover:text-gray-300"
              }`}
            >
              <Activity className="w-3 h-3" />
              Sync Events
            </button>
          </div>

          {/* Status filters */}
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-gray-500" />
            <button
              onClick={() => setFilterStatus(null)}
              className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                filterStatus === null
                  ? "bg-white/[0.06] text-gray-200"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
              }`}
            >
              All ({items.length})
            </button>
            {Object.entries(statusCounts).map(([status, count]) => (
              <button
                key={status}
                onClick={() => setFilterStatus(filterStatus === status ? null : status)}
                className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  filterStatus === status
                    ? status === "success" || status === "complete"
                      ? "bg-emerald-500/10 text-emerald-400"
                      : status === "failed"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-yellow-500/10 text-yellow-400"
                    : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
                }`}
              >
                {status} ({count})
              </button>
            ))}
          </div>

          {/* Item count */}
          <span className="text-xs text-gray-500 ml-auto tabular-nums">
            {(tab === "sync" ? filteredEvents.length : filteredJobs.length)}{" "}
            {tab === "sync" ? "event" : "job"}
            {(tab === "sync" ? filteredEvents.length : filteredJobs.length) !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="card-glass rounded-xl p-12 text-center">
            <Loader2 className="w-6 h-6 animate-spin text-violet-400 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Loading events...</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="card-glass rounded-xl p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && repos.length === 0 && (
          <div className="card-glass rounded-xl p-12 text-center">
            <Inbox className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">No repositories digested yet.</p>
            <p className="text-gray-600 text-xs mt-1">
              Digest a repository from the Dashboard to see activity here.
            </p>
          </div>
        )}

        {/* Empty state for current tab */}
        {!loading && !error && repos.length > 0 &&
          (tab === "sync" ? filteredEvents.length === 0 : filteredJobs.length === 0) && (
          <div className="card-glass rounded-xl p-12 text-center">
            {tab === "sync" ? (
              <Activity className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            ) : (
              <Database className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            )}
            <p className="text-gray-500 text-sm">
              {filterStatus
                ? `No "${filterStatus}" ${tab === "sync" ? "events" : "jobs"} for ${selectedRepo?.name || "this repo"}.`
                : `No ${tab === "sync" ? "sync events" : "digest jobs"} for ${selectedRepo?.name || "this repo"} yet.`}
            </p>
          </div>
        )}

        {/* Sync Events list */}
        {!loading && !error && tab === "sync" && filteredEvents.length > 0 && (
          <div className="space-y-2">
            {filteredEvents.map((evt) => {
              const hasSummary = evt.summary && (
                (evt.summary.commits && evt.summary.commits.length > 0) ||
                (evt.summary.changedPaths && evt.summary.changedPaths.length > 0) ||
                (evt.summary.deletedPaths && evt.summary.deletedPaths.length > 0)
              );
              const isExpanded = expandedEvents.has(evt.id);
              const toggleExpand = () => {
                setExpandedEvents((prev) => {
                  const next = new Set(prev);
                  if (next.has(evt.id)) next.delete(evt.id);
                  else next.add(evt.id);
                  return next;
                });
              };
              return (
                <div
                  key={evt.id}
                  className="card-glass rounded-xl px-5 py-4 transition-all duration-200 hover:border-white/10"
                >
                  <div
                    className={`flex items-center gap-4 ${hasSummary ? "cursor-pointer select-none" : ""}`}
                    onClick={hasSummary ? toggleExpand : undefined}
                  >
                    {hasSummary ? (
                      <ChevronRight className={`w-4 h-4 flex-shrink-0 text-gray-500 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                    ) : (
                      <CircleDot
                        className={`w-4 h-4 flex-shrink-0 ${
                          evt.status === "success"
                            ? "text-emerald-500"
                            : evt.status === "failed"
                              ? "text-red-500"
                              : "text-yellow-500"
                        }`}
                      />
                    )}
                    <span
                      className={`text-xs px-2 py-0.5 rounded-md font-medium ${
                        evt.trigger === "webhook"
                          ? "bg-blue-500/10 text-blue-400"
                          : evt.trigger === "watcher"
                            ? "bg-emerald-500/10 text-emerald-400"
                            : "bg-gray-700/60 text-gray-300"
                      }`}
                    >
                      {evt.trigger}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        evt.status === "success" ? "text-emerald-400" : evt.status === "failed" ? "text-red-400" : "text-yellow-400"
                      }`}
                    >
                      {evt.status}
                    </span>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      {(evt.files_changed > 0 || evt.files_added > 0 || evt.files_removed > 0) && (
                        <span className="flex items-center gap-1">
                          <FileCode2 className="w-3 h-3" />
                          {evt.files_changed > 0 && <span>{evt.files_changed} changed</span>}
                          {evt.files_added > 0 && <span className="text-emerald-500">+{evt.files_added}</span>}
                          {evt.files_removed > 0 && <span className="text-red-500">-{evt.files_removed}</span>}
                        </span>
                      )}
                      {evt.duration_ms != null && (
                        <span>{(evt.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500 ml-auto flex items-center gap-1.5 tabular-nums">
                      <Clock className="w-3 h-3" />
                      {new Date(evt.started_at).toLocaleString()}
                    </span>
                  </div>
                  {/* Expandable summary */}
                  {isExpanded && evt.summary && (
                    <div className="mt-3 ml-8 space-y-2.5">
                      {evt.summary.commits && evt.summary.commits.length > 0 && (
                        <div className="space-y-1">
                          {evt.summary.commits.map((c) => (
                            <div key={c.sha} className="flex items-center gap-2 text-xs">
                              <GitCommitHorizontal className="w-3 h-3 text-gray-500 flex-shrink-0" />
                              <span className="text-gray-500 font-mono">{c.sha}</span>
                              <span className="text-gray-300 truncate">{c.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {evt.summary.changedPaths && evt.summary.changedPaths.length > 0 && (
                        <div className="space-y-0.5">
                          <span className="text-xs text-gray-500 font-medium">Changed files</span>
                          {evt.summary.changedPaths.map((p) => (
                            <div key={p} className="flex items-center gap-2 text-xs">
                              <FileCode2 className="w-3 h-3 text-blue-400 flex-shrink-0" />
                              <span className="text-gray-400 font-mono truncate">{p}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {evt.summary.deletedPaths && evt.summary.deletedPaths.length > 0 && (
                        <div className="space-y-0.5">
                          <span className="text-xs text-gray-500 font-medium">Deleted files</span>
                          {evt.summary.deletedPaths.map((p) => (
                            <div key={p} className="flex items-center gap-2 text-xs">
                              <FileMinus2 className="w-3 h-3 text-red-400 flex-shrink-0" />
                              <span className="text-gray-400 font-mono truncate">{p}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {evt.error_log && (
                    <div className="mt-3 text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-md border border-red-500/10">
                      <AlertTriangle className="w-3 h-3 inline mr-1.5" />
                      {evt.error_log}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Digest Jobs list */}
        {!loading && !error && tab === "digests" && filteredJobs.length > 0 && (
          <div className="space-y-2">
            {filteredJobs.map((job, idx) => {
              const prevJob = filteredJobs[idx + 1]; // jobs are sorted newest-first
              const delta = job.status === "complete" ? computeJobDelta(job, prevJob) : [];
              return (
                <div
                  key={job.id}
                  className="card-glass rounded-xl px-5 py-4 transition-all duration-200 hover:border-white/10"
                >
                  <div className="flex items-center gap-4">
                    <CircleDot
                      className={`w-4 h-4 flex-shrink-0 ${
                        job.status === "complete"
                          ? "text-emerald-500"
                          : job.status === "failed"
                            ? "text-red-500"
                            : "text-yellow-500"
                      }`}
                    />
                    <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-violet-500/10 text-violet-400">
                      {job.stage === "done" ? "digest" : job.stage}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        job.status === "complete" ? "text-emerald-400" : job.status === "failed" ? "text-red-400" : "text-yellow-400"
                      }`}
                    >
                      {job.status}
                    </span>
                    {job.stats && (
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span>{job.stats.fileCount ?? 0} files</span>
                        <span>{job.stats.symbolCount ?? 0} symbols</span>
                        <span>{job.stats.edgeCount ?? 0} edges</span>
                        {job.stats.durationMs != null && (
                          <span>{(job.stats.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                    )}
                    <span className="text-xs text-gray-500 ml-auto flex items-center gap-1.5 tabular-nums">
                      <Clock className="w-3 h-3" />
                      {new Date(job.started_at).toLocaleString()}
                    </span>
                  </div>
                  {/* Delta badges */}
                  {delta.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5 ml-8">
                      {delta.map(({ label, value }) => (
                        <span
                          key={label}
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md font-medium ${
                            value > 0
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-red-500/10 text-red-400"
                          }`}
                        >
                          {value > 0 ? "+" : ""}{value} {label}
                        </span>
                      ))}
                    </div>
                  )}
                  {job.error_log && (
                    <div className="mt-3 text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-md border border-red-500/10">
                      <AlertTriangle className="w-3 h-3 inline mr-1.5" />
                      {job.error_log}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
