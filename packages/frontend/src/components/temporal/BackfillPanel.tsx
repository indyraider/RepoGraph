import { useState, useEffect, useRef } from "react";
import { triggerBackfill, getBackfillStatus, type BackfillJob } from "../../api";
import { Loader2, Play, CheckCircle2, AlertTriangle } from "lucide-react";

interface Props {
  repoId: string;
  githubToken?: string | null;
  onComplete?: () => void;
}

export function BackfillPanel({ repoId, githubToken, onComplete }: Props) {
  const [maxCommits, setMaxCommits] = useState(50);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check for existing job on mount
  useEffect(() => {
    getBackfillStatus(repoId).then(setJob).catch(() => {});
  }, [repoId]);

  // Poll while running
  useEffect(() => {
    if (job?.status === "running") {
      pollRef.current = setInterval(async () => {
        const updated = await getBackfillStatus(repoId);
        setJob(updated);
        if (updated && updated.status !== "running") {
          if (pollRef.current) clearInterval(pollRef.current);
          onComplete?.();
        }
      }, 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [job?.status, repoId, onComplete]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await triggerBackfill(repoId, maxCommits, githubToken ?? undefined);
      const status = await getBackfillStatus(repoId);
      setJob(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start backfill");
    } finally {
      setStarting(false);
    }
  };

  const isRunning = job?.status === "running";
  const isComplete = job?.status === "completed" || job?.status === "completed_with_errors";
  const progress = job && job.commits_total > 0
    ? Math.round((job.commits_processed / job.commits_total) * 100)
    : 0;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
      <h3 className="text-sm font-medium text-gray-200 mb-3">Historical Backfill</h3>

      {isRunning && job && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-violet-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Processing commits... {job.commits_processed}/{job.commits_total}</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="bg-violet-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {isComplete && job && (
        <div className="flex items-center gap-2 text-sm text-emerald-400 mb-3">
          <CheckCircle2 className="w-4 h-4" />
          <span>
            Backfill complete: {job.commits_processed}/{job.commits_total} commits processed
            {job.stats?.durationMs ? ` in ${(Number(job.stats.durationMs) / 1000).toFixed(1)}s` : ""}
          </span>
        </div>
      )}

      {job?.status === "failed" && (
        <div className="flex items-center gap-2 text-sm text-red-400 mb-3">
          <AlertTriangle className="w-4 h-4" />
          <span>Backfill failed: {job.error_log || "Unknown error"}</span>
        </div>
      )}

      {!isRunning && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500">Max commits:</label>
          <input
            type="number"
            min={5}
            max={500}
            value={maxCommits}
            onChange={(e) => setMaxCommits(parseInt(e.target.value) || 50)}
            className="w-20 px-2 py-1.5 rounded-lg bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 focus:outline-none focus:border-violet-500/40"
          />
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 text-sm transition-colors disabled:opacity-50"
          >
            {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {isComplete ? "Re-run Backfill" : "Run Backfill"}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
