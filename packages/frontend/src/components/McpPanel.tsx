import { useState } from "react";
import { Network, Copy, Check } from "lucide-react";

export function McpPanel() {
  const [copied, setCopied] = useState(false);

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        repograph: {
          command: "npx",
          args: ["-y", "@repograph/mcp-server"],
          env: {
            NEO4J_URI: "neo4j+s://3c68f875.databases.neo4j.io",
            NEO4J_USERNAME: "neo4j",
            NEO4J_PASSWORD: "<your-neo4j-password>",
            NEO4J_DATABASE: "neo4j",
            SUPABASE_URL: "https://rnjlipgcgrfacvsitwov.supabase.co",
            SUPABASE_SERVICE_KEY: "<your-supabase-key>",
          },
        },
      },
    },
    null,
    2
  );

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
      </p>
      <pre className="bg-gray-900/80 border border-white/5 rounded-lg p-3 text-[11px] font-mono text-gray-400 overflow-x-auto leading-relaxed max-h-48 overflow-y-auto">
        {mcpConfig}
      </pre>
    </div>
  );
}
