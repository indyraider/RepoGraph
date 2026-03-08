/**
 * CodeQL Data Flow MCP Tools — trace_data_flow + get_data_flow_findings
 *
 * Queries FLOWS_TO edges and DataFlowFinding nodes written by the CodeQL
 * pipeline stage to expose taint tracking and data flow analysis results.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "neo4j-driver";
import { SupabaseClient } from "@supabase/supabase-js";

type GetSessionFn = () => Session;
type GetSupabaseFn = () => SupabaseClient;

// --- Neo4j integer helper ---

function toNum(val: unknown): number {
  if (val && typeof val === "object" && "toNumber" in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return typeof val === "number" ? val : 0;
}

// --- CodeQL status helper ---

async function getCodeQLStatus(
  supabase: SupabaseClient,
  repoUrl: string
): Promise<string> {
  try {
    const { data } = await supabase
      .from("digest_jobs")
      .select("stats, completed_at")
      .eq("repo_url", repoUrl)
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!data) return "No completed digests found for this repo.";

    const codeqlStats = (data.stats as Record<string, unknown>)?.codeql as
      | Record<string, unknown>
      | undefined;

    if (!codeqlStats) return "CodeQL has not run for this repo.";

    const status = codeqlStats.status as string;
    const completedAt = data.completed_at as string;

    if (status === "skipped") {
      const reason = (codeqlStats.reason as string) || "unknown reason";
      return `CodeQL skipped: ${reason} (digest completed ${completedAt})`;
    }

    return `CodeQL last ran: status=${status} (digest completed ${completedAt})`;
  } catch {
    return "Unable to determine CodeQL status.";
  }
}

// --- Registration ---

export function registerCodeQLTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void {
  // ── trace_data_flow ──────────────────────────────────────────────

  server.tool(
    "trace_data_flow",
    "Trace taint/data flow paths through the codebase using CodeQL analysis results. Given a file and line, finds FLOWS_TO edges showing how untrusted data propagates from sources to security-sensitive sinks (SQL injection, XSS, command injection, etc.).",
    {
      file: z.string().describe("File path to search for data flow connections"),
      line: z
        .number()
        .optional()
        .describe("Line number within the file (narrows to the innermost function at that line)"),
      direction: z
        .enum(["from_source", "to_sink", "both"])
        .optional()
        .default("both")
        .describe(
          "from_source = where does data from this function flow to? to_sink = what flows data into this function? both = show all connections."
        ),
      repo: z
        .string()
        .optional()
        .describe("Repository name or URL (defaults to scoped repo)"),
      query_id: z
        .string()
        .optional()
        .describe("Filter to a specific CodeQL query ID (e.g., 'js/sql-injection')"),
      sink_kind: z
        .string()
        .optional()
        .describe("Filter by sink kind (e.g., 'sql', 'xss', 'command', 'path')"),
      max_results: z
        .number()
        .optional()
        .default(25)
        .describe("Maximum number of flow paths to return (default: 25)"),
    },
    async ({ file, line, direction, repo: repoParam, query_id, sink_kind, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: no repo specified. Set REPOGRAPH_REPO or pass the 'repo' parameter.",
          }],
        };
      }

      const session = getSession();
      try {
        // Resolve repo URL
        const repoResult = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           RETURN r.url AS url LIMIT 1`,
          { repo }
        );
        if (repoResult.records.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Error: repository '${repo}' not found.` }],
          };
        }
        const repoUrl = repoResult.records[0].get("url") as string;

        // Build match clause for the function at file:line
        const lineClause = line != null
          ? `AND f.start_line <= $line AND f.end_line >= $line`
          : "";
        const orderClause = line != null
          ? `ORDER BY (f.end_line - f.start_line) ASC`
          : "";

        // Optional edge filters
        const queryFilter = query_id ? `AND r.query_id = $queryId` : "";
        const sinkFilter = sink_kind ? `AND r.sink_kind = $sinkKind` : "";
        const params: Record<string, unknown> = {
          repoUrl,
          file,
          line: line ?? null,
          queryId: query_id ?? null,
          sinkKind: sink_kind ?? null,
          limit: Math.min(max_results || 25, 100),
        };

        const flows: Array<{
          direction: string;
          function_name: string;
          function_file: string;
          function_line: number;
          other_name: string;
          other_file: string;
          other_line: number;
          query_id: string;
          sink_kind: string;
          severity: string;
          message: string;
          path_steps: string;
          path_complete: boolean;
        }> = [];

        // From source: what does this function flow data TO?
        if (direction === "from_source" || direction === "both") {
          const result = await session.run(
            `MATCH (f:Function {repo_url: $repoUrl, file_path: $file})
             WHERE f.valid_to IS NULL ${lineClause}
             WITH f ${orderClause} LIMIT 1
             MATCH (f)-[r:FLOWS_TO]->(sink)
             WHERE sink.valid_to IS NULL ${queryFilter} ${sinkFilter}
             RETURN f.name AS fn_name, f.file_path AS fn_file, f.start_line AS fn_line,
                    sink.name AS other_name, sink.file_path AS other_file, sink.start_line AS other_line,
                    r.query_id AS query_id, r.sink_kind AS sink_kind,
                    r.severity AS severity, r.message AS message,
                    r.path_steps AS path_steps, r.path_complete AS path_complete
             LIMIT $limit`,
            params
          );

          for (const rec of result.records) {
            flows.push({
              direction: "from_source",
              function_name: rec.get("fn_name") as string,
              function_file: rec.get("fn_file") as string,
              function_line: toNum(rec.get("fn_line")),
              other_name: rec.get("other_name") as string,
              other_file: rec.get("other_file") as string,
              other_line: toNum(rec.get("other_line")),
              query_id: rec.get("query_id") as string,
              sink_kind: rec.get("sink_kind") as string,
              severity: rec.get("severity") as string,
              message: rec.get("message") as string,
              path_steps: rec.get("path_steps") as string,
              path_complete: rec.get("path_complete") as boolean,
            });
          }
        }

        // To sink: what flows data INTO this function?
        if (direction === "to_sink" || direction === "both") {
          const result = await session.run(
            `MATCH (f:Function {repo_url: $repoUrl, file_path: $file})
             WHERE f.valid_to IS NULL ${lineClause}
             WITH f ${orderClause} LIMIT 1
             MATCH (source)-[r:FLOWS_TO]->(f)
             WHERE source.valid_to IS NULL ${queryFilter} ${sinkFilter}
             RETURN f.name AS fn_name, f.file_path AS fn_file, f.start_line AS fn_line,
                    source.name AS other_name, source.file_path AS other_file, source.start_line AS other_line,
                    r.query_id AS query_id, r.sink_kind AS sink_kind,
                    r.severity AS severity, r.message AS message,
                    r.path_steps AS path_steps, r.path_complete AS path_complete
             LIMIT $limit`,
            params
          );

          for (const rec of result.records) {
            flows.push({
              direction: "to_sink",
              function_name: rec.get("fn_name") as string,
              function_file: rec.get("fn_file") as string,
              function_line: toNum(rec.get("fn_line")),
              other_name: rec.get("other_name") as string,
              other_file: rec.get("other_file") as string,
              other_line: toNum(rec.get("other_line")),
              query_id: rec.get("query_id") as string,
              sink_kind: rec.get("sink_kind") as string,
              severity: rec.get("severity") as string,
              message: rec.get("message") as string,
              path_steps: rec.get("path_steps") as string,
              path_complete: rec.get("path_complete") as boolean,
            });
          }
        }

        if (flows.length === 0) {
          const supabase = getSupabase();
          const status = await getCodeQLStatus(supabase, repoUrl);
          return {
            content: [{
              type: "text" as const,
              text: `No data flow paths found for ${file}${line != null ? `:${line}` : ""}.\n\n${status}`,
            }],
          };
        }

        // Format output
        let output = `## Data Flow: ${file}${line != null ? `:${line}` : ""}\n\n`;

        const fromSource = flows.filter((f) => f.direction === "from_source");
        const toSink = flows.filter((f) => f.direction === "to_sink");

        if (fromSource.length > 0) {
          output += `### Flows FROM this function (${fromSource.length} paths)\n`;
          for (const f of fromSource) {
            const severity = f.severity === "error" ? "!!!" : f.severity === "warning" ? "!!" : "!";
            output += `\n${severity} **${f.query_id}** (${f.sink_kind}) [${f.severity}]\n`;
            output += `  ${f.function_name} (${f.function_file}:${f.function_line})\n`;
            output += `  -> ${f.other_name} (${f.other_file}:${f.other_line})\n`;
            output += `  ${f.message}\n`;
            if (f.path_steps) {
              try {
                const steps = JSON.parse(f.path_steps) as Array<{ location: { file: string; line: number }; message: string }>;
                if (steps.length > 2) {
                  output += `  Path (${steps.length} steps):\n`;
                  for (const step of steps) {
                    const stepMsg = step.message ? ` — ${step.message}` : "";
                    output += `    ${step.location.file}:${step.location.line}${stepMsg}\n`;
                  }
                }
              } catch { /* path_steps may not be valid JSON */ }
            }
          }
          output += "\n";
        }

        if (toSink.length > 0) {
          output += `### Flows TO this function (${toSink.length} paths)\n`;
          for (const f of toSink) {
            const severity = f.severity === "error" ? "!!!" : f.severity === "warning" ? "!!" : "!";
            output += `\n${severity} **${f.query_id}** (${f.sink_kind}) [${f.severity}]\n`;
            output += `  ${f.other_name} (${f.other_file}:${f.other_line})\n`;
            output += `  -> ${f.function_name} (${f.function_file}:${f.function_line})\n`;
            output += `  ${f.message}\n`;
          }
          output += "\n";
        }

        output += `**${flows.length} data flow path(s) found.**\n`;

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );

  // ── get_data_flow_findings ───────────────────────────────────────

  server.tool(
    "get_data_flow_findings",
    "List CodeQL security findings (taint tracking / data flow analysis) for a repository. Shows sources, sinks, query IDs, and severity levels. Use this to get an overview of security issues found by static analysis.",
    {
      repo: z
        .string()
        .optional()
        .describe("Repository name or URL (defaults to scoped repo)"),
      severity: z
        .enum(["error", "warning", "note"])
        .optional()
        .describe("Filter by severity level"),
      query_id: z
        .string()
        .optional()
        .describe("Filter by CodeQL query ID (e.g., 'js/sql-injection', 'js/xss')"),
      file: z
        .string()
        .optional()
        .describe("Filter to findings where the source or sink is in this file"),
      max_results: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum findings to return (default: 50)"),
    },
    async ({ repo: repoParam, severity, query_id, file, max_results }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: no repo specified. Set REPOGRAPH_REPO or pass the 'repo' parameter.",
          }],
        };
      }

      const session = getSession();
      try {
        // Resolve repo URL
        const repoResult = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           RETURN r.url AS url LIMIT 1`,
          { repo }
        );
        if (repoResult.records.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Error: repository '${repo}' not found.` }],
          };
        }
        const repoUrl = repoResult.records[0].get("url") as string;

        // Build dynamic WHERE clauses
        const filters: string[] = [];
        if (severity) filters.push(`f.severity = $severity`);
        if (query_id) filters.push(`f.query_id = $queryId`);
        if (file) filters.push(`(f.source_path STARTS WITH $file OR f.sink_path STARTS WITH $file)`);

        const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

        const result = await session.run(
          `MATCH (f:DataFlowFinding {repo_url: $repoUrl})
           WHERE true ${whereClause}
           RETURN f.query_id AS query_id, f.severity AS severity,
                  f.message AS message, f.source_path AS source_path,
                  f.sink_path AS sink_path, f.path_complete AS path_complete,
                  f.job_id AS job_id
           ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
           LIMIT $limit`,
          {
            repoUrl,
            severity: severity ?? null,
            queryId: query_id ?? null,
            file: file ?? null,
            limit: Math.min(max_results || 50, 200),
          }
        );

        // Get CodeQL status
        const supabase = getSupabase();
        const status = await getCodeQLStatus(supabase, repoUrl);

        if (result.records.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No data flow findings found for '${repo}'.\n\n${status}`,
            }],
          };
        }

        // Group by query_id for organized output
        const byQuery = new Map<string, Array<{
          severity: string;
          message: string;
          source: string;
          sink: string;
          complete: boolean;
        }>>();

        for (const rec of result.records) {
          const qid = rec.get("query_id") as string;
          if (!byQuery.has(qid)) byQuery.set(qid, []);
          byQuery.get(qid)!.push({
            severity: rec.get("severity") as string,
            message: rec.get("message") as string,
            source: rec.get("source_path") as string,
            sink: rec.get("sink_path") as string,
            complete: rec.get("path_complete") as boolean,
          });
        }

        let output = `## Data Flow Findings\n${status}\n\n`;
        output += `**${result.records.length} finding(s)** across ${byQuery.size} query type(s)\n\n`;

        for (const [qid, findings] of byQuery) {
          const sev = findings[0].severity;
          const sevIcon = sev === "error" ? "!!!" : sev === "warning" ? "!!" : "!";
          output += `### ${sevIcon} ${qid} (${findings.length} finding${findings.length > 1 ? "s" : ""}) [${sev}]\n`;

          for (const f of findings) {
            const completeness = f.complete ? "" : " [partial match]";
            output += `- **source:** ${f.source} -> **sink:** ${f.sink}${completeness}\n`;
            output += `  ${f.message}\n`;
          }
          output += "\n";
        }

        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );
}
