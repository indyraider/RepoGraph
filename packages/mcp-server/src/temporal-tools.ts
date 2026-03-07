/**
 * Temporal MCP Tools — 6 new tools for querying the temporal code graph.
 * Registered alongside existing tools in index.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "neo4j-driver";
import { SupabaseClient } from "@supabase/supabase-js";

type GetSessionFn = () => Session;
type GetSupabaseFn = () => SupabaseClient;

/**
 * Register all 6 temporal tools on the MCP server.
 */
export function registerTemporalTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void {
  // Tool: get_symbol_history
  server.tool(
    "get_symbol_history",
    "Get the full version history of a symbol (function, class, type, constant) across commits. Shows how it changed over time: signature evolution, who changed it, and when.",
    {
      name: z.string().describe("Symbol name to look up"),
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      kind: z.enum(["function", "class", "type", "constant"]).optional().describe("Filter by symbol kind"),
      max_results: z.number().optional().default(20).describe("Max versions to return"),
    },
    async ({ name, repo: repoParam, kind, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const session = getSession();
      try {
        const labelFilter = kind
          ? `:${kind === "function" ? "Function" : kind === "class" ? "Class" : kind === "type" ? "TypeDef" : "Constant"}`
          : "";

        const result = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           OPTIONAL MATCH (sym)-[:INTRODUCED_IN]->(c:Commit)
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  f.path AS file_path,
                  sym.signature AS signature,
                  sym.resolved_signature AS resolved_signature,
                  sym.start_line AS start_line, sym.end_line AS end_line,
                  sym.valid_from AS valid_from, sym.valid_from_ts AS valid_from_ts,
                  sym.valid_to AS valid_to, sym.valid_to_ts AS valid_to_ts,
                  sym.change_type AS change_type, sym.changed_by AS changed_by,
                  sym.commit_message AS commit_message,
                  c.sha AS commit_sha, c.message AS full_commit_message
           ORDER BY sym.valid_from_ts DESC
           LIMIT $limit`,
          { name, repo, limit: max_results || 20 }
        );

        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: `No history found for symbol: ${name}` }] };
        }

        let output = `## History of "${name}" (${result.records.length} version(s))\n\n`;
        result.records.forEach((r, i) => {
          const validTo = r.get("valid_to");
          const status = validTo ? `superseded at ${r.get("valid_to")?.toString().slice(0, 8)}` : "current";
          output += `### Version ${i + 1} [${status}]\n`;
          output += `Kind: ${r.get("kind")} | File: ${r.get("file_path")}:${toNum(r.get("start_line"))}\n`;
          output += `Change: ${r.get("change_type") || "unknown"} by ${r.get("changed_by") || "unknown"}\n`;
          output += `Commit: ${r.get("valid_from")?.toString().slice(0, 8) || "n/a"} — ${r.get("commit_message") || r.get("full_commit_message") || ""}\n`;
          output += `Signature: ${r.get("signature") || "n/a"}\n`;
          if (r.get("resolved_signature")) output += `Resolved type: ${r.get("resolved_signature")}\n`;
          output += "\n";
        });

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );

  // Tool: diff_graph
  server.tool(
    "diff_graph",
    "Compare the code graph between two commits. Shows what symbols and edges were added, modified, or removed between two points in time.",
    {
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      from_ref: z.string().describe("Starting commit SHA (or prefix)"),
      to_ref: z.string().describe("Ending commit SHA (or prefix)"),
      scope: z.string().optional().describe("Filter to a specific file path or directory prefix"),
    },
    async ({ repo: repoParam, from_ref, to_ref, scope }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const session = getSession();
      try {
        // Find commits in the range by resolving SHAs
        const result = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (fromCommit:Commit {repo_url: repoUrl}) WHERE fromCommit.sha STARTS WITH $fromRef
           MATCH (toCommit:Commit {repo_url: repoUrl}) WHERE toCommit.sha STARTS WITH $toRef
           WITH repoUrl, fromCommit.timestamp AS fromTs, toCommit.timestamp AS toTs
           MATCH (sym)-[intro:INTRODUCED_IN]->(c:Commit {repo_url: repoUrl})
           WHERE c.timestamp >= fromTs AND c.timestamp <= toTs
           MATCH (f:File)-[:CONTAINS]->(sym)
           ${scope ? "WHERE f.path STARTS WITH $scope" : ""}
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  f.path AS file_path,
                  intro.change_type AS change_type,
                  sym.changed_by AS author,
                  c.sha AS commit_sha, c.message AS commit_message,
                  sym.signature AS signature
           ORDER BY c.timestamp ASC`,
          { repo, fromRef: from_ref, toRef: to_ref, scope: scope || null }
        );

        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: `No changes found between ${from_ref} and ${to_ref}` }] };
        }

        const created: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];

        result.records.forEach((r) => {
          const line = `${r.get("kind")}: ${r.get("name")} in ${r.get("file_path")} (${r.get("commit_sha")?.toString().slice(0, 8)} by ${r.get("author") || "unknown"})`;
          switch (r.get("change_type")) {
            case "created": created.push(line); break;
            case "modified": modified.push(line); break;
            case "deleted": deleted.push(line); break;
          }
        });

        let output = `## Graph diff: ${from_ref.slice(0, 8)}..${to_ref.slice(0, 8)}\n\n`;
        if (created.length > 0) output += `### Added (${created.length})\n${created.map((l) => `+ ${l}`).join("\n")}\n\n`;
        if (modified.length > 0) output += `### Modified (${modified.length})\n${modified.map((l) => `~ ${l}`).join("\n")}\n\n`;
        if (deleted.length > 0) output += `### Deleted (${deleted.length})\n${deleted.map((l) => `- ${l}`).join("\n")}\n\n`;

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );

  // Tool: get_structural_blame
  server.tool(
    "get_structural_blame",
    "Find who originally introduced a symbol (function, class, type) and when. Like git blame but for structural elements rather than lines.",
    {
      name: z.string().describe("Symbol name to look up"),
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      kind: z.enum(["function", "class", "type", "constant"]).optional().describe("Filter by symbol kind"),
    },
    async ({ name, repo: repoParam, kind }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const session = getSession();
      try {
        const labelFilter = kind
          ? `:${kind === "function" ? "Function" : kind === "class" ? "Class" : kind === "type" ? "TypeDef" : "Constant"}`
          : "";

        const result = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           WHERE sym.change_type = 'created'
           OPTIONAL MATCH (sym)-[:INTRODUCED_IN]->(c:Commit)
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  f.path AS file_path, sym.signature AS signature,
                  sym.changed_by AS author,
                  sym.valid_from AS commit_sha,
                  sym.valid_from_ts AS introduced_at,
                  c.message AS commit_message
           ORDER BY sym.valid_from_ts ASC
           LIMIT 1`,
          { name, repo }
        );

        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: `No creation record found for: ${name}` }] };
        }

        const r = result.records[0];
        let output = `## Structural blame: ${r.get("name")}\n`;
        output += `Kind: ${r.get("kind")}\n`;
        output += `File: ${r.get("file_path")}\n`;
        output += `Introduced by: ${r.get("author") || "unknown"}\n`;
        output += `Commit: ${r.get("commit_sha")?.toString().slice(0, 8) || "n/a"}\n`;
        output += `Date: ${r.get("introduced_at") || "unknown"}\n`;
        output += `Message: ${r.get("commit_message") || "n/a"}\n`;
        output += `Signature: ${r.get("signature") || "n/a"}\n`;

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );

  // Tool: get_complexity_trend
  server.tool(
    "get_complexity_trend",
    "Get complexity metric trends over time for a file. Shows how import count, coupling score, symbol count, etc. changed across commits.",
    {
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      path: z.string().describe("File path to analyze"),
      metric: z.enum(["import_count", "reverse_import_count", "symbol_count", "coupling_score"])
        .optional().describe("Specific metric to query (default: all)"),
      max_results: z.number().optional().default(20).describe("Max data points to return"),
    },
    async ({ repo: repoParam, path: filePath, metric, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const sb = getSupabase();

      // Look up repo_id from repo name/url
      const { data: repoData } = await sb
        .from("repositories")
        .select("id")
        .or(`name.eq.${repo},url.eq.${repo}`)
        .limit(1)
        .single();

      if (!repoData) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      let query = sb
        .from("complexity_metrics")
        .select("commit_sha, file_path, metric_name, metric_value, timestamp")
        .eq("repo_id", repoData.id)
        .eq("file_path", filePath)
        .order("timestamp", { ascending: false })
        .limit(max_results || 20);

      if (metric) {
        query = query.eq("metric_name", metric);
      }

      const { data, error } = await query;

      if (error) {
        return { content: [{ type: "text" as const, text: `Query error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No complexity metrics found for: ${filePath}` }] };
      }

      let output = `## Complexity trend: ${filePath}\n\n`;
      output += `| Commit | Metric | Value | Date |\n|--------|--------|-------|------|\n`;
      data.forEach((row: any) => {
        output += `| ${row.commit_sha?.slice(0, 8)} | ${row.metric_name} | ${row.metric_value} | ${row.timestamp?.slice(0, 10)} |\n`;
      });

      return { content: [{ type: "text" as const, text: output }] };
    }
  );

  // Tool: find_when_introduced
  server.tool(
    "find_when_introduced",
    "Find when a symbol or dependency was first introduced to the codebase. Returns the commit, author, and date.",
    {
      name: z.string().describe("Symbol or import target name"),
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      kind: z.enum(["function", "class", "type", "constant"]).optional().describe("Symbol kind filter"),
    },
    async ({ name, repo: repoParam, kind }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const session = getSession();
      try {
        const labelFilter = kind
          ? `:${kind === "function" ? "Function" : kind === "class" ? "Class" : kind === "type" ? "TypeDef" : "Constant"}`
          : "";

        const result = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           WHERE sym.change_type = 'created'
           OPTIONAL MATCH (sym)-[:INTRODUCED_IN]->(c:Commit)
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  f.path AS file_path, sym.signature AS signature,
                  sym.changed_by AS author, sym.valid_from AS commit_sha,
                  sym.valid_from_ts AS date, c.message AS commit_message
           ORDER BY sym.valid_from_ts ASC
           LIMIT 1`,
          { name, repo }
        );

        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: `No introduction record found for: ${name}` }] };
        }

        const r = result.records[0];
        const output = `${r.get("kind")}: ${r.get("name")} in ${r.get("file_path")}\n` +
          `Introduced: ${r.get("commit_sha")?.toString().slice(0, 8)} by ${r.get("author") || "unknown"}\n` +
          `Date: ${r.get("date") || "unknown"}\n` +
          `Message: ${r.get("commit_message") || "n/a"}\n` +
          `Signature: ${r.get("signature") || "n/a"}`;

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );

  // Tool: find_when_removed
  server.tool(
    "find_when_removed",
    "Find when a symbol was removed from the codebase. Returns the commit, author, and date of removal.",
    {
      name: z.string().describe("Symbol name to look up"),
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      kind: z.enum(["function", "class", "type", "constant"]).optional().describe("Symbol kind filter"),
    },
    async ({ name, repo: repoParam, kind }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified." }] };
      }
      const session = getSession();
      try {
        const labelFilter = kind
          ? `:${kind === "function" ? "Function" : kind === "class" ? "Class" : kind === "type" ? "TypeDef" : "Constant"}`
          : "";

        const result = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           WHERE sym.change_type = 'deleted'
           OPTIONAL MATCH (sym)-[:INTRODUCED_IN {change_type: 'deleted'}]->(c:Commit)
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  f.path AS file_path, sym.signature AS signature,
                  sym.valid_to AS removed_at_sha,
                  sym.valid_to_ts AS removed_at_date,
                  c.message AS commit_message
           ORDER BY sym.valid_to_ts DESC
           LIMIT 5`,
          { name, repo }
        );

        if (result.records.length === 0) {
          return { content: [{ type: "text" as const, text: `No removal record found for: ${name} (it may still exist or was never tracked)` }] };
        }

        let output = `## Removal history: ${name}\n\n`;
        result.records.forEach((r) => {
          output += `${r.get("kind")}: ${r.get("name")} in ${r.get("file_path")}\n`;
          output += `Removed at: ${r.get("removed_at_sha")?.toString().slice(0, 8) || "unknown"}\n`;
          output += `Date: ${r.get("removed_at_date") || "unknown"}\n`;
          output += `Commit: ${r.get("commit_message") || "n/a"}\n`;
          output += `Last signature: ${r.get("signature") || "n/a"}\n\n`;
        });

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );
}

// Helper to safely convert Neo4j integer to number
function toNum(val: any): number {
  if (val && typeof val === "object" && "toNumber" in val) return val.toNumber();
  return val ?? 0;
}
