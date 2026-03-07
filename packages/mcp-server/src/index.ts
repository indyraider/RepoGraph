import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import neo4j, { Driver, Session } from "neo4j-driver";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { registerRuntimeTools } from "./runtime-tools.js";
import { registerTemporalTools } from "./temporal-tools.js";

// Load .env from project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Database connections
let neo4jDriver: Driver;
let supabase: SupabaseClient;

function getNeo4j(): Driver {
  if (!neo4jDriver) {
    neo4jDriver = neo4j.driver(
      process.env.NEO4J_URI || "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USERNAME || "neo4j",
        process.env.NEO4J_PASSWORD || "password"
      )
    );
  }
  return neo4jDriver;
}

function getSession(): Session {
  return getNeo4j().session({
    database: process.env.NEO4J_DATABASE || "neo4j",
  });
}

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_KEY || ""
    );
  }
  return supabase;
}

// User-scoped Supabase client — when REPOGRAPH_USER_TOKEN is set, creates a
// client scoped to that user's RLS policies. Falls back to service key.
let userSupabase: SupabaseClient | null = null;
const USER_TOKEN = process.env.REPOGRAPH_USER_TOKEN || null;

function getUserSupabase(): SupabaseClient {
  if (!USER_TOKEN) return getSupabase();
  if (!userSupabase) {
    const anonKey = process.env.SUPABASE_ANON_KEY || "";
    if (!anonKey) {
      console.error("RepoGraph MCP: REPOGRAPH_USER_TOKEN set but SUPABASE_ANON_KEY missing — falling back to service key");
      return getSupabase();
    }
    userSupabase = createClient(process.env.SUPABASE_URL || "", anonKey, {
      global: {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      },
    });
  }
  return userSupabase;
}

// Repo scoping — when set, all tools default to this repo so the MCP server
// only surfaces the graph for the project it's running in.
const SCOPED_REPO = process.env.REPOGRAPH_REPO || null;

// Cache the scoped repo's Supabase UUID so we don't look it up on every call.
let _scopedRepoId: string | null = null;
async function getScopedRepoId(): Promise<string | null> {
  if (!SCOPED_REPO) return null;
  if (_scopedRepoId) return _scopedRepoId;
  const sb = getUserSupabase();
  const { data } = await sb
    .from("repositories")
    .select("id")
    .or(`name.eq.${SCOPED_REPO},url.eq.${SCOPED_REPO}`)
    .limit(1)
    .single();
  _scopedRepoId = data?.id ?? null;
  return _scopedRepoId;
}

// Temporal filter helper — generates a Cypher WHERE clause fragment for a node/edge alias.
// When commitTs is null (no at_commit), filters for current state only.
// When commitTs is provided, filters for point-in-time state at that timestamp.
function temporalFilter(alias: string, commitTs: string | null): string {
  if (commitTs !== null) {
    return `(${alias}.valid_from_ts IS NULL OR ${alias}.valid_from_ts <= $commitTs) AND (${alias}.valid_to_ts IS NULL OR ${alias}.valid_to_ts > $commitTs)`;
  }
  return `${alias}.valid_to IS NULL`;
}

// Resolve a commit SHA (or prefix) to its timestamp. Returns null if not found.
async function resolveCommitTs(
  session: neo4j.Session,
  repo: string,
  commitSha: string
): Promise<string | null> {
  const result = await session.run(
    `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
     WITH r.url AS repoUrl
     MATCH (c:Commit {repo_url: repoUrl}) WHERE c.sha STARTS WITH $sha
     RETURN c.timestamp AS ts LIMIT 1`,
    { repo, sha: commitSha }
  );
  return result.records.length > 0 ? (result.records[0].get("ts") as string) : null;
}

// Create MCP server
const server = new McpServer({
  name: "repograph",
  version: "1.0.0",
});

// Tool: search_code
server.tool(
  "search_code",
  "Full-text search across all indexed file contents. Returns matching files ranked by relevance.",
  {
    query: z.string().describe("Search query text"),
    language: z.string().optional().describe("Filter by language (e.g. 'typescript', 'python')"),
    max_results: z.number().optional().default(10).describe("Max results to return"),
  },
  async ({ query, language, max_results }) => {
    const sb = getUserSupabase();
    const scopedRepoId = await getScopedRepoId();

    let dbQuery = sb.rpc("search_files", {
      search_query: query,
      result_limit: max_results || 10,
      lang_filter: language || null,
    });

    const { data, error } = await dbQuery;

    if (error) {
      // Fallback: use ilike if RPC doesn't exist yet
      let fallback = sb
        .from("file_contents")
        .select("file_path, language, size_bytes")
        .ilike("content", `%${query}%`)
        .limit(max_results || 10);

      if (language) fallback = fallback.eq("language", language);
      if (scopedRepoId) fallback = fallback.eq("repo_id", scopedRepoId);

      const { data: fbData, error: fbError } = await fallback;
      if (fbError) {
        return { content: [{ type: "text" as const, text: `Search error: ${fbError.message}` }] };
      }
      const results = (fbData || [])
        .map((f: { file_path: string; language: string }) => `${f.file_path} (${f.language})`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: results || "No results found." }],
      };
    }

    // Filter RPC results by scoped repo (RPC doesn't accept repo_id param)
    let filtered = data || [];
    if (scopedRepoId) {
      // RPC returns file_path — cross-check against file_contents for this repo
      const { data: repoFiles } = await sb
        .from("file_contents")
        .select("file_path")
        .eq("repo_id", scopedRepoId);
      if (repoFiles) {
        const repoPaths = new Set(repoFiles.map((f: { file_path: string }) => f.file_path));
        filtered = filtered.filter((f: { file_path: string }) => repoPaths.has(f.file_path));
      }
    }

    const results = filtered
      .map((f: { file_path: string; language: string; rank: number }) =>
        `${f.file_path} (${f.language}) [rank: ${f.rank?.toFixed(3) || "n/a"}]`
      )
      .join("\n");

    return {
      content: [{ type: "text" as const, text: results || "No results found." }],
    };
  }
);

// Tool: get_file
server.tool(
  "get_file",
  "Retrieve the full content of a specific file by path. Returns the file content as text.",
  {
    repo: z.string().describe("Repository name or URL"),
    path: z.string().describe("File path within the repository"),
  },
  async ({ repo, path: filePath }) => {
    const sb = getUserSupabase();
    const scopedRepoId = await getScopedRepoId();
    const repoFilter = (q: any) => scopedRepoId ? q.eq("repo_id", scopedRepoId) : q;

    // Try to find by exact path
    let exactQuery = sb
      .from("file_contents")
      .select("content, language, size_bytes, file_path")
      .eq("file_path", filePath)
      .limit(1);
    const { data, error } = await repoFilter(exactQuery).single();

    if (error || !data) {
      // Try partial path match
      let partialQuery = sb
        .from("file_contents")
        .select("content, language, size_bytes, file_path")
        .ilike("file_path", `%${filePath}`)
        .limit(1);
      const { data: partial } = await repoFilter(partialQuery).single();

      if (!partial) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `// ${partial.file_path} (${partial.language}, ${partial.size_bytes} bytes)\n\n${partial.content}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `// ${data.file_path} (${data.language}, ${data.size_bytes} bytes)\n\n${data.content}`,
        },
      ],
    };
  }
);

// Tool: get_repo_structure
server.tool(
  "get_repo_structure",
  "Return the file tree of a repository, optionally filtered by directory prefix or depth.",
  {
    repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
    root: z.string().optional().describe("Filter to files under this directory prefix"),
    depth: z.number().optional().describe("Maximum directory depth to show"),
  },
  async ({ repo: repoParam, root, depth }) => {
    const repo = repoParam || SCOPED_REPO;
    if (!repo) {
      return { content: [{ type: "text" as const, text: "Error: no repo specified and REPOGRAPH_REPO not set." }] };
    }
    const session = getSession();
    try {
      const result = await session.run(
        `MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File)
         WHERE (r.name = $repo OR r.url = $repo)
           AND f.valid_to IS NULL
         RETURN f.path AS path, f.language AS language, f.size_bytes AS size
         ORDER BY f.path`,
        { repo }
      );

      let files = result.records.map((r) => ({
        path: r.get("path") as string,
        language: r.get("language") as string,
        size: (r.get("size") as any)?.toNumber?.() ?? r.get("size"),
      }));

      // Filter by root prefix
      if (root) {
        const prefix = root.endsWith("/") ? root : root + "/";
        files = files.filter((f) => f.path.startsWith(prefix));
      }

      // Filter by depth (relative to root prefix, or absolute if no root)
      if (depth) {
        const rootDepth = root ? (root.endsWith("/") ? root : root + "/").split("/").filter(Boolean).length : 0;
        files = files.filter((f) => {
          const parts = f.path.split("/");
          return parts.length <= rootDepth + depth;
        });
      }

      if (files.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No files found for repo: ${repo}` }],
        };
      }

      const tree = files
        .map((f) => `${f.path}  (${f.language}, ${f.size}B)`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Repository: ${repo}\nFiles: ${files.length}\n\n${tree}`,
          },
        ],
      };
    } finally {
      await session.close();
    }
  }
);

// Tool: get_symbol
server.tool(
  "get_symbol",
  "Look up a function, class, or type by name. Returns definition, signature, docstring, file location, and usages (what calls or imports it). Optionally includes the source code.",
  {
    name: z.string().describe("Symbol name to look up"),
    kind: z
      .enum(["function", "class", "type", "constant"])
      .optional()
      .describe("Filter by symbol kind"),
    repo: z.string().optional().describe("Repository name or URL to scope the search"),
    include_source: z.boolean().optional().default(false).describe("Include the source code of the symbol (fetched from Supabase file_contents)"),
    at_commit: z.string().optional().describe("Show the symbol as it existed at this commit SHA (time-travel). Omit for current state."),
  },
  async ({ name, kind, repo: repoParam, include_source, at_commit }) => {
    const repo = repoParam || SCOPED_REPO;
    const session = getSession();
    try {
      // Resolve at_commit to a timestamp for temporal filtering
      let commitTs: string | null = null;
      if (at_commit && repo) {
        commitTs = await resolveCommitTs(session, repo, at_commit);
        if (!commitTs) {
          return { content: [{ type: "text" as const, text: `Commit not found: ${at_commit}` }] };
        }
      }
      // Build label filter
      const labels = kind
        ? kind === "function"
          ? "Function"
          : kind === "class"
            ? "Class"
            : kind === "constant"
              ? "Constant"
              : "TypeDef"
        : null;

      const labelFilter = labels ? `:${labels}` : "";

      const query = repo
        ? `MATCH (r:Repository)
           WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           WHERE ${temporalFilter("sym", commitTs)}
           OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
           WHERE ${temporalFilter("c", commitTs)}
             AND ${temporalFilter("caller", commitTs)}
           OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
           OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
           WHERE $name IN imp.symbols AND ${temporalFilter("imp", commitTs)}
           OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
           WHERE ${temporalFilter("di", commitTs)}
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  sym.signature AS signature, sym.docstring AS docstring,
                  sym.start_line AS start_line, sym.end_line AS end_line,
                  f.path AS file_path,
                  sym.resolved_signature AS resolved_signature,
                  sym.param_types AS param_types,
                  sym.return_type AS return_type,
                  sym.is_generic AS is_generic,
                  sym.type_params AS type_params,
                  collect(DISTINCT {caller: caller.name, file: cf.path, call_site_line: c.call_site_line, has_type_mismatch: c.has_type_mismatch}) AS callers,
                  collect(DISTINCT importer.path) AS imported_by,
                  collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by`
        : `MATCH (f:File)-[:CONTAINS]->(sym${labelFilter} {name: $name})
           WHERE ${temporalFilter("sym", commitTs)}
           OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
           WHERE ${temporalFilter("c", commitTs)}
             AND ${temporalFilter("caller", commitTs)}
           OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
           OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
           WHERE $name IN imp.symbols AND ${temporalFilter("imp", commitTs)}
           OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
           WHERE ${temporalFilter("di", commitTs)}
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  sym.signature AS signature, sym.docstring AS docstring,
                  sym.start_line AS start_line, sym.end_line AS end_line,
                  f.path AS file_path,
                  sym.resolved_signature AS resolved_signature,
                  sym.param_types AS param_types,
                  sym.return_type AS return_type,
                  sym.is_generic AS is_generic,
                  sym.type_params AS type_params,
                  collect(DISTINCT {caller: caller.name, file: cf.path, call_site_line: c.call_site_line, has_type_mismatch: c.has_type_mismatch}) AS callers,
                  collect(DISTINCT importer.path) AS imported_by,
                  collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by`;

      let result = await session.run(query, { name, repo: repo || null, commitTs });
      let fuzzyMatch = false;

      // Fuzzy fallback: if exact match fails, try case-insensitive CONTAINS
      if (result.records.length === 0) {
        fuzzyMatch = true;
        const fuzzyQuery = repo
          ? `MATCH (r:Repository)
             WHERE r.name = $repo OR r.url = $repo
             WITH r.url AS repoUrl
             MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym)
             WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
               AND toLower(sym.name) CONTAINS toLower($name)
               AND ${temporalFilter("sym", commitTs)}
             OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
             WHERE ${temporalFilter("c", commitTs)}
               AND ${temporalFilter("caller", commitTs)}
             OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
             OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
             WHERE ANY(s IN imp.symbols WHERE toLower(s) CONTAINS toLower($name))
               AND ${temporalFilter("imp", commitTs)}
             OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
             WHERE ${temporalFilter("di", commitTs)}
             RETURN sym.name AS name, labels(sym)[0] AS kind,
                    sym.signature AS signature, sym.docstring AS docstring,
                    sym.start_line AS start_line, sym.end_line AS end_line,
                    f.path AS file_path,
                    sym.resolved_signature AS resolved_signature,
                    sym.param_types AS param_types,
                    sym.return_type AS return_type,
                    sym.is_generic AS is_generic,
                    sym.type_params AS type_params,
                    collect(DISTINCT {caller: caller.name, file: cf.path, call_site_line: c.call_site_line, has_type_mismatch: c.has_type_mismatch}) AS callers,
                    collect(DISTINCT importer.path) AS imported_by,
                    collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by
             LIMIT 10`
          : `MATCH (f:File)-[:CONTAINS]->(sym)
             WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
               AND toLower(sym.name) CONTAINS toLower($name)
               AND ${temporalFilter("sym", commitTs)}
             OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
             WHERE ${temporalFilter("c", commitTs)}
               AND ${temporalFilter("caller", commitTs)}
             OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
             OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
             WHERE ANY(s IN imp.symbols WHERE toLower(s) CONTAINS toLower($name))
               AND ${temporalFilter("imp", commitTs)}
             OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)
             WHERE ${temporalFilter("di", commitTs)}
             RETURN sym.name AS name, labels(sym)[0] AS kind,
                    sym.signature AS signature, sym.docstring AS docstring,
                    sym.start_line AS start_line, sym.end_line AS end_line,
                    f.path AS file_path,
                    sym.resolved_signature AS resolved_signature,
                    sym.param_types AS param_types,
                    sym.return_type AS return_type,
                    sym.is_generic AS is_generic,
                    sym.type_params AS type_params,
                    collect(DISTINCT {caller: caller.name, file: cf.path, call_site_line: c.call_site_line, has_type_mismatch: c.has_type_mismatch}) AS callers,
                    collect(DISTINCT importer.path) AS imported_by,
                    collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by
             LIMIT 10`;

        result = await session.run(fuzzyQuery, { name, repo: repo || null, commitTs });
      }

      if (result.records.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Symbol not found: ${name}` }],
        };
      }

      let output = fuzzyMatch ? `(fuzzy match for "${name}" — showing partial matches)\n\n` : "";
      output += result.records
        .map((r) => {
          const callers = (r.get("callers") as any[]).filter((c) => c.caller);
          const importedBy = (r.get("imported_by") as string[]).filter(Boolean);

          let text = `## ${r.get("kind")}: ${r.get("name")}\n`;
          text += `File: ${r.get("file_path")}:${r.get("start_line")}\n`;
          text += `Signature: ${r.get("signature") || "n/a"}\n`;
          if (r.get("resolved_signature")) text += `Resolved type: ${r.get("resolved_signature")}\n`;
          if (r.get("param_types")) text += `Param types: ${(r.get("param_types") as string[]).join(", ")}\n`;
          if (r.get("return_type")) text += `Return type: ${r.get("return_type")}\n`;
          if (r.get("is_generic")) text += `Generic: yes (${(r.get("type_params") as string[] || []).join(", ")})\n`;
          if (r.get("docstring")) text += `Docstring: ${r.get("docstring")}\n`;
          text += `Lines: ${r.get("start_line")}-${r.get("end_line")}\n`;

          if (callers.length > 0) {
            text += `\nCalled by:\n`;
            callers.forEach((c) => {
              const callLine = c.call_site_line?.toNumber?.() ?? c.call_site_line;
              const line = callLine ? `:${callLine}` : "";
              const mismatch = c.has_type_mismatch ? ` ⚠ TYPE MISMATCH` : "";
              text += `  - ${c.caller} in ${c.file}${line}${mismatch}\n`;
            });
          }

          if (importedBy.length > 0) {
            text += `\nImported by:\n`;
            importedBy.forEach((f) => {
              text += `  - ${f}\n`;
            });
          }

          const directImporters = (r.get("directly_imported_by") as any[]).filter((d) => d.file);
          if (directImporters.length > 0) {
            text += `\nDirectly imported by:\n`;
            directImporters.forEach((d) => {
              const alias = d.alias ? ` as ${d.alias}` : "";
              text += `  - ${d.file} (${d.kind || "named"}${alias})\n`;
            });
          }

          return text;
        })
        .join("\n---\n");

      // Optionally fetch source code from Supabase
      if (include_source) {
        const sb = getUserSupabase();
        for (const r of result.records) {
          const filePath = r.get("file_path") as string;
          const startLine = (r.get("start_line") as any)?.toNumber?.() ?? r.get("start_line");
          const endLine = (r.get("end_line") as any)?.toNumber?.() ?? r.get("end_line");

          const { data } = await sb
            .from("file_contents")
            .select("content")
            .eq("file_path", filePath)
            .limit(1)
            .single();

          if (data?.content) {
            const lines = data.content.split("\n");
            const snippet = lines.slice(startLine - 1, endLine).join("\n");
            output += `\n\n### Source: ${filePath}:${startLine}-${endLine}\n\`\`\`\n${snippet}\n\`\`\``;
          }
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } finally {
      await session.close();
    }
  }
);

// Tool: get_dependencies
server.tool(
  "get_dependencies",
  "For a given file, return all imports (what it depends on) and/or all reverse imports (what depends on it).",
  {
    repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
    path: z.string().describe("File path within the repository"),
    direction: z
      .enum(["in", "out", "both"])
      .optional()
      .default("both")
      .describe("'out' = what this file imports, 'in' = what imports this file, 'both' = both"),
    at_commit: z.string().optional().describe("Show dependencies as they existed at this commit SHA (time-travel). Omit for current state."),
  },
  async ({ repo: _repoParam, path: filePath, direction, at_commit }) => {
    const repo = _repoParam || SCOPED_REPO;
    const session = getSession();
    try {
      // Resolve at_commit to a timestamp for temporal filtering
      let commitTs: string | null = null;
      if (at_commit && repo) {
        commitTs = await resolveCommitTs(session, repo, at_commit);
        if (!commitTs) {
          return { content: [{ type: "text" as const, text: `Commit not found: ${at_commit}` }] };
        }
      }

      const parts: string[] = [];

      if (direction === "out" || direction === "both") {
        const outResult = await session.run(
          `MATCH (f:File {path: $path})-[r:IMPORTS]->(target)
           WHERE ${temporalFilter("r", commitTs)}
           RETURN target.path AS target_path, target.name AS target_name,
                  labels(target)[0] AS target_type, r.symbols AS symbols`,
          { path: filePath, commitTs }
        );

        if (outResult.records.length > 0) {
          parts.push("## Imports (dependencies):");
          outResult.records.forEach((r) => {
            const targetType = r.get("target_type");
            const targetId =
              targetType === "Package"
                ? r.get("target_name")
                : r.get("target_path");
            const symbols = r.get("symbols") as string[];
            const symbolStr = symbols?.length ? ` {${symbols.join(", ")}}` : "";
            parts.push(`  → ${targetId}${symbolStr} (${targetType})`);
          });
        } else {
          parts.push("## Imports: none");
        }
      }

      if (direction === "in" || direction === "both") {
        const inResult = await session.run(
          `MATCH (source:File)-[r:IMPORTS]->(f:File {path: $path})
           WHERE ${temporalFilter("r", commitTs)}
           RETURN source.path AS source_path, r.symbols AS symbols`,
          { path: filePath, commitTs }
        );

        if (inResult.records.length > 0) {
          parts.push("\n## Imported by (dependents):");
          inResult.records.forEach((r) => {
            const symbols = r.get("symbols") as string[];
            const symbolStr = symbols?.length ? ` {${symbols.join(", ")}}` : "";
            parts.push(`  ← ${r.get("source_path")}${symbolStr}`);
          });
        } else {
          parts.push("\n## Imported by: none");
        }

        // Symbol-level direct imports into this file's symbols
        const directInResult = await session.run(
          `MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})
           WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
             AND ${temporalFilter("sym", commitTs)}
             AND ${temporalFilter("di", commitTs)}
           RETURN source.path AS source_path, sym.name AS symbol_name,
                  di.import_kind AS import_kind, di.alias AS alias,
                  di.resolved_type AS resolved_type`,
          { path: filePath, commitTs }
        );

        if (directInResult.records.length > 0) {
          parts.push("\n## Directly imports (symbol-level):");
          directInResult.records.forEach((r) => {
            const alias = r.get("alias") ? ` as ${r.get("alias")}` : "";
            const resolvedType = r.get("resolved_type") ? ` :: ${r.get("resolved_type")}` : "";
            parts.push(`  ← ${r.get("source_path")} → ${r.get("symbol_name")} (${r.get("import_kind") || "named"}${alias})${resolvedType}`);
          });
        }

        // CALLS edges: what functions in this file call
        const callsOutResult = await session.run(
          `MATCH (f:File {path: $path})-[:CONTAINS]->(caller)-[r:CALLS]->(callee)<-[:CONTAINS]-(tf:File)
           WHERE (caller:Function OR caller:Class)
             AND ${temporalFilter("caller", commitTs)}
             AND ${temporalFilter("r", commitTs)}
             AND ${temporalFilter("callee", commitTs)}
           RETURN caller.name AS caller_name, callee.name AS callee_name,
                  tf.path AS target_file, r.call_site_line AS call_line`,
          { path: filePath, commitTs }
        );

        if (callsOutResult.records.length > 0) {
          parts.push("\n## CALLS (outgoing from this file):");
          callsOutResult.records.forEach((r) => {
            const line = (r.get("call_line") as any)?.toNumber?.() ?? r.get("call_line");
            parts.push(`  ${r.get("caller_name")} → ${r.get("callee_name")} in ${r.get("target_file")}:${line}`);
          });
        }

        // CALLS edges: what calls functions in this file
        const callsInResult = await session.run(
          `MATCH (sf:File)-[:CONTAINS]->(caller)-[r:CALLS]->(callee)<-[:CONTAINS]-(f:File {path: $path})
           WHERE (caller:Function OR caller:Class)
             AND ${temporalFilter("caller", commitTs)}
             AND ${temporalFilter("r", commitTs)}
             AND ${temporalFilter("callee", commitTs)}
           RETURN caller.name AS caller_name, sf.path AS source_file,
                  callee.name AS callee_name, r.call_site_line AS call_line`,
          { path: filePath, commitTs }
        );

        if (callsInResult.records.length > 0) {
          parts.push("\n## CALLS (incoming to this file):");
          callsInResult.records.forEach((r) => {
            const line = (r.get("call_line") as any)?.toNumber?.() ?? r.get("call_line");
            parts.push(`  ${r.get("caller_name")} in ${r.get("source_file")} → ${r.get("callee_name")}:${line}`);
          });
        }
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") || "No dependencies found." }],
      };
    } finally {
      await session.close();
    }
  }
);

// Tool: trace_imports
server.tool(
  "trace_imports",
  "Multi-hop import chain traversal. Starting from a file, walk the full import chain up to N hops in either direction.",
  {
    start_path: z.string().describe("Starting file path"),
    repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
    max_depth: z.number().optional().default(3).describe("Maximum traversal depth (default: 3)"),
    direction: z
      .enum(["upstream", "downstream"])
      .optional()
      .default("upstream")
      .describe("'upstream' = what this file imports (and their imports), 'downstream' = what imports this file (and their importers)"),
    at_commit: z.string().optional().describe("Show import chains as they existed at this commit SHA (time-travel). Omit for current state."),
  },
  async ({ start_path, repo: _repoParam, max_depth, direction, at_commit }) => {
    const repo = _repoParam || SCOPED_REPO;
    const session = getSession();
    try {
      // Resolve at_commit to a timestamp for temporal filtering
      let commitTs: string | null = null;
      if (at_commit && repo) {
        commitTs = await resolveCommitTs(session, repo, at_commit);
        if (!commitTs) {
          return { content: [{ type: "text" as const, text: `Commit not found: ${at_commit}` }] };
        }
      }

      const depth = Math.min(Math.max(Math.round(max_depth || 3), 1), 10);
      const dir = direction === "upstream" ? "" : "<";
      const dirEnd = direction === "upstream" ? ">" : "";

      // Neo4j doesn't support parameterized variable-length bounds,
      // so we validate depth is a safe integer (1-10) before interpolating.

      // File-level import chains via IMPORTS edges
      const importResult = await session.run(
        `MATCH path = (start:File {path: $startPath})${dir}-[:IMPORTS*1..${depth}]-${dirEnd}(target)
         WHERE ALL(rel IN relationships(path) WHERE ${temporalFilter("rel", commitTs)})
         RETURN [n IN nodes(path) |
           CASE WHEN n:File THEN n.path
                WHEN n:Package THEN 'pkg:' + n.name
                ELSE n.name END
         ] AS chain,
         [r IN relationships(path) | r.symbols] AS symbols,
         'file' AS trace_type
         LIMIT 50`,
        { startPath: start_path, commitTs }
      );

      // Symbol-level direct import edges (1-hop only — these point to symbol nodes)
      const directResult = await session.run(
        direction === "upstream"
          ? `MATCH (start:File {path: $startPath})-[di:DIRECTLY_IMPORTS]->(sym)
             WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
               AND ${temporalFilter("sym", commitTs)}
               AND ${temporalFilter("di", commitTs)}
             OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)
             RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
                    f.path AS target_file, di.import_kind AS import_kind,
                    di.alias AS alias, di.resolved_type AS resolved_type`
          : `MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(start:File {path: $startPath})
             WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
               AND ${temporalFilter("sym", commitTs)}
               AND ${temporalFilter("di", commitTs)}
             RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
                    source.path AS source_file, di.import_kind AS import_kind,
                    di.alias AS alias, di.resolved_type AS resolved_type`,
        { startPath: start_path, commitTs }
      );

      if (importResult.records.length === 0 && directResult.records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No import chains found from: ${start_path} (direction: ${direction})`,
            },
          ],
        };
      }

      const dirLabel = direction === "upstream" ? "imports" : "imported by";
      let output = `## Import trace from ${start_path} (${dirLabel}, max ${max_depth} hops)\n\n`;

      // File-level chains (with imported symbols on each hop)
      if (importResult.records.length > 0) {
        output += "### File-level chains\n";
        const seen = new Set<string>();
        importResult.records.forEach((r) => {
          const chain = r.get("chain") as string[];
          const symbols = r.get("symbols") as (string[] | null)[];
          const key = chain.join(" → ");
          if (!seen.has(key)) {
            seen.add(key);
            // Build chain with symbols: fileA -[sym1,sym2]→ fileB -[sym3]→ fileC
            const parts: string[] = [chain[0]];
            for (let i = 1; i < chain.length; i++) {
              const syms = symbols?.[i - 1];
              const symStr = syms?.length ? ` {${syms.join(", ")}}` : "";
              parts.push(`-${symStr}→ ${chain[i]}`);
            }
            output += parts.join(" ") + "\n";
          }
        });
        output += "\n";
      }

      // Symbol-level direct imports
      if (directResult.records.length > 0) {
        output += "### Symbol-level direct imports\n";
        directResult.records.forEach((r) => {
          const sym = r.get("symbol_name");
          const kind = r.get("symbol_kind");
          const alias = r.get("alias") ? ` as ${r.get("alias")}` : "";
          const resolvedType = r.get("resolved_type") ? ` :: ${r.get("resolved_type")}` : "";
          if (direction === "upstream") {
            const target = r.get("target_file") || "(unknown file)";
            output += `${start_path} → ${sym} (${kind}) in ${target}${alias}${resolvedType}\n`;
          } else {
            const source = r.get("source_file");
            output += `${source} → ${sym} (${kind})${alias}${resolvedType}\n`;
          }
        });
        output += "\n";
      }

      return { content: [{ type: "text" as const, text: output }] };
    } finally {
      await session.close();
    }
  }
);

// Tool: get_upstream_dep
server.tool(
  "get_upstream_dep",
  "Look up the public API of an upstream npm/pip/go package as indexed from dependencies. Returns exported functions, classes, and types with their signatures.",
  {
    package_name: z.string().describe("Package name (e.g. 'express', 'react', 'lodash')"),
    symbol: z.string().optional().describe("Filter to a specific exported symbol name"),
  },
  async ({ package_name, symbol }) => {
    const session = getSession();
    try {
      if (symbol) {
        // Look up a specific symbol
        const result = await session.run(
          `MATCH (pkg:Package {name: $packageName})-[:PROVIDES]->(pe:PackageExport)
           WHERE pe.name = $symbol
           RETURN pe.name AS name, pe.kind AS kind, pe.signature AS signature`,
          { packageName: package_name, symbol }
        );

        if (result.records.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Symbol '${symbol}' not found in package '${package_name}'`,
              },
            ],
          };
        }

        const output = result.records
          .map((r) => {
            return `${r.get("kind")}: ${r.get("name")}\n  ${r.get("signature") || ""}`;
          })
          .join("\n\n");

        return { content: [{ type: "text" as const, text: output }] };
      }

      // List all exports for the package
      const result = await session.run(
        `MATCH (pkg:Package {name: $packageName})
         OPTIONAL MATCH (pkg)-[:PROVIDES]->(pe:PackageExport)
         RETURN pkg.name AS name, pkg.version AS version, pkg.registry AS registry,
                collect({name: pe.name, kind: pe.kind, signature: pe.signature}) AS exports
         LIMIT 1`,
        { packageName: package_name }
      );

      if (result.records.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `Package not found: ${package_name}` },
          ],
        };
      }

      const record = result.records[0];
      const exports = (record.get("exports") as any[]).filter((e) => e.name);

      let output = `## Package: ${record.get("name")} v${record.get("version")} (${record.get("registry")})\n`;
      output += `Exports: ${exports.length}\n\n`;

      if (exports.length === 0) {
        output += "No type definitions available for this package.\n";
      } else {
        // Group by kind
        const byKind: Record<string, any[]> = {};
        for (const exp of exports) {
          const kind = exp.kind || "unknown";
          if (!byKind[kind]) byKind[kind] = [];
          byKind[kind].push(exp);
        }

        for (const [kind, items] of Object.entries(byKind)) {
          output += `### ${kind}s (${items.length})\n`;
          for (const item of items) {
            output += `- ${item.name}`;
            if (item.signature) output += `: ${item.signature}`;
            output += "\n";
          }
          output += "\n";
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } finally {
      await session.close();
    }
  }
);

// Tool: get_type_info
server.tool(
  "get_type_info",
  "Get resolved type information for a function or class: resolved signature, parameter types, return type, generics, and optionally which functions call it (with arg types and type mismatch flags).",
  {
    name: z.string().describe("Symbol name to look up"),
    file: z.string().optional().describe("File path to disambiguate if multiple symbols share the same name"),
    repo: z.string().optional().describe("Repository name or URL (defaults to scoped repo)"),
    include_callers: z.boolean().optional().default(false).describe("Include CALLS edges with caller arg types and type mismatch info"),
    at_commit: z.string().optional().describe("Show type info as it existed at this commit SHA (time-travel). Omit for current state."),
  },
  async ({ name, file, repo: repoParam, include_callers, at_commit }) => {
    const repo = repoParam || SCOPED_REPO;
    const session = getSession();
    try {
      // Resolve at_commit to a timestamp for temporal filtering
      let commitTs: string | null = null;
      if (at_commit && repo) {
        commitTs = await resolveCommitTs(session, repo, at_commit);
        if (!commitTs) {
          return { content: [{ type: "text" as const, text: `Commit not found: ${at_commit}` }] };
        }
      }

      const repoMatch = repo
        ? `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo WITH r.url AS repoUrl MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym)`
        : `MATCH (f:File)-[:CONTAINS]->(sym)`;

      const whereClause = file ? `WHERE sym.name = $name AND f.path = $file` : `WHERE sym.name = $name`;

      const query = `
        ${repoMatch}
        ${whereClause}
        AND (sym:Function OR sym:Class)
        AND ${temporalFilter("sym", commitTs)}
        OPTIONAL MATCH (caller)-[c:CALLS]->(sym)
        WHERE (caller:Function OR caller:Class)
          AND ${temporalFilter("c", commitTs)}
          AND ${temporalFilter("caller", commitTs)}
        OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
        RETURN sym.name AS name, labels(sym)[0] AS kind,
               sym.signature AS signature,
               sym.resolved_signature AS resolved_signature,
               sym.param_types AS param_types,
               sym.return_type AS return_type,
               sym.is_generic AS is_generic,
               sym.type_params AS type_params,
               f.path AS file_path, sym.start_line AS start_line, sym.end_line AS end_line,
               CASE WHEN $includeCallers THEN
                 collect(DISTINCT {
                   caller: caller.name, file: cf.path,
                   call_site_line: c.call_site_line,
                   has_mismatch: c.has_type_mismatch,
                   mismatch_detail: c.type_mismatch_detail
                 })
               ELSE [] END AS callers`;

      const result = await session.run(query, {
        name,
        file: file || null,
        repo: repo || null,
        includeCallers: include_callers ?? false,
        commitTs,
      });

      if (result.records.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No type info found for symbol: ${name}` }],
        };
      }

      const output = result.records
        .map((r) => {
          let text = `## ${r.get("kind")}: ${r.get("name")}\n`;
          text += `File: ${r.get("file_path")}:${r.get("start_line")}\n`;

          // Source signature (from parser)
          if (r.get("signature")) text += `Source signature: ${r.get("signature")}\n`;

          // Resolved type info (from SCIP)
          if (r.get("resolved_signature")) {
            text += `Resolved type: ${r.get("resolved_signature")}\n`;
          } else {
            text += `Resolved type: not available (SCIP may not have indexed this symbol)\n`;
          }

          if (r.get("param_types")) {
            const params = r.get("param_types") as string[];
            text += `Parameter types: ${params.join(", ")}\n`;
          }
          if (r.get("return_type")) text += `Return type: ${r.get("return_type")}\n`;
          if (r.get("is_generic")) {
            const typeParams = r.get("type_params") as string[] || [];
            text += `Generic: yes (${typeParams.join(", ")})\n`;
          }

          // Callers with type mismatch info
          if (include_callers) {
            const callers = (r.get("callers") as any[]).filter((c) => c.caller);
            if (callers.length > 0) {
              text += `\nCallers (${callers.length}):\n`;
              callers.forEach((c) => {
                const mismatch = c.has_mismatch ? ` ⚠ TYPE MISMATCH: ${c.mismatch_detail}` : "";
                const callLine = c.call_site_line?.toNumber?.() ?? c.call_site_line;
                const line = callLine ? `:${callLine}` : "";
                text += `  - ${c.caller} in ${c.file}${line}${mismatch}\n`;
              });
            } else {
              text += `\nCallers: none\n`;
            }
          }

          return text;
        })
        .join("\n---\n");

      return { content: [{ type: "text" as const, text: output }] };
    } finally {
      await session.close();
    }
  }
);

// Tool: query_graph
server.tool(
  "query_graph",
  "Escape hatch: run a raw Cypher query against the Neo4j knowledge graph for advanced or ad-hoc queries. Use this when the other tools don't cover your specific query need.",
  {
    cypher: z.string().describe("Cypher query to execute"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe("Query parameters as key-value pairs"),
  },
  async ({ cypher, params }) => {
    // Basic safety check — block write operations
    const upperCypher = cypher.toUpperCase().trim();
    const blocked = ["DELETE", "CREATE", "MERGE", "SET ", "REMOVE", "DROP", "ALTER", "GRANT", "REVOKE", "CALL {", "DETACH", "FOREACH"];
    if (blocked.some((kw) => upperCypher.includes(kw))) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: query_graph only supports read operations (MATCH/RETURN). Write operations are blocked for safety.",
          },
        ],
      };
    }

    const session = getSession();
    try {
      const result = await session.run(cypher, params || {});

      if (result.records.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Query returned no results." }],
        };
      }

      // Format results as a table
      const keys = result.records[0].keys;
      const rows = result.records.map((r) =>
        Object.fromEntries(
          keys.map((k) => {
            const val = r.get(k);
            // Handle Neo4j integer types
            if (val && typeof val === "object" && "toNumber" in val) {
              return [k, val.toNumber()];
            }
            return [k, val];
          })
        )
      );

      const output = JSON.stringify(rows, null, 2);
      return {
        content: [
          {
            type: "text" as const,
            text: `${SCOPED_REPO ? `⚠ Scoped to repo "${SCOPED_REPO}" — this raw query is unfiltered, results may include other repos.\n\n` : ""}Query returned ${rows.length} result(s):\n\n${output}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Cypher error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    } finally {
      await session.close();
    }
  }
);

// Register runtime context tools (log search, deploy history, trace_error)
registerRuntimeTools(server, getSession, getUserSupabase, SCOPED_REPO);

// Register temporal graph tools (symbol history, diff, blame, complexity trends)
registerTemporalTools(server, getSession, getUserSupabase, SCOPED_REPO);

// Start the server
async function main() {
  // Validate connections on startup
  try {
    const session = getSession();
    await session.run("RETURN 1");
    await session.close();
    console.error("RepoGraph MCP: Neo4j connected");
  } catch (err) {
    console.error("RepoGraph MCP: Neo4j connection failed —", err);
  }

  try {
    const sb = getSupabase();
    const { error } = await sb.from("repositories").select("id").limit(1);
    if (error) throw error;
    console.error("RepoGraph MCP: Supabase connected");
  } catch (err) {
    console.error("RepoGraph MCP: Supabase connection failed —", err);
  }

  if (USER_TOKEN) {
    console.error("RepoGraph MCP: user token set — queries scoped to user's repos via RLS");
  } else {
    console.error("RepoGraph MCP: WARNING — no REPOGRAPH_USER_TOKEN set, using service key (all tenants visible)");
  }

  if (SCOPED_REPO) {
    console.error(`RepoGraph MCP: scoped to repo "${SCOPED_REPO}"`);
  } else {
    console.error("RepoGraph MCP: no REPOGRAPH_REPO set — all repos visible");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RepoGraph MCP server running on stdio");
}

main().catch((err) => {
  console.error("RepoGraph MCP failed to start:", err);
  process.exit(1);
});
