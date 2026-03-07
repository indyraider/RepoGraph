import { useState, useCallback, useRef } from "react";
import { getStructuralBlame, type BlameResult } from "../../api";
import { Search, Loader2, User, GitCommitHorizontal, Inbox } from "lucide-react";

interface Props {
  repoId: string;
}

export function StructuralBlamePanel({ repoId }: Props) {
  const [query, setQuery] = useState("");
  const [blame, setBlame] = useState<BlameResult | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    (name: string) => {
      if (!name.trim()) {
        setBlame(undefined);
        setSearched(false);
        return;
      }
      setLoading(true);
      getStructuralBlame(repoId, name.trim())
        .then((b) => {
          setBlame(b);
          setSearched(true);
        })
        .catch(() => {
          setBlame(null);
          setSearched(true);
        })
        .finally(() => setLoading(false));
    },
    [repoId]
  );

  const handleChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 400);
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder="Search symbol name to find who introduced it..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search(query)}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500/40"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-violet-400" />}
      </div>

      {/* Blame card */}
      {blame && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-violet-500/10 flex items-center justify-center flex-shrink-0 border border-violet-500/20">
              <User className="w-5 h-5 text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-gray-200">
                Introduced by <span className="text-violet-400">{blame.author}</span>
              </h4>
              {blame.signature && (
                <code className="text-xs text-gray-400 block mt-1 truncate">{blame.signature}</code>
              )}
              <p className="text-xs text-gray-500 mt-1">{blame.filePath}</p>

              <div className="mt-3 flex items-center gap-3 text-xs text-gray-500">
                <div className="flex items-center gap-1.5">
                  <GitCommitHorizontal className="w-3 h-3" />
                  <span className="font-mono">{blame.commitSha.slice(0, 8)}</span>
                </div>
                <span>{new Date(blame.timestamp).toLocaleDateString()}</span>
              </div>
              {blame.message && (
                <p className="mt-2 text-xs text-gray-400 italic">"{blame.message}"</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Empty states */}
      {searched && blame === null && !loading && (
        <div className="text-center py-12 text-gray-500">
          <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No blame data found for "{query}"</p>
          <p className="text-xs mt-1">This symbol may not have temporal data yet</p>
        </div>
      )}

      {!searched && !loading && (
        <div className="text-center py-12 text-gray-500">
          <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Search for a symbol to see who introduced it</p>
          <p className="text-xs mt-1">Shows the commit, author, and date of first introduction</p>
        </div>
      )}
    </div>
  );
}
