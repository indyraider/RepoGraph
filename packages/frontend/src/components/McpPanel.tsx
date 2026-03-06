import { useState, useEffect } from "react";
import { Network, Copy, Check, Loader2 } from "lucide-react";
import { getMcpConfig } from "../api";

export function McpPanel() {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [neo4j, setNeo4j] = useState<Record<string, string> | null>(null);
  const [supabase, setSupabase] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    getMcpConfig()
      .then((cfg) => {
        setNeo4j(cfg.neo4j);
        setSupabase(cfg.supabase);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        repograph: {
          command: "npx",
          args: ["-y", "@repograph/mcp-server"],
          env: {
            NEO4J_URI: neo4j?.uri || "<your-neo4j-uri>",
            NEO4J_USERNAME: neo4j?.username || "<your-neo4j-username>",
            NEO4J_PASSWORD: neo4j?.password || "<your-neo4j-password>",
            NEO4J_DATABASE: neo4j?.database || "neo4j",
            SUPABASE_URL: supabase?.url || "<your-supabase-url>",
            SUPABASE_SERVICE_KEY: supabase?.service_key || "<your-supabase-key>",
          },
        },
      },
    },
    null,
    2
  );

  const hasCredentials = !!(neo4j || supabase);

  const handleCopy = () => {
    navigator.clipboard.writeText(mcpConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="border-t border-white/5 px-5 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 flex items-center gap-1.5">
          <Network className="w-3 h-3" />
          MCP Connection
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          {!loading && hasCredentials && (
            <span className="text-emerald-400 text-[10px] ml-1">● auto-filled</span>
          )}
        </span>
        <button
          onClick={handleCopy}
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all duration-200 ${
            copied
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : "bg-violet-500/10 text-violet-400 border-violet-500/30 hover:bg-violet-500/20"
          }`}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy .mcp.json
            </>
          )}
        </button>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">
        Paste into <code className="bg-gray-800/80 px-1.5 py-0.5 rounded font-mono text-[11px] text-gray-400">.mcp.json</code> in
        any project root to connect Claude Code to this graph.
        {!loading && !hasCredentials && (
          <span className="block mt-1 text-amber-400/70">
            Add your credentials in Settings to auto-fill this config.
          </span>
        )}
      </p>
      <pre className="bg-gray-900/80 border border-white/5 rounded-lg p-3 text-[11px] font-mono text-gray-400 overflow-x-auto leading-relaxed max-h-48 overflow-y-auto">
        {mcpConfig}
      </pre>
    </div>
  );
}
