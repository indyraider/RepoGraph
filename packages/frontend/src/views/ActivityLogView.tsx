import { useState, useEffect, useCallback } from "react";
import {
  getRepositories,
  getSyncEvents,
  type Repository,
  type SyncEvent,
} from "../api";
import {
  Activity,
  ChevronDown,
  CircleDot,
  Clock,
  FileCode2,
  Inbox,
  Loader2,
  AlertTriangle,
  Filter,
} from "lucide-react";

export default function ActivityLogView() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Load events when repo changes
  const loadEvents = useCallback(async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getSyncEvents(selectedRepoId);
      setEvents(data);
    } catch {
      setError("Failed to load sync events");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);

  const filteredEvents = filterStatus
    ? events.filter((e) => e.status === filterStatus)
    : events;

  const statusCounts = events.reduce(
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
              All ({events.length})
            </button>
            {Object.entries(statusCounts).map(([status, count]) => (
              <button
                key={status}
                onClick={() => setFilterStatus(filterStatus === status ? null : status)}
                className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  filterStatus === status
                    ? status === "success"
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

          {/* Event count */}
          <span className="text-xs text-gray-500 ml-auto tabular-nums">
            {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
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

        {/* Empty events */}
        {!loading && !error && repos.length > 0 && filteredEvents.length === 0 && (
          <div className="card-glass rounded-xl p-12 text-center">
            <Activity className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">
              {filterStatus
                ? `No "${filterStatus}" events for ${selectedRepo?.name || "this repo"}.`
                : `No sync events for ${selectedRepo?.name || "this repo"} yet.`}
            </p>
            <p className="text-gray-600 text-xs mt-1">
              Configure a sync mode on the Dashboard to start generating events.
            </p>
          </div>
        )}

        {/* Events list */}
        {!loading && !error && filteredEvents.length > 0 && (
          <div className="space-y-2">
            {filteredEvents.map((evt) => (
              <div
                key={evt.id}
                className="card-glass rounded-xl px-5 py-4 transition-all duration-200 hover:border-white/10"
              >
                <div className="flex items-center gap-4">
                  {/* Status indicator */}
                  <CircleDot
                    className={`w-4 h-4 flex-shrink-0 ${
                      evt.status === "success"
                        ? "text-emerald-500"
                        : evt.status === "failed"
                          ? "text-red-500"
                          : "text-yellow-500"
                    }`}
                  />

                  {/* Trigger */}
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

                  {/* Status */}
                  <span
                    className={`text-xs font-medium ${
                      evt.status === "success"
                        ? "text-emerald-400"
                        : evt.status === "failed"
                          ? "text-red-400"
                          : "text-yellow-400"
                    }`}
                  >
                    {evt.status}
                  </span>

                  {/* File changes */}
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

                  {/* Timestamp */}
                  <span className="text-xs text-gray-500 ml-auto flex items-center gap-1.5 tabular-nums">
                    <Clock className="w-3 h-3" />
                    {new Date(evt.started_at).toLocaleString()}
                  </span>
                </div>

                {/* Error log */}
                {evt.error_log && (
                  <div className="mt-3 text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-md border border-red-500/10">
                    <AlertTriangle className="w-3 h-3 inline mr-1.5" />
                    {evt.error_log}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
