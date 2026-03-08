/**
 * Call Chain MCP Tool — trace_call_chain
 *
 * Walks CALLS edges (upstream/downstream/both) from a starting function,
 * returning the full execution chain as a structured tree in a single call.
 * Cross-module boundary crossings are detected by comparing file_path between
 * consecutive nodes in the chain.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Session } from "neo4j-driver";
import { SupabaseClient } from "@supabase/supabase-js";

type GetSessionFn = () => Session;
type GetSupabaseFn = () => SupabaseClient;

// --- Helpers (duplicated from index.ts to match temporal-tools.ts pattern) ---

function temporalFilter(alias: string, commitTs: string | null): string {
  if (commitTs !== null) {
    return `(${alias}.valid_from_ts IS NULL OR ${alias}.valid_from_ts <= $commitTs) AND (${alias}.valid_to_ts IS NULL OR ${alias}.valid_to_ts > $commitTs)`;
  }
  return `${alias}.valid_to IS NULL`;
}

async function resolveCommitTs(
  session: Session,
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
  return result.records.length > 0
    ? (result.records[0].get("ts") as string)
    : null;
}

// --- Types ---

interface ChainNode {
  name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number | null;
  edge_type: "CALLS" | "IMPORTS" | "DIRECTLY_IMPORTS" | null; // null for start node
  call_site_line: number | null;
  is_entry_point: boolean;
  is_leaf: boolean;
  is_external: boolean;
  children: ChainNode[];
}

interface StartNode {
  name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

interface TraceStats {
  total_nodes: number;
  max_depth_reached: number;
  cross_module_jumps: number;
  scope_exits: number;
  truncated: boolean;
}

// --- Core Query Functions ---

async function resolveStartNode(
  session: Session,
  name: string,
  repo: string,
  file: string | null,
  commitTs: string | null
): Promise<
  | { ok: true; node: StartNode }
  | { ok: false; error: string; candidates?: Array<{ name: string; file: string; start_line: number }> }
> {
  const fileClause = file ? `AND sym.file_path = $file` : "";
  const result = await session.run(
    `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
     WITH r.url AS repoUrl
     MATCH (sym) WHERE (sym:Function OR sym:Class)
       AND sym.name = $name AND sym.repo_url = repoUrl
       ${fileClause}
       AND ${temporalFilter("sym", commitTs)}
     RETURN sym.name AS name, sym.file_path AS file_path,
            sym.start_line AS start_line, sym.end_line AS end_line,
            sym.signature AS signature, labels(sym)[0] AS kind`,
    { repo, name, file, commitTs }
  );

  if (result.records.length === 0) {
    return { ok: false, error: `No function or class named '${name}' found in repo '${repo}'.` };
  }

  if (result.records.length > 1 && !file) {
    const candidates = result.records.map((r) => ({
      name: r.get("name") as string,
      file: r.get("file_path") as string,
      start_line: toNum(r.get("start_line")),
    }));
    return {
      ok: false,
      error: `Found ${candidates.length} symbols named '${name}'. Specify 'file' to disambiguate.`,
      candidates,
    };
  }

  const r = result.records[0];
  return {
    ok: true,
    node: {
      name: r.get("name") as string,
      kind: (r.get("kind") as string)?.toLowerCase() || "function",
      file: r.get("file_path") as string,
      start_line: toNum(r.get("start_line")),
      end_line: toNum(r.get("end_line")),
      signature: r.get("signature") as string | null,
    },
  };
}

async function traverseUpstream(
  session: Session,
  startName: string,
  startFilePath: string,
  repoUrl: string,
  maxDepth: number,
  commitTs: string | null
): Promise<Array<{ chain: Array<{ name: string; file_path: string; start_line: number; end_line: number | null; kind: string }>; edges: Array<{ call_site_line: number | null }> }>> {
  const result = await session.run(
    `MATCH (start) WHERE (start:Function OR start:Class)
       AND start.name = $name AND start.file_path = $filePath AND start.repo_url = $repoUrl
       AND ${temporalFilter("start", commitTs)}
     MATCH path = (start)<-[rels:CALLS*1..${maxDepth}]-(caller)
     WHERE ALL(rel IN relationships(path) WHERE ${temporalFilter("rel", commitTs)})
       AND ALL(n IN tail(nodes(path)) WHERE ${temporalFilter("n", commitTs)})
     WITH path
     LIMIT 200
     RETURN
       [n IN nodes(path) | {
         name: n.name, file_path: n.file_path, start_line: n.start_line,
         end_line: n.end_line, kind: labels(n)[0]
       }] AS chain,
       [r IN relationships(path) | {
         call_site_line: r.call_site_line
       }] AS edges`,
    { name: startName, filePath: startFilePath, repoUrl, commitTs }
  );

  return result.records.map((r) => ({
    chain: r.get("chain") as Array<{ name: string; file_path: string; start_line: number; end_line: number | null; kind: string }>,
    edges: r.get("edges") as Array<{ call_site_line: number | null }>,
  }));
}

async function traverseDownstream(
  session: Session,
  startName: string,
  startFilePath: string,
  repoUrl: string,
  maxDepth: number,
  commitTs: string | null
): Promise<Array<{ chain: Array<{ name: string; file_path: string; start_line: number; end_line: number | null; kind: string }>; edges: Array<{ call_site_line: number | null }> }>> {
  const result = await session.run(
    `MATCH (start) WHERE (start:Function OR start:Class)
       AND start.name = $name AND start.file_path = $filePath AND start.repo_url = $repoUrl
       AND ${temporalFilter("start", commitTs)}
     MATCH path = (start)-[rels:CALLS*1..${maxDepth}]->(callee)
     WHERE ALL(rel IN relationships(path) WHERE ${temporalFilter("rel", commitTs)})
       AND ALL(n IN tail(nodes(path)) WHERE ${temporalFilter("n", commitTs)})
     WITH path
     LIMIT 200
     RETURN
       [n IN nodes(path) | {
         name: n.name, file_path: n.file_path, start_line: n.start_line,
         end_line: n.end_line, kind: labels(n)[0]
       }] AS chain,
       [r IN relationships(path) | {
         call_site_line: r.call_site_line
       }] AS edges`,
    { name: startName, filePath: startFilePath, repoUrl, commitTs }
  );

  return result.records.map((r) => ({
    chain: r.get("chain") as Array<{ name: string; file_path: string; start_line: number; end_line: number | null; kind: string }>,
    edges: r.get("edges") as Array<{ call_site_line: number | null }>,
  }));
}

// --- Tree Assembly ---

function buildTree(
  startNode: StartNode,
  paths: Array<{ chain: Array<{ name: string; file_path: string; start_line: number; end_line: number | null; kind: string }>; edges: Array<{ call_site_line: number | null }> }>,
  direction: "upstream" | "downstream",
  scope: string | null
): { root: ChainNode; stats: Partial<TraceStats> } {
  const nodeKey = (n: { name: string; file_path?: string; file?: string }) =>
    `${n.file_path || n.file}::${n.name}`;
  const nodeMap = new Map<string, ChainNode>();
  let crossModuleJumps = 0;
  let scopeExits = 0;
  let maxDepthReached = 0;
  const NODE_CAP = 500;

  // Root node
  const rootKey = nodeKey({ name: startNode.name, file_path: startNode.file });
  const rootNode: ChainNode = {
    name: startNode.name,
    kind: startNode.kind,
    file: startNode.file,
    start_line: startNode.start_line,
    end_line: startNode.end_line,
    edge_type: null,
    call_site_line: null,
    is_entry_point: direction === "upstream" && paths.length === 0,
    is_leaf: direction === "downstream" && paths.length === 0,
    is_external: false,
    children: [],
  };
  nodeMap.set(rootKey, rootNode);

  for (const { chain, edges } of paths) {
    if (nodeMap.size >= NODE_CAP) break;

    const depth = chain.length - 1;
    if (depth > maxDepthReached) maxDepthReached = depth;

    // chain[0] is the start node, chain[1..] are callers/callees
    for (let i = 1; i < chain.length; i++) {
      if (nodeMap.size >= NODE_CAP) break;

      const parentIdx = i - 1;
      const parentRaw = chain[parentIdx];
      const childRaw = chain[i];
      const edge = edges[i - 1];

      const parentKey = nodeKey(parentRaw);
      const childKey = nodeKey(childRaw);
      const isNewNode = !nodeMap.has(childKey);

      // Detect scope exits — child is outside scope, mark as leaf and don't traverse further
      if (scope && !childRaw.file_path.startsWith(scope)) {
        scopeExits++;
        // Add a scope-exit leaf node but don't recurse into its children
        if (isNewNode) {
          const exitNode: ChainNode = {
            name: childRaw.name,
            kind: childRaw.kind?.toLowerCase() || "function",
            file: childRaw.file_path,
            start_line: toNum(childRaw.start_line),
            end_line: childRaw.end_line ? toNum(childRaw.end_line) : null,
            edge_type: "CALLS",
            call_site_line: edge?.call_site_line ? toNum(edge.call_site_line) : null,
            is_entry_point: direction === "upstream",
            is_leaf: direction === "downstream",
            is_external: false,
            children: [],
          };
          nodeMap.set(childKey, exitNode);
          const parentNode = nodeMap.get(parentKey);
          if (parentNode) parentNode.children.push(exitNode);
        }
        continue; // Don't process further hops in this path beyond the scope exit
      }

      // Detect cross-module jump (only count once per unique edge)
      if (isNewNode && parentRaw.file_path !== childRaw.file_path) {
        crossModuleJumps++;
      }

      // Detect external
      const isExternal =
        childRaw.file_path?.includes("node_modules") ||
        childRaw.kind === "PackageExport";

      // Get or create child node
      let childNode = nodeMap.get(childKey);
      if (!childNode) {
        childNode = {
          name: childRaw.name,
          kind: childRaw.kind?.toLowerCase() || "function",
          file: childRaw.file_path,
          start_line: toNum(childRaw.start_line),
          end_line: childRaw.end_line ? toNum(childRaw.end_line) : null,
          edge_type: "CALLS",
          call_site_line: edge?.call_site_line ? toNum(edge.call_site_line) : null,
          is_entry_point: false,
          is_leaf: false,
          is_external: isExternal,
          children: [],
        };
        nodeMap.set(childKey, childNode);
      }

      // Wire parent → child
      const parentNode = nodeMap.get(parentKey);
      if (parentNode && !parentNode.children.some((c) => nodeKey(c) === childKey)) {
        parentNode.children.push(childNode);
      }
    }
  }

  // Mark entry points (upstream: nodes with no further callers = no children in upstream tree)
  if (direction === "upstream") {
    for (const node of nodeMap.values()) {
      if (node !== rootNode && node.children.length === 0) {
        node.is_entry_point = true;
      }
    }
  }

  // Mark leaves (downstream: nodes with no further callees = no children in downstream tree)
  if (direction === "downstream") {
    for (const node of nodeMap.values()) {
      if (node !== rootNode && node.children.length === 0) {
        node.is_leaf = true;
      }
    }
  }

  return {
    root: rootNode,
    stats: {
      total_nodes: nodeMap.size,
      max_depth_reached: maxDepthReached,
      cross_module_jumps: crossModuleJumps,
      scope_exits: scopeExits,
      truncated: nodeMap.size >= NODE_CAP,
    },
  };
}

// --- Response Formatting ---

function formatTree(node: ChainNode, prefix: string = "", isLast: boolean = true, isRoot: boolean = true): string {
  let line = "";

  if (isRoot) {
    line = `${node.name} (${node.file}:${node.start_line})\n`;
  } else {
    const connector = isLast ? "└─" : "├─";
    const callLine = node.call_site_line ? `:${node.call_site_line}` : "";
    const tag = node.is_entry_point ? "  [entry point]" : node.is_leaf ? "  [leaf]" : "";
    const extTag = node.is_external ? "  [external]" : "";
    line = `${prefix}${connector}[CALLS${callLine}]─ ${node.name} (${node.file}:${node.start_line})${tag}${extTag}\n`;
  }

  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    const isChildLast = i === node.children.length - 1;
    line += formatTree(node.children[i], childPrefix, isChildLast, false);
  }

  return line;
}

function formatResponse(
  startNode: StartNode,
  upstreamTree: { root: ChainNode; stats: Partial<TraceStats> } | null,
  downstreamTree: { root: ChainNode; stats: Partial<TraceStats> } | null,
  direction: string
): string {
  let output = `## trace_call_chain: ${startNode.name}\n`;
  output += `**start:** ${startNode.name} (${startNode.file}:${startNode.start_line})`;
  if (startNode.signature) output += `\n**signature:** \`${startNode.signature}\``;
  output += "\n\n";

  if (upstreamTree && (direction === "upstream" || direction === "both")) {
    output += `### Upstream (callers)\n\`\`\`\n`;
    output += formatTree(upstreamTree.root);
    output += `\`\`\`\n\n`;
  }

  if (downstreamTree && (direction === "downstream" || direction === "both")) {
    output += `### Downstream (callees)\n\`\`\`\n`;
    output += formatTree(downstreamTree.root);
    output += `\`\`\`\n\n`;
  }

  // Merge stats
  const stats: TraceStats = {
    total_nodes:
      (upstreamTree?.stats.total_nodes || 0) +
      (downstreamTree?.stats.total_nodes || 0) -
      (upstreamTree && downstreamTree ? 1 : 0), // don't double-count start node
    max_depth_reached: Math.max(
      upstreamTree?.stats.max_depth_reached || 0,
      downstreamTree?.stats.max_depth_reached || 0
    ),
    cross_module_jumps:
      (upstreamTree?.stats.cross_module_jumps || 0) +
      (downstreamTree?.stats.cross_module_jumps || 0),
    scope_exits:
      (upstreamTree?.stats.scope_exits || 0) +
      (downstreamTree?.stats.scope_exits || 0),
    truncated:
      (upstreamTree?.stats.truncated || false) ||
      (downstreamTree?.stats.truncated || false),
  };

  output += `### Stats\n`;
  output += `- total_nodes: ${stats.total_nodes}\n`;
  output += `- max_depth_reached: ${stats.max_depth_reached}\n`;
  output += `- cross_module_jumps: ${stats.cross_module_jumps}\n`;
  output += `- scope_exits: ${stats.scope_exits}\n`;
  output += `- truncated: ${stats.truncated}\n`;

  return output;
}

// --- Neo4j integer helper ---

function toNum(val: unknown): number {
  if (val && typeof val === "object" && "toNumber" in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return typeof val === "number" ? val : 0;
}

// --- Registration ---

export function registerCallChainTools(
  server: McpServer,
  getSession: GetSessionFn,
  _getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void {
  server.tool(
    "trace_call_chain",
    "Walk CALLS edges from a starting function or symbol, returning the full execution chain — callers (upstream), callees (downstream), or both — with cross-module boundary detection. This is the primary tool for understanding how a function fits into the full execution flow of the codebase.",
    {
      start: z.string().describe("The name of the starting function or symbol"),
      repo: z
        .string()
        .optional()
        .describe("Repository name or URL (defaults to scoped repo)"),
      file: z
        .string()
        .optional()
        .describe(
          "Narrow the starting symbol lookup to a specific file path. Use to disambiguate when multiple functions share a name."
        ),
      direction: z
        .enum(["upstream", "downstream", "both"])
        .optional()
        .default("both")
        .describe(
          "upstream = walk callers toward entry points. downstream = walk callees toward leaves. both = full bidirectional chain."
        ),
      max_depth: z
        .number()
        .optional()
        .default(10)
        .describe(
          "Maximum number of hops in any direction (default: 10, max: 15)"
        ),
      scope: z
        .string()
        .optional()
        .describe(
          "Restrict traversal to files within a given path prefix (e.g., 'src/api/'). Calls leaving this scope are noted but not followed."
        ),
      include_external: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Whether to include calls into external package nodes (default: false)"
        ),
      at_commit: z
        .string()
        .optional()
        .describe(
          "Query the chain as it existed at a given commit SHA. Requires temporal graph data."
        ),
    },
    async ({
      start,
      repo: repoParam,
      file,
      direction,
      max_depth,
      scope,
      include_external,
      at_commit,
    }) => {
      const repo = repoParam || scopedRepo;
      if (!repo) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: no repo specified. Set REPOGRAPH_REPO or pass the 'repo' parameter.",
            },
          ],
        };
      }

      const depth = Math.min(Math.max(Math.round(max_depth || 10), 1), 15);
      const session = getSession();

      try {
        // Resolve at_commit to timestamp if provided
        let commitTs: string | null = null;
        if (at_commit) {
          commitTs = await resolveCommitTs(session, repo, at_commit);
          if (!commitTs) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: commit '${at_commit}' not found in repo '${repo}'.`,
                },
              ],
            };
          }
        }

        // Resolve the repo URL for Cypher queries
        const repoResult = await session.run(
          `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
           RETURN r.url AS url LIMIT 1`,
          { repo }
        );
        if (repoResult.records.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: repository '${repo}' not found.`,
              },
            ],
          };
        }
        const repoUrl = repoResult.records[0].get("url") as string;

        // Resolve start node
        const startResult = await resolveStartNode(
          session,
          start,
          repo,
          file || null,
          commitTs
        );

        if (!startResult.ok) {
          if (startResult.candidates) {
            let msg = `${startResult.error}\n\nCandidates:\n`;
            for (const c of startResult.candidates) {
              msg += `  - ${c.name} (${c.file}:${c.start_line})\n`;
            }
            return { content: [{ type: "text" as const, text: msg }] };
          }
          return {
            content: [{ type: "text" as const, text: `Error: ${startResult.error}` }],
          };
        }

        const startNode = startResult.node;

        // Run traversals based on direction
        let upstreamTree: { root: ChainNode; stats: Partial<TraceStats> } | null = null;
        let downstreamTree: { root: ChainNode; stats: Partial<TraceStats> } | null = null;

        if (direction === "upstream" || direction === "both") {
          const paths = await traverseUpstream(
            session,
            startNode.name,
            startNode.file,
            repoUrl,
            depth,
            commitTs
          );
          upstreamTree = buildTree(startNode, paths, "upstream", scope || null);
        }

        if (direction === "downstream" || direction === "both") {
          const paths = await traverseDownstream(
            session,
            startNode.name,
            startNode.file,
            repoUrl,
            depth,
            commitTs
          );
          downstreamTree = buildTree(startNode, paths, "downstream", scope || null);
        }

        // Filter external nodes if not requested
        if (!include_external) {
          if (upstreamTree) filterExternal(upstreamTree.root);
          if (downstreamTree) filterExternal(downstreamTree.root);
        }

        const output = formatResponse(startNode, upstreamTree, downstreamTree, direction || "both");
        return { content: [{ type: "text" as const, text: output }] };
      } finally {
        await session.close();
      }
    }
  );
}

function filterExternal(node: ChainNode): void {
  node.children = node.children.filter((child) => {
    if (child.is_external) return false;
    filterExternal(child);
    return true;
  });
}
