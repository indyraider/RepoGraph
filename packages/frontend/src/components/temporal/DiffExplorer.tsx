import { useState } from "react";
import { getDiffGraph, type DiffEntry, type CommitSummary } from "../../api";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  Inbox,
} from "lucide-react";

interface Props {
  repoId: string;
  commits: CommitSummary[];
}

function DiffSection({
  title,
  entries,
  icon: Icon,
  color,
  bg,
}: {
  title: string;
  entries: DiffEntry[];
  icon: typeof Plus;
  color: string;
  bg: string;
}) {
  const [open, setOpen] = useState(true);

  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm hover:bg-white/[0.02] transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
        <Icon className={`w-4 h-4 ${color}`} />
        <span className={color}>{title}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${bg} ${color}`}>
          {entries.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-white/[0.04]">
          {entries.map((entry, i) => (
            <div
              key={`${entry.name}-${entry.filePath}-${i}`}
              className="px-4 py-3 border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.01]"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200 font-mono">{entry.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 uppercase">
                  {entry.kind}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                <span>{entry.filePath}</span>
                <span className="font-mono">{entry.commitSha.slice(0, 8)}</span>
                <span>by {entry.author}</span>
              </div>
              {entry.message && (
                <p className="text-xs text-gray-600 mt-1 truncate">{entry.message}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffExplorer({ repoId, commits }: Props) {
  const [fromRef, setFromRef] = useState("");
  const [toRef, setToRef] = useState("");
  const [result, setResult] = useState<{ created: DiffEntry[]; modified: DiffEntry[]; deleted: DiffEntry[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCompare = async () => {
    if (!fromRef || !toRef) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getDiffGraph(repoId, fromRef, toRef);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diff");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const hasNoChanges = result && result.created.length === 0 && result.modified.length === 0 && result.deleted.length === 0;

  return (
    <div className="space-y-4">
      {/* Commit pickers */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-gray-500 mb-1 block">From</label>
          <select
            value={fromRef}
            onChange={(e) => setFromRef(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 focus:outline-none focus:border-violet-500/40"
          >
            <option value="">Select commit...</option>
            {commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.sha.slice(0, 8)} — {c.message?.slice(0, 50)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-gray-500 mb-1 block">To</label>
          <select
            value={toRef}
            onChange={(e) => setToRef(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 focus:outline-none focus:border-violet-500/40"
          >
            <option value="">Select commit...</option>
            {commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.sha.slice(0, 8)} — {c.message?.slice(0, 50)}
              </option>
            ))}
          </select>
        </div>

        <div className="pt-4">
          <button
            onClick={handleCompare}
            disabled={!fromRef || !toRef || loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 text-sm transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCompareArrows className="w-4 h-4" />}
            Compare
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Results */}
      {result && !hasNoChanges && (
        <div className="space-y-3">
          <DiffSection title="Created" entries={result.created} icon={Plus} color="text-emerald-400" bg="bg-emerald-500/10" />
          <DiffSection title="Modified" entries={result.modified} icon={Pencil} color="text-blue-400" bg="bg-blue-500/10" />
          <DiffSection title="Deleted" entries={result.deleted} icon={Trash2} color="text-red-400" bg="bg-red-500/10" />
        </div>
      )}

      {hasNoChanges && (
        <div className="text-center py-12 text-gray-500">
          <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No structural changes between these commits</p>
        </div>
      )}

      {!result && !loading && (
        <div className="text-center py-12 text-gray-500">
          <GitCompareArrows className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Select two commits to compare structural changes</p>
          <p className="text-xs mt-1">Shows symbols added, modified, and removed</p>
        </div>
      )}
    </div>
  );
}
