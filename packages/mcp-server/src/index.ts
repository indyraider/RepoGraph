import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import neo4j, { Driver, Session } from "neo4j-driver";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { registerRuntimeTools } from "./runtime-tools.js";

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
    const sb = getSupabase();

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

    const results = (data || [])
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
    const sb = getSupabase();

    // Try to find by repo name first, then by URL
    const { data, error } = await sb
      .from("file_contents")
      .select("content, language, size_bytes, file_path")
      .eq("file_path", filePath)
      .limit(1)
      .single();

    if (error || !data) {
      // Try partial path match
      const { data: partial } = await sb
        .from("file_contents")
        .select("content, language, size_bytes, file_path")
        .ilike("file_path", `%${filePath}`)
        .limit(1)
        .single();

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
    repo: z.string().describe("Repository name or URL"),
    root: z.string().optional().describe("Filter to files under this directory prefix"),
    depth: z.number().optional().describe("Maximum directory depth to show"),
  },
  async ({ repo, root, depth }) => {
    const session = getSession();
    try {
      const result = await session.run(
        `MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File)
         WHERE r.name = $repo OR r.url = $repo
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

      // Filter by depth
      if (depth) {
        files = files.filter((f) => {
          const parts = f.path.split("/");
          return parts.length <= depth;
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
  "Look up a function, class, or type by name. Returns definition, signature, docstring, file location, and usages (what calls or imports it).",
  {
    name: z.string().describe("Symbol name to look up"),
    kind: z
      .enum(["function", "class", "type"])
      .optional()
      .describe("Filter by symbol kind"),
    repo: z.string().optional().describe("Repository name or URL to scope the search"),
  },
  async ({ name, kind, repo }) => {
    const session = getSession();
    try {
      // Build label filter
      const labels = kind
        ? kind === "function"
          ? "Function"
          : kind === "class"
            ? "Class"
            : "TypeDef"
        : null;

      const labelFilter = labels ? `:${labels}` : "";

      const query = repo
        ? `MATCH (r:Repository)
           WHERE r.name = $repo OR r.url = $repo
           WITH r.url AS repoUrl
           MATCH (f:File {repo_url: repoUrl})-[:CONTAINS]->(sym${labelFilter} {name: $name})
           OPTIONAL MATCH (caller:Function)-[:CALLS]->(sym)
           OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
           OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
           WHERE $name IN imp.symbols
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  sym.signature AS signature, sym.docstring AS docstring,
                  sym.start_line AS start_line, sym.end_line AS end_line,
                  f.path AS file_path,
                  collect(DISTINCT {caller: caller.name, file: cf.path}) AS callers,
                  collect(DISTINCT importer.path) AS imported_by`
        : `MATCH (f:File)-[:CONTAINS]->(sym${labelFilter} {name: $name})
           OPTIONAL MATCH (caller:Function)-[:CALLS]->(sym)
           OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
           OPTIONAL MATCH (importer:File)-[imp:IMPORTS]->(f)
           WHERE $name IN imp.symbols
           RETURN sym.name AS name, labels(sym)[0] AS kind,
                  sym.signature AS signature, sym.docstring AS docstring,
                  sym.start_line AS start_line, sym.end_line AS end_line,
                  f.path AS file_path,
                  collect(DISTINCT {caller: caller.name, file: cf.path}) AS callers,
                  collect(DISTINCT importer.path) AS imported_by`;

      const result = await session.run(query, { name, repo: repo || null });

      if (result.records.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Symbol not found: ${name}` }],
        };
      }

      const output = result.records
        .map((r) => {
          const callers = (r.get("callers") as any[]).filter((c) => c.caller);
          const importedBy = (r.get("imported_by") as string[]).filter(Boolean);

          let text = `## ${r.get("kind")}: ${r.get("name")}\n`;
          text += `File: ${r.get("file_path")}:${r.get("start_line")}\n`;
          text += `Signature: ${r.get("signature") || "n/a"}\n`;
          if (r.get("docstring")) text += `Docstring: ${r.get("docstring")}\n`;
          text += `Lines: ${r.get("start_line")}-${r.get("end_line")}\n`;

          if (callers.length > 0) {
            text += `\nCalled by:\n`;
            callers.forEach((c) => {
              text += `  - ${c.caller} in ${c.file}\n`;
            });
          }

          if (importedBy.length > 0) {
            text += `\nImported by:\n`;
            importedBy.forEach((f) => {
              text += `  - ${f}\n`;
            });
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

// Tool: get_dependencies
server.tool(
  "get_dependencies",
  "For a given file, return all imports (what it depends on) and/or all reverse imports (what depends on it).",
  {
    repo: z.string().describe("Repository name or URL"),
    path: z.string().describe("File path within the repository"),
    direction: z
      .enum(["in", "out", "both"])
      .optional()
      .default("both")
      .describe("'out' = what this file imports, 'in' = what imports this file, 'both' = both"),
  },
  async ({ repo, path: filePath, direction }) => {
    const session = getSession();
    try {
      const parts: string[] = [];

      if (direction === "out" || direction === "both") {
        const outResult = await session.run(
          `MATCH (f:File {path: $path})-[r:IMPORTS]->(target)
           RETURN target.path AS target_path, target.name AS target_name,
                  labels(target)[0] AS target_type, r.symbols AS symbols`,
          { path: filePath }
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
           RETURN source.path AS source_path, r.symbols AS symbols`,
          { path: filePath }
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
    repo: z.string().describe("Repository name or URL"),
    max_depth: z.number().optional().default(3).describe("Maximum traversal depth (default: 3)"),
    direction: z
      .enum(["upstream", "downstream"])
      .optional()
      .default("upstream")
      .describe("'upstream' = what this file imports (and their imports), 'downstream' = what imports this file (and their importers)"),
  },
  async ({ start_path, repo, max_depth, direction }) => {
    const session = getSession();
    try {
      const depth = Math.min(Math.max(Math.round(max_depth || 3), 1), 10);
      const dir = direction === "upstream" ? "" : "<";
      const dirEnd = direction === "upstream" ? ">" : "";

      // Neo4j doesn't support parameterized variable-length bounds,
      // so we validate depth is a safe integer (1-10) before interpolating.
      const result = await session.run(
        `MATCH path = (start:File {path: $startPath})${dir}-[:IMPORTS*1..${depth}]-${dirEnd}(target)
         RETURN [n IN nodes(path) |
           CASE WHEN n:File THEN n.path
                WHEN n:Package THEN 'pkg:' + n.name
                ELSE n.name END
         ] AS chain,
         [r IN relationships(path) | r.symbols] AS symbols
         LIMIT 50`,
        { startPath: start_path }
      );

      if (result.records.length === 0) {
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

      // Deduplicate and format chains
      const seen = new Set<string>();
      result.records.forEach((r) => {
        const chain = r.get("chain") as string[];
        const key = chain.join(" → ");
        if (!seen.has(key)) {
          seen.add(key);
          output += chain.join(" → ") + "\n";
        }
      });

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
            text: `Query returned ${rows.length} result(s):\n\n${output}`,
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
registerRuntimeTools(server, getSession, getSupabase);

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RepoGraph MCP server running on stdio");
}

main().catch((err) => {
  console.error("RepoGraph MCP failed to start:", err);
  process.exit(1);
});
