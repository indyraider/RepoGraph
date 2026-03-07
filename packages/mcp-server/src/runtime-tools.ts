/**
 * Runtime MCP Tools — 5 new tools for querying production logs and bridging
 * errors to the code graph. Registered alongside existing tools in index.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "neo4j-driver";
import { SupabaseClient } from "@supabase/supabase-js";
import { resolveRepoId } from "./repo-resolver.js";

// Lightweight stack trace parser (same logic as backend stack-parser.ts)
interface ParsedFrame {
  filePath: string;
  lineNumber: number;
  functionName?: string;
}

const PATH_PREFIXES = [/^\/var\/task\//, /^\/app\//, /^\/home\/\w+\//, /^\/opt\/\w+\//, /^\/workspace\//];
const NODE_FRAME = /at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?/;
const PY_FRAME = /File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;

function parseStackTrace(stack: string): ParsedFrame[] {
  if (!stack) return [];
  const frames: ParsedFrame[] = [];
  for (const line of stack.split("\n")) {
    const t = line.trim();
    const nm = t.match(NODE_FRAME);
    if (nm) {
      let fp = nm[2];
      for (const p of PATH_PREFIXES) fp = fp.replace(p, "");
      if (!fp.includes("node_modules/") && !fp.startsWith("node:")) {
        frames.push({ functionName: nm[1] || undefined, filePath: fp, lineNumber: parseInt(nm[3], 10) });
      }
      continue;
    }
    const pm = t.match(PY_FRAME);
    if (pm) {
      let fp = pm[1];
      for (const p of PATH_PREFIXES) fp = fp.replace(p, "");
      if (!fp.includes("site-packages/") && !fp.startsWith("<")) {
        frames.push({ filePath: fp, lineNumber: parseInt(pm[2], 10), functionName: pm[3] || undefined });
      }
    }
  }
  return frames;
}

type GetSessionFn = () => Session;
type GetSupabaseFn = () => SupabaseClient;

/**
 * Register all 5 runtime tools on the MCP server.
 */
export function registerRuntimeTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void {
  // ─── get_recent_logs ────────────────────────────────────────────
  server.tool(
    "get_recent_logs",
    "Fetch the most recent log entries from connected deployment platforms. Use for a quick 'what's happening right now' check.",
    {
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      source: z.string().optional().describe("Platform filter: 'vercel', 'railway', or 'all' (default: all)"),
      minutes: z.number().optional().default(30).describe("Look-back window in minutes (default: 30)"),
      level: z.string().optional().describe("Filter to 'info', 'warn', or 'error'"),
      max_results: z.number().optional().default(50).describe("Max entries to return (default: 50)"),
    },
    async ({ repo: repoParam, source, minutes, level, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
      }
      const sb = getSupabase();
      const repoId = await resolveRepoId(sb, repo);
      if (!repoId) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      const since = new Date(Date.now() - (minutes || 30) * 60 * 1000).toISOString();

      let query = sb
        .from("runtime_logs")
        .select("id, timestamp, source, level, message, function_name, file_path, line_number")
        .eq("repo_id", repoId)
        .gte("timestamp", since)
        .order("timestamp", { ascending: false })
        .limit(max_results || 50);

      if (source && source !== "all") query = query.eq("source", source);
      if (level) query = query.eq("level", level);

      const { data, error } = await query;

      if (error) {
        return { content: [{ type: "text" as const, text: `Query error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No logs found in the last ${minutes} minutes.` }] };
      }

      const output = data
        .map((e) => {
          let line = `[${e.timestamp}] ${e.source} ${e.level.toUpperCase()}: ${e.message}`;
          if (e.file_path) line += `\n  → ${e.file_path}:${e.line_number}`;
          if (e.function_name) line += ` (${e.function_name})`;
          return line;
        })
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `## Recent logs (${data.length} entries)\n\n${output}` }],
      };
    }
  );

  // ─── search_logs ────────────────────────────────────────────────
  server.tool(
    "search_logs",
    "Full-text search across stored runtime log messages. Find specific error patterns, endpoint issues, or strings across any time range.",
    {
      query: z.string().describe("Search string to match against log messages"),
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      source: z.string().optional().describe("Platform filter or 'all' (default: all)"),
      since: z.string().optional().describe("ISO 8601 timestamp lower bound"),
      level: z.string().optional().describe("Filter to 'error', 'warn', or 'info'"),
    },
    async ({ query: searchQuery, repo: repoParam, source, since, level }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
      }
      const sb = getSupabase();
      const repoId = await resolveRepoId(sb, repo);
      if (!repoId) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      let query = sb
        .from("runtime_logs")
        .select("id, timestamp, source, level, message, file_path, line_number, stack_trace")
        .eq("repo_id", repoId)
        .textSearch("message", searchQuery, { type: "websearch" })
        .order("timestamp", { ascending: false })
        .limit(30);

      if (source && source !== "all") query = query.eq("source", source);
      if (since) query = query.gte("timestamp", since);
      if (level) query = query.eq("level", level);

      const { data, error } = await query;

      if (error) {
        // Fallback to ilike if full-text search isn't available
        let fallback = sb
          .from("runtime_logs")
          .select("id, timestamp, source, level, message, file_path, line_number, stack_trace")
          .eq("repo_id", repoId)
          .ilike("message", `%${searchQuery}%`)
          .order("timestamp", { ascending: false })
          .limit(30);

        if (source && source !== "all") fallback = fallback.eq("source", source);
        if (since) fallback = fallback.gte("timestamp", since);
        if (level) fallback = fallback.eq("level", level);

        const { data: fbData, error: fbError } = await fallback;
        if (fbError) {
          return { content: [{ type: "text" as const, text: `Search error: ${fbError.message}` }] };
        }
        if (!fbData || fbData.length === 0) {
          return { content: [{ type: "text" as const, text: `No logs matching "${searchQuery}".` }] };
        }
        return { content: [{ type: "text" as const, text: formatLogEntries(fbData) }] };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No logs matching "${searchQuery}".` }] };
      }

      return { content: [{ type: "text" as const, text: formatLogEntries(data) }] };
    }
  );

  // ─── get_deploy_errors ──────────────────────────────────────────
  server.tool(
    "get_deploy_errors",
    "Fetch error-level logs from recent deployments. The primary entry point for 'what broke in the last deploy'.",
    {
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      source: z.string().optional().describe("Platform filter or 'all' (default: all)"),
      deployment_id: z.string().optional().describe("Specific deployment ID to scope the query"),
      last_n_deploys: z.number().optional().default(1).describe("Scope to N most recent deployments (default: 1)"),
    },
    async ({ repo: repoParam, source, deployment_id, last_n_deploys }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
      }
      const sb = getSupabase();
      const repoId = await resolveRepoId(sb, repo);
      if (!repoId) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      let deploymentIds: string[] = [];

      if (deployment_id) {
        deploymentIds = [deployment_id];
      } else {
        // Get the N most recent deployments
        let dQuery = sb
          .from("deployments")
          .select("deployment_id")
          .eq("repo_id", repoId)
          .order("started_at", { ascending: false })
          .limit(last_n_deploys || 1);

        if (source && source !== "all") dQuery = dQuery.eq("source", source);

        const { data: deploys } = await dQuery;
        deploymentIds = (deploys || []).map((d) => d.deployment_id);
      }

      if (deploymentIds.length === 0) {
        return { content: [{ type: "text" as const, text: "No deployments found." }] };
      }

      let query = sb
        .from("runtime_logs")
        .select("id, timestamp, source, level, message, function_name, file_path, line_number, stack_trace, deployment_id")
        .eq("repo_id", repoId)
        .eq("level", "error")
        .in("deployment_id", deploymentIds)
        .order("timestamp", { ascending: false })
        .limit(50);

      if (source && source !== "all") query = query.eq("source", source);

      const { data, error } = await query;

      if (error) {
        return { content: [{ type: "text" as const, text: `Query error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: "No errors in the most recent deployment(s)." }] };
      }

      // Include deployment context
      const { data: deployInfo } = await sb
        .from("deployments")
        .select("deployment_id, source, status, branch, commit_sha, started_at")
        .eq("repo_id", repoId)
        .in("deployment_id", deploymentIds);

      let output = "## Deploy Errors\n\n";
      if (deployInfo && deployInfo.length > 0) {
        output += "### Deployments\n";
        for (const d of deployInfo) {
          output += `- ${d.source} ${d.deployment_id}: ${d.status} (branch: ${d.branch || "n/a"}, sha: ${d.commit_sha?.slice(0, 7) || "n/a"})\n`;
        }
        output += "\n";
      }

      output += `### Errors (${data.length})\n\n`;
      output += data
        .map((e) => {
          let line = `[${e.timestamp}] ${e.source}: ${e.message}`;
          if (e.file_path) line += `\n  → ${e.file_path}:${e.line_number}`;
          if (e.function_name) line += ` (${e.function_name})`;
          if (e.stack_trace) line += `\n  Stack: ${e.stack_trace.split("\n").slice(0, 3).join("\n  ")}`;
          return line;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text: output }] };
    }
  );

  // ─── get_deployment_history ─────────────────────────────────────
  server.tool(
    "get_deployment_history",
    "List recent deployments with status, branch, commit, and error/warning counts. Understand the deployment timeline.",
    {
      repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
      source: z.string().optional().describe("Platform filter or 'all' (default: all)"),
      max_results: z.number().optional().default(10).describe("Number of deployments to return (default: 10)"),
    },
    async ({ repo: repoParam, source, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
      }
      const sb = getSupabase();
      const repoId = await resolveRepoId(sb, repo);
      if (!repoId) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      let query = sb
        .from("deployments")
        .select("*")
        .eq("repo_id", repoId)
        .order("started_at", { ascending: false })
        .limit(max_results || 10);

      if (source && source !== "all") query = query.eq("source", source);

      const { data: deploys, error } = await query;

      if (error) {
        return { content: [{ type: "text" as const, text: `Query error: ${error.message}` }] };
      }

      if (!deploys || deploys.length === 0) {
        return { content: [{ type: "text" as const, text: "No deployments found." }] };
      }

      // Get error/warn counts per deployment
      const deployIds = deploys.map((d) => d.deployment_id);
      const { data: logCounts } = await sb
        .from("runtime_logs")
        .select("deployment_id, level")
        .eq("repo_id", repoId)
        .in("deployment_id", deployIds)
        .in("level", ["error", "warn"]);

      const counts: Record<string, { errors: number; warns: number }> = {};
      for (const lc of logCounts || []) {
        if (!counts[lc.deployment_id]) counts[lc.deployment_id] = { errors: 0, warns: 0 };
        if (lc.level === "error") counts[lc.deployment_id].errors++;
        else counts[lc.deployment_id].warns++;
      }

      let output = `## Deployment History (${deploys.length})\n\n`;
      output += "| Time | Platform | Status | Branch | Commit | Errors | Warns |\n";
      output += "|------|----------|--------|--------|--------|--------|-------|\n";

      for (const d of deploys) {
        const c = counts[d.deployment_id] || { errors: 0, warns: 0 };
        output += `| ${d.started_at} | ${d.source} | ${d.status} | ${d.branch || "-"} | ${d.commit_sha?.slice(0, 7) || "-"} | ${c.errors} | ${c.warns} |\n`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    }
  );

  // ─── trace_error ────────────────────────────────────────────────
  server.tool(
    "trace_error",
    "The flagship debugging tool. Given an error log ID or raw stack trace, parse the error location, look up the containing function in the code graph, find all callers and imports, and return the full debugging context in one response.",
    {
      repo: z.string().optional().describe("Repository name to scope the Neo4j lookup (defaults to scoped repo)"),
      log_id: z.string().optional().describe("ID of a runtime_logs entry"),
      stack_trace: z.string().optional().describe("Raw stack trace string (use when log is not stored)"),
    },
    async ({ repo: repoParam, log_id, stack_trace }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
      }
      if (!log_id && !stack_trace) {
        return { content: [{ type: "text" as const, text: "Provide either log_id or stack_trace." }] };
      }

      const sb = getSupabase();
      const repoId = await resolveRepoId(sb, repo);
      if (!repoId) {
        return { content: [{ type: "text" as const, text: `Repository not found: ${repo}` }] };
      }

      // Step 1: Get the stack trace
      let rawStack = stack_trace || "";
      let logContext: Record<string, unknown> | null = null;

      if (log_id) {
        const { data: logEntry } = await sb
          .from("runtime_logs")
          .select("*")
          .eq("id", log_id)
          .single();

        if (logEntry) {
          logContext = logEntry;
          rawStack = logEntry.stack_trace || logEntry.message || rawStack;
        }
      }

      // Step 2: Parse stack trace
      const frames = parseStackTrace(rawStack);
      if (frames.length === 0) {
        let output = "## Error Trace\n\nCould not parse any source frames from the stack trace.\n";
        if (logContext) {
          output += `\n### Log Context\n- **Time:** ${(logContext as any).timestamp}\n- **Source:** ${(logContext as any).source}\n- **Level:** ${(logContext as any).level}\n- **Message:** ${(logContext as any).message}\n`;
        }
        output += `\n### Raw Stack\n\`\`\`\n${rawStack}\n\`\`\``;
        return { content: [{ type: "text" as const, text: output }] };
      }

      const topFrame = frames[0];
      let output = `## Error Trace: ${topFrame.filePath}:${topFrame.lineNumber}\n\n`;

      // Add log context if available
      if (logContext) {
        const lc = logContext as any;
        output += `### Log Context\n`;
        output += `- **Time:** ${lc.timestamp}\n`;
        output += `- **Source:** ${lc.source}\n`;
        output += `- **Message:** ${lc.message}\n`;
        if (lc.deployment_id) output += `- **Deployment:** ${lc.deployment_id}\n`;
        output += "\n";
      }

      // Step 3: Neo4j — find containing function
      const session = getSession();
      try {
        const fnResult = await session.run(
          `MATCH (f:File {path: $filePath})-[:CONTAINS]->(fn:Function)
           WHERE fn.start_line <= $line AND fn.end_line >= $line
           RETURN fn.name AS name, fn.signature AS signature, fn.docstring AS docstring,
                  fn.start_line AS start_line, fn.end_line AS end_line,
                  fn.resolved_signature AS resolved_signature,
                  fn.param_types AS param_types, fn.return_type AS return_type`,
          { filePath: topFrame.filePath, line: topFrame.lineNumber }
        );

        if (fnResult.records.length > 0) {
          const fn = fnResult.records[0];
          const fnName = fn.get("name");
          output += `### Containing Function\n`;
          output += `- **Name:** ${fnName}\n`;
          output += `- **Signature:** ${fn.get("signature") || "n/a"}\n`;
          if (fn.get("resolved_signature")) output += `- **Resolved type:** ${fn.get("resolved_signature")}\n`;
          if (fn.get("param_types")) output += `- **Param types:** ${(fn.get("param_types") as string[]).join(", ")}\n`;
          if (fn.get("return_type")) output += `- **Return type:** ${fn.get("return_type")}\n`;
          output += `- **Lines:** ${fn.get("start_line")}-${fn.get("end_line")}\n`;
          if (fn.get("docstring")) output += `- **Docstring:** ${fn.get("docstring")}\n`;
          output += "\n";

          // Step 4: Get callers with type info
          const callerResult = await session.run(
            `MATCH (fn:Function {name: $fnName})<-[r:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
             RETURN caller.name AS caller_name, f.path AS caller_file,
                    caller.start_line AS caller_line,
                    r.call_site_line AS call_site_line,
                    r.has_type_mismatch AS has_type_mismatch,
                    r.type_mismatch_detail AS type_mismatch_detail`,
            { fnName }
          );

          if (callerResult.records.length > 0) {
            output += `### Callers (${callerResult.records.length})\n`;
            for (const r of callerResult.records) {
              const callSiteLine = (r.get("call_site_line") as any)?.toNumber?.() ?? r.get("call_site_line");
              const callerStartLine = (r.get("caller_line") as any)?.toNumber?.() ?? r.get("caller_line");
              let callerLine = `- ${r.get("caller_name")} in ${r.get("caller_file")}:${callSiteLine || callerStartLine}`;
              if (r.get("has_type_mismatch")) callerLine += ` ⚠ TYPE MISMATCH: ${r.get("type_mismatch_detail")}`;
              output += callerLine + "\n";
            }
            output += "\n";
          }
        } else {
          output += `### Containing Function\nNo function found at ${topFrame.filePath}:${topFrame.lineNumber} in the code graph.\n\n`;
        }

        // Step 5: Get imports of the error file
        const importResult = await session.run(
          `MATCH (f:File {path: $filePath})-[r:IMPORTS]->(target)
           RETURN target.path AS target_path, target.name AS target_name,
                  labels(target)[0] AS target_type, r.symbols AS symbols`,
          { filePath: topFrame.filePath }
        );

        if (importResult.records.length > 0) {
          output += `### Imports of ${topFrame.filePath}\n`;
          for (const r of importResult.records) {
            const targetType = r.get("target_type");
            const targetId = targetType === "Package" ? r.get("target_name") : r.get("target_path");
            const symbols = r.get("symbols") as string[];
            const symbolStr = symbols?.length ? ` {${symbols.join(", ")}}` : "";
            output += `- → ${targetId}${symbolStr} (${targetType})\n`;
          }
          output += "\n";
        }

        // Step 5b: Get symbol-level direct imports from the error file
        const directImportResult = await session.run(
          `MATCH (f:File {path: $filePath})-[di:DIRECTLY_IMPORTS]->(sym)
           WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
           OPTIONAL MATCH (tf:File)-[:CONTAINS]->(sym)
           RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
                  tf.path AS target_file, di.import_kind AS import_kind,
                  di.alias AS alias, di.resolved_type AS resolved_type`,
          { filePath: topFrame.filePath }
        );

        if (directImportResult.records.length > 0) {
          output += `### Direct symbol imports from ${topFrame.filePath}\n`;
          for (const r of directImportResult.records) {
            const alias = r.get("alias") ? ` as ${r.get("alias")}` : "";
            const resolvedType = r.get("resolved_type") ? ` :: ${r.get("resolved_type")}` : "";
            output += `- → ${r.get("symbol_name")} (${r.get("symbol_kind")}) in ${r.get("target_file") || "unknown"}${alias}${resolvedType}\n`;
          }
          output += "\n";
        }
      } finally {
        await session.close();
      }

      // Step 6: Get file source from Supabase
      const { data: fileData } = await sb
        .from("file_contents")
        .select("content, language")
        .eq("repo_id", repoId)
        .eq("file_path", topFrame.filePath)
        .limit(1)
        .single();

      if (fileData) {
        output += `### Source: ${topFrame.filePath} (${fileData.language})\n`;
        output += "```" + (fileData.language || "") + "\n";
        output += fileData.content + "\n";
        output += "```\n";
      }

      // Add all parsed frames
      if (frames.length > 1) {
        output += `\n### Full Stack Frames (${frames.length})\n`;
        for (const f of frames) {
          output += `- ${f.functionName || "(anonymous)"} at ${f.filePath}:${f.lineNumber}\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    }
  );
}

function formatLogEntries(entries: Record<string, unknown>[]): string {
  if (entries.length === 0) return "No matching logs.";

  const output = entries
    .map((e: any) => {
      let line = `[${e.timestamp}] ${e.source} ${e.level.toUpperCase()}: ${e.message}`;
      if (e.file_path) line += `\n  → ${e.file_path}:${e.line_number}`;
      return line;
    })
    .join("\n\n");

  return `## Search Results (${entries.length})\n\n${output}`;
}
