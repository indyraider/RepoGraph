import { useState, useEffect, useMemo, useRef } from "react";
import {
  Search,
  Lock,
  Globe,
  GitBranch,
  Database,
  Loader2,
  ChevronDown,
  X,
} from "lucide-react";
import { getGitHubRepos, type GitHubRepo } from "../api";
import { useAuth } from "../AuthProvider";

interface RepoImportProps {
  onImport: (url: string, branch: string) => void;
  digesting: boolean;
}

export function RepoImport({ onImport, digesting }: RepoImportProps) {
  const { githubToken } = useAuth();
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [branch, setBranch] = useState("");
  const [open, setOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!githubToken) {
      setError("No GitHub token — please re-login to list repos");
      setLoading(false);
      return;
    }
    getGitHubRepos(githubToken)
      .then((data) => {
        setRepos(data);
        setError(null);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [githubToken]);

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q) ||
        (r.language || "").toLowerCase().includes(q)
    );
  }, [repos, search]);

  const handleSelect = (repo: GitHubRepo) => {
    setSelected(repo);
    setBranch(repo.default_branch);
    setSearch("");
    setOpen(false);
  };

  const handleImport = () => {
    if (manualMode) {
      if (manualUrl.trim()) {
        onImport(manualUrl.trim(), branch || "main");
      }
    } else if (selected) {
      onImport(selected.url, branch || selected.default_branch);
    }
  };

  const handleClear = () => {
    setSelected(null);
    setBranch("");
    setSearch("");
  };

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setManualMode(false); setManualUrl(""); }}
          className={`text-xs px-3 py-1.5 rounded-md border transition-all ${
            !manualMode
              ? "bg-violet-500/10 text-violet-400 border-violet-500/30"
              : "text-gray-500 border-white/5 hover:text-gray-300"
          }`}
        >
          Import from GitHub
        </button>
        <button
          onClick={() => { setManualMode(true); setSelected(null); }}
          className={`text-xs px-3 py-1.5 rounded-md border transition-all ${
            manualMode
              ? "bg-violet-500/10 text-violet-400 border-violet-500/30"
              : "text-gray-500 border-white/5 hover:text-gray-300"
          }`}
        >
          Enter URL manually
        </button>
      </div>

      {manualMode ? (
        /* Manual URL input (original behavior) */
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <GitBranch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            <input
              type="text"
              placeholder="https://github.com/user/repo or git@github.com:user/repo.git"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              className="w-full bg-gray-800/60 border border-white/5 rounded-lg pl-10 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
              onKeyDown={(e) => e.key === "Enter" && handleImport()}
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
            onClick={handleImport}
            disabled={digesting || !manualUrl.trim()}
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
      ) : (
        /* GitHub repo picker */
        <div className="space-y-3">
          {/* Selected repo display or search dropdown */}
          {selected ? (
            <div className="flex gap-3">
              <div className="flex-1 flex items-center gap-3 bg-gray-800/60 border border-white/5 rounded-lg px-4 py-2.5">
                <img
                  src={selected.owner_avatar}
                  alt={selected.owner}
                  className="w-5 h-5 rounded-full"
                />
                <span className="text-sm text-white font-medium">{selected.full_name}</span>
                {selected.private ? (
                  <Lock className="w-3 h-3 text-amber-400" />
                ) : (
                  <Globe className="w-3 h-3 text-gray-500" />
                )}
                {selected.language && (
                  <span className="text-xs text-gray-500 ml-auto">{selected.language}</span>
                )}
                <button
                  onClick={handleClear}
                  className="text-gray-500 hover:text-gray-300 ml-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-28 bg-gray-800/60 border border-white/5 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 text-center input-focus-ring transition-shadow"
              />
              <button
                onClick={handleImport}
                disabled={digesting}
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
          ) : (
            <div className="relative" ref={dropdownRef}>
              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search your repositories..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOpen(true);
                  }}
                  onFocus={() => setOpen(true)}
                  className="w-full bg-gray-800/60 border border-white/5 rounded-lg pl-10 pr-10 py-2.5 text-sm text-gray-100 placeholder-gray-600 input-focus-ring transition-shadow"
                />
                <button
                  onClick={() => setOpen(!open)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
              </div>

              {/* Dropdown */}
              {open && (
                <div className="absolute z-50 mt-1 w-full bg-gray-900 border border-white/10 rounded-lg shadow-2xl shadow-black/50 max-h-80 overflow-y-auto">
                  {loading && (
                    <div className="flex items-center justify-center py-8 text-gray-500 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Loading repositories...
                    </div>
                  )}
                  {error && (
                    <div className="px-4 py-3 text-sm text-amber-400">
                      {error}. You can still enter a URL manually.
                    </div>
                  )}
                  {!loading && !error && filtered.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-gray-500">
                      No repositories found.
                    </div>
                  )}
                  {!loading &&
                    filtered.map((repo) => (
                      <button
                        key={repo.id}
                        onClick={() => handleSelect(repo)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left border-b border-white/[0.03] last:border-0"
                      >
                        <img
                          src={repo.owner_avatar}
                          alt={repo.owner}
                          className="w-6 h-6 rounded-full flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-white font-medium truncate">
                              {repo.full_name}
                            </span>
                            {repo.private ? (
                              <Lock className="w-3 h-3 text-amber-400 flex-shrink-0" />
                            ) : (
                              <Globe className="w-3 h-3 text-gray-600 flex-shrink-0" />
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-xs text-gray-500 truncate mt-0.5">
                              {repo.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {repo.language && (
                            <span className="text-xs text-gray-500">{repo.language}</span>
                          )}
                          <span className="text-xs text-gray-600 flex items-center gap-1">
                            <GitBranch className="w-3 h-3" />
                            {repo.default_branch}
                          </span>
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
