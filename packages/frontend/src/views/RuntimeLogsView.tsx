import { useState, useEffect, useCallback, useRef } from "react";
import {
  getRepositories,
  getRuntimeLogs,
  getRuntimeLogStats,
  type Repository,
  type RuntimeLogEntry,
  type RuntimeLogStats,
} from "../api";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileCode2,
  Filter,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  ScrollText,
  X,
} from "lucide-react";

const LEVELS = ["error", "warn", "info"] as const;
const PAGE_SIZES = [25, 50, 100];

const LEVEL_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  error: { dot: "bg-red-500", text: "text-red-400", bg: "bg-red-500/10" },
  warn: { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-500/10" },
  info: { dot: "bg-blue-500", text: "text-blue-400", bg: "bg-blue-500/10" },
};

const TIME_RANGES = [
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "All", ms: 0 },
];

export default function RuntimeLogsView() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([]);
  const [stats, setStats] = useState<RuntimeLogStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [timeRange, setTimeRange] = useState(TIME_RANGES[3]); // 24h default

  // Expandable
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const sinceTs = timeRange.ms
    ? new Date(Date.now() - timeRange.ms).toISOString()
    : undefined;

  const loadData = useCallback(async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    setError(null);
    try {
      const [logPage, logStats] = await Promise.all([
        getRuntimeLogs(selectedRepoId, {
          level: levelFilter || undefined,
          source: sourceFilter || undefined,
          search: activeSearch || undefined,
          since: sinceTs,
          page,
          pageSize,
        }),
        getRuntimeLogStats(selectedRepoId, sinceTs),
      ]);
      setEntries(logPage.entries);
      setTotal(logPage.total);
      setStats(logStats);
    } catch {
      setError("Failed to load runtime logs");
      setEntries([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId, levelFilter, sourceFilter, activeSearch, sinceTs, page, pageSize]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadData, 15_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, loadData]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [levelFilter, sourceFilter, activeSearch, timeRange, selectedRepoId]);

  const handleSearch = () => {
    setActiveSearch(searchQuery);
  };

  const clearSearch = () => {
    setSearchQuery("");
    setActiveSearch("");
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalPages = Math.ceil(total / pageSize);
  const sources = stats ? Object.keys(stats.bySource) : [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Runtime Logs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Production log entries from connected platforms
          </p>
        </div>

        {/* Controls Row 1: Repo + Time Range + Auto-refresh */}
        <div className="flex items-center gap-3 mb-4">
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

          {/* Time range buttons */}
          <div className="flex gap-1">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr.label}
                onClick={() => setTimeRange(tr)}
                className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                  timeRange.label === tr.label
                    ? "bg-violet-500/10 text-violet-400 border border-violet-500/30"
                    : "text-gray-500 border border-white/5 hover:text-gray-300"
                }`}
              >
                {tr.label}
              </button>
            ))}
          </div>

          {/* Auto-refresh + manual refresh */}
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                autoRefresh
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "text-gray-500 border-white/5 hover:text-gray-300"
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${autoRefresh ? "animate-spin" : ""}`} />
              Auto
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-white/5 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Controls Row 2: Level + Source + Search */}
        <div className="flex items-center gap-3 mb-6">
          {/* Level filters */}
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-gray-500" />
            <button
              onClick={() => setLevelFilter(null)}
              className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                levelFilter === null
                  ? "bg-white/[0.06] text-gray-200"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
              }`}
            >
              All{stats ? ` (${stats.total})` : ""}
            </button>
            {LEVELS.map((lvl) => {
              const count = stats?.byLevel[lvl] ?? 0;
              const style = LEVEL_STYLES[lvl];
              return (
                <button
                  key={lvl}
                  onClick={() => setLevelFilter(levelFilter === lvl ? null : lvl)}
                  className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    levelFilter === lvl
                      ? `${style.bg} ${style.text}`
                      : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
                  }`}
                >
                  {lvl} ({count})
                </button>
              );
            })}
          </div>

          {/* Source filter */}
          {sources.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-600">|</span>
              {sources.map((src) => (
                <button
                  key={src}
                  onClick={() => setSourceFilter(sourceFilter === src ? null : src)}
                  className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    sourceFilter === src
                      ? "bg-violet-500/10 text-violet-400"
                      : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
                  }`}
                >
                  {src} ({stats?.bySource[src] ?? 0})
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="relative ml-auto">
            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="bg-gray-800/60 border border-white/5 rounded-lg pl-9 pr-8 py-2 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow w-64"
            />
            {searchQuery && (
              <button
                onClick={clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Loading state */}
        {loading && entries.length === 0 && (
          <div className="card-glass rounded-xl p-12 text-center">
            <Loader2 className="w-6 h-6 animate-spin text-violet-400 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Loading logs...</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="card-glass rounded-xl p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={loadData}
              className="mt-3 text-xs text-gray-400 hover:text-gray-200 underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty states */}
        {!loading && !error && repos.length === 0 && (
          <div className="card-glass rounded-xl p-12 text-center">
            <Inbox className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">No repositories found.</p>
            <p className="text-gray-600 text-xs mt-1">
              Add a repository and connect a log source to see runtime logs.
            </p>
          </div>
        )}

        {!loading && !error && repos.length > 0 && entries.length === 0 && (
          <div className="card-glass rounded-xl p-12 text-center">
            <ScrollText className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">
              {activeSearch
                ? `No logs matching "${activeSearch}" in this time range.`
                : "No runtime logs in this time range."}
            </p>
            <p className="text-gray-600 text-xs mt-1">
              Try expanding the time range or check that a log source is connected.
            </p>
          </div>
        )}

        {/* Log entries */}
        {!error && entries.length > 0 && (
          <>
            <div className="space-y-1.5">
              {entries.map((entry) => {
                const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
                const hasStack = !!entry.stack_trace;
                const isExpanded = expandedIds.has(entry.id);

                return (
                  <div
                    key={entry.id}
                    className="card-glass rounded-lg px-4 py-3 transition-all duration-150 hover:border-white/10"
                  >
                    <div
                      className={`flex items-start gap-3 ${hasStack ? "cursor-pointer select-none" : ""}`}
                      onClick={hasStack ? () => toggleExpand(entry.id) : undefined}
                    >
                      {/* Level dot */}
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${style.dot}`} />

                      {/* Main content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-xs font-medium uppercase ${style.text}`}>
                            {entry.level}
                          </span>
                          <span className="text-xs text-gray-600">
                            {entry.source}
                          </span>
                          {entry.function_name && (
                            <span className="text-xs text-gray-500 font-mono truncate">
                              {entry.function_name}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-200 break-words leading-relaxed">
                          {entry.message}
                        </p>
                        {entry.file_path && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <FileCode2 className="w-3 h-3 text-gray-500 flex-shrink-0" />
                            <span className="text-xs text-gray-400 font-mono">
                              {entry.file_path}
                              {entry.line_number != null && `:${entry.line_number}`}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Timestamp */}
                      <span className="text-xs text-gray-500 flex items-center gap-1.5 tabular-nums flex-shrink-0 mt-0.5">
                        <Clock className="w-3 h-3" />
                        {new Date(entry.timestamp).toLocaleString()}
                      </span>

                      {/* Expand indicator */}
                      {hasStack && (
                        <ChevronRight
                          className={`w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5 transition-transform duration-200 ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                      )}
                    </div>

                    {/* Stack trace */}
                    {isExpanded && entry.stack_trace && (
                      <div className="mt-3 ml-5">
                        <pre className="text-xs text-gray-400 bg-gray-900/60 border border-white/5 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
                          {entry.stack_trace}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  {total} total · page {page} of {totalPages || 1}
                </span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="appearance-none bg-gray-800/60 border border-white/5 rounded-md px-2 py-1 text-xs text-gray-300 input-focus-ring cursor-pointer"
                >
                  {PAGE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}/page
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3 h-3" />
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
