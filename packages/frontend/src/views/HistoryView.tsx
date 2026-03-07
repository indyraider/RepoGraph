import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../AuthProvider";
import {
  getRepositories,
  getCommits,
  type Repository,
  type CommitSummary,
} from "../api";
import {
  GitCommitHorizontal,
  Clock,
  TrendingUp,
  User,
  GitCompareArrows,
  Loader2,
  Inbox,
} from "lucide-react";
import { SymbolTimeline } from "../components/temporal/SymbolTimeline";
import { ComplexityTrendChart } from "../components/temporal/ComplexityTrendChart";
import { StructuralBlamePanel } from "../components/temporal/StructuralBlamePanel";
import { DiffExplorer } from "../components/temporal/DiffExplorer";
import { BackfillPanel } from "../components/temporal/BackfillPanel";

const TABS = [
  { id: "timeline", label: "Symbol Timeline", icon: Clock },
  { id: "complexity", label: "Complexity", icon: TrendingUp },
  { id: "blame", label: "Blame", icon: User },
  { id: "diff", label: "Diff Explorer", icon: GitCompareArrows },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function HistoryView() {
  const { githubToken } = useAuth();
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [tab, setTab] = useState<TabId>("timeline");
  const [loading, setLoading] = useState(true);
  const [commitsLoading, setCommitsLoading] = useState(false);

  // Load repos on mount
  useEffect(() => {
    getRepositories()
      .then((r) => {
        setRepos(r);
        if (r.length > 0) setSelectedRepoId(r[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load commits when repo changes
  const loadCommits = useCallback(async (repoId: string) => {
    setCommitsLoading(true);
    try {
      const c = await getCommits(repoId, 100);
      setCommits(c);
    } catch {
      setCommits([]);
    } finally {
      setCommitsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedRepoId) loadCommits(selectedRepoId);
  }, [selectedRepoId, loadCommits]);

  const handleBackfillComplete = useCallback(() => {
    if (selectedRepoId) loadCommits(selectedRepoId);
  }, [selectedRepoId, loadCommits]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-500 gap-3">
        <Inbox className="w-10 h-10 opacity-40" />
        <p className="text-sm">No repositories found</p>
        <p className="text-xs">Import a repository from the Dashboard first</p>
      </div>
    );
  }

  const hasTemporalData = commits.length > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-white/[0.06] px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
              <GitCommitHorizontal className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-gray-100">Code History</h1>
              <p className="text-xs text-gray-500">
                {hasTemporalData
                  ? `${commits.length} commits tracked`
                  : "No temporal data yet"}
              </p>
            </div>
          </div>

          {/* Repo selector */}
          <select
            value={selectedRepoId || ""}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            className="px-3 py-2 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 focus:outline-none focus:border-violet-500/40 max-w-xs truncate"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        {/* Tabs */}
        {hasTemporalData && (
          <div className="flex gap-1 mt-4">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors ${
                    tab === t.id
                      ? "bg-violet-500/10 text-violet-400 border border-violet-500/20"
                      : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.02] border border-transparent"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {commitsLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : !hasTemporalData ? (
          /* Empty state — no temporal data */
          <div className="max-w-lg mx-auto space-y-6 py-8">
            <div className="text-center">
              <GitCommitHorizontal className="w-12 h-12 mx-auto mb-3 text-gray-600 opacity-40" />
              <h2 className="text-lg font-medium text-gray-300">No temporal data yet</h2>
              <p className="text-sm text-gray-500 mt-1">
                Run a historical backfill to analyze how your code has evolved over time.
                This will process past commits and track symbol changes, complexity trends,
                and structural attribution.
              </p>
            </div>
            {selectedRepoId && (
              <BackfillPanel repoId={selectedRepoId} githubToken={githubToken} onComplete={handleBackfillComplete} />
            )}
          </div>
        ) : (
          /* Active tab content */
          <div className="max-w-4xl">
            {selectedRepoId && tab === "timeline" && (
              <SymbolTimeline repoId={selectedRepoId} />
            )}
            {selectedRepoId && tab === "complexity" && (
              <ComplexityTrendChart repoId={selectedRepoId} />
            )}
            {selectedRepoId && tab === "blame" && (
              <StructuralBlamePanel repoId={selectedRepoId} />
            )}
            {selectedRepoId && tab === "diff" && (
              <DiffExplorer repoId={selectedRepoId} commits={commits} />
            )}

            {/* Backfill panel below active content */}
            {selectedRepoId && (
              <div className="mt-8">
                <BackfillPanel repoId={selectedRepoId} githubToken={githubToken} onComplete={handleBackfillComplete} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
