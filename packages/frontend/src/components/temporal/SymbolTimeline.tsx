import { useState, useCallback, useRef } from "react";
import { getSymbolHistory, type SymbolVersion } from "../../api";
import { Search, Loader2, GitCommitHorizontal, Plus, Pencil, Trash2, Inbox } from "lucide-react";

interface Props {
  repoId: string;
}

const CHANGE_STYLES: Record<string, { icon: typeof Plus; color: string; bg: string }> = {
  created: { icon: Plus, color: "text-emerald-400", bg: "bg-emerald-500/10" },
  modified: { icon: Pencil, color: "text-blue-400", bg: "bg-blue-500/10" },
  deleted: { icon: Trash2, color: "text-red-400", bg: "bg-red-500/10" },
};

export function SymbolTimeline({ repoId }: Props) {
  const [query, setQuery] = useState("");
  const [versions, setVersions] = useState<SymbolVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    (name: string) => {
      if (!name.trim()) {
        setVersions([]);
        setSearched(false);
        return;
      }
      setLoading(true);
      getSymbolHistory(repoId, name.trim())
        .then((v) => {
          setVersions(v);
          setSearched(true);
        })
        .catch(() => setVersions([]))
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
          placeholder="Search symbol name (e.g. processPayment, UserService)..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search(query)}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-800/60 border border-white/[0.06] text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500/40"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-violet-400" />}
      </div>

      {/* Timeline */}
      {versions.length > 0 && (
        <div className="relative pl-6">
          {/* Vertical line */}
          <div className="absolute left-[11px] top-2 bottom-2 w-px bg-white/[0.06]" />

          <div className="space-y-4">
            {versions.map((v, i) => {
              const style = CHANGE_STYLES[v.changeType || "created"] || CHANGE_STYLES.created;
              const Icon = style.icon;
              return (
                <div key={i} className="relative flex gap-4">
                  {/* Dot */}
                  <div className={`absolute -left-6 top-1 w-[22px] h-[22px] rounded-full ${style.bg} flex items-center justify-center border border-white/[0.06] z-10`}>
                    <Icon className={`w-3 h-3 ${style.color}`} />
                  </div>

                  {/* Card */}
                  <div className="flex-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.color}`}>
                            {v.changeType || "unknown"}
                          </span>
                          <span className="text-xs text-gray-500">{v.filePath}</span>
                        </div>
                        {v.signature && (
                          <code className="text-sm text-gray-300 block truncate">{v.signature}</code>
                        )}
                      </div>
                    </div>

                    {(v.commitSha || v.commitAuthor) && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                        <GitCommitHorizontal className="w-3 h-3" />
                        {v.commitSha && <span className="font-mono">{v.commitSha.slice(0, 8)}</span>}
                        {v.commitAuthor && <span>by {v.commitAuthor}</span>}
                        {v.validFromTs && (
                          <span>{new Date(v.validFromTs).toLocaleDateString()}</span>
                        )}
                      </div>
                    )}
                    {v.commitMessage && (
                      <p className="mt-1 text-xs text-gray-500 truncate">{v.commitMessage}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty states */}
      {searched && versions.length === 0 && !loading && (
        <div className="text-center py-12 text-gray-500">
          <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No history found for "{query}"</p>
          <p className="text-xs mt-1">This symbol may not have temporal data yet</p>
        </div>
      )}

      {!searched && !loading && (
        <div className="text-center py-12 text-gray-500">
          <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Search for a symbol to see its history</p>
          <p className="text-xs mt-1">Functions, classes, types, and constants</p>
        </div>
      )}
    </div>
  );
}
