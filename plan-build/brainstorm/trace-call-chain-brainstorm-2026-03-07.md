# Brainstorm: `trace_call_chain` MCP Tool
**Created:** 2026-03-07
**Status:** Draft
**PRD:** Feature Add/repograph-trace-call-chain-prd.md

## Vision

Add a `trace_call_chain` MCP tool that walks `CALLS` and `IMPORTS` edges together in a single Neo4j traversal — starting from any function or symbol — and returns the full execution stack (upstream callers, downstream callees, cross-module jumps) in one structured response. This eliminates the 10-20 serial tool calls currently needed to assemble a call chain manually.

## Existing Context

via RepoGraph: The MCP server lives at `packages/mcp-server/src/index.ts` (47KB, 20 tools). Key findings:

**Tool registration pattern:**
```typescript
server.tool("tool_name", "description", { ...zod_schema }, async (params) => {
  const session = getSession();
  try {
    const result = await session.run(cypher, params);
    // process results
    return { content: [{ type: "text" as const, text: output }] };
  } finally {
    await session.close();
  }
});
```

**Neo4j graph schema (relevant subset):**
- **Nodes:** `Function` (name, file_path, repo_url, signature, start_line, end_line, resolved_signature), `Class`, `File`, `Package`, `PackageExport`
- **Edges:** `CALLS` (call_site_line, arg_types, has_type_mismatch, type_mismatch_detail), `IMPORTS` (symbols, resolution_status), `DIRECTLY_IMPORTS` (import_kind, alias, resolved_type), `CONTAINS` (File→Symbol), `EXPORTS` (is_default)
- **Temporal:** All nodes/edges have valid_from_ts, valid_to_ts for time-travel queries
- **Indexes:** function_name on (name), file_path on (path), temporal indexes on (valid_from_ts, valid_to_ts)

**Existing CALLS edge usage (4 locations):**
1. `get_symbol` — finds callers of a symbol (1-hop reverse CALLS)
2. `get_dependencies` — outgoing/incoming CALLS for a file (1-hop)
3. `get_type_info` — callers with type mismatch info (1-hop)
4. `trace_error` — links stack frames to callers (1-hop reverse CALLS)

**No multi-hop CALLS traversal exists.** All existing tools do 1-hop CALLS lookups. `trace_imports` does multi-hop but only on IMPORTS edges.

**APOC is NOT used anywhere in the codebase.** The PRD references `apoc.path.expandConfig` — this must be replaced with pure Cypher variable-length path patterns, matching the existing `trace_imports` approach.

**`trace_imports` pattern (closest analog):**
```cypher
MATCH path = (start:File {path: $startPath})<-[:IMPORTS*1..${depth}]->(target)
WHERE ALL(rel IN relationships(path) WHERE temporalFilter(rel))
RETURN [n IN nodes(path) | ...] AS chain
LIMIT 50
```

## Components Identified

### 1. Start Node Resolver
- **Responsibility**: Resolve `start` parameter to a specific Function/Class node, handling disambiguation when multiple matches exist.
- **Upstream (receives from)**: Tool parameters (start, file, repo)
- **Downstream (sends to)**: Upstream/Downstream traversal queries
- **External dependencies**: Neo4j session, function_name index
- **Hands test**: PASS — straightforward MATCH query. Disambiguation error format is well-defined.

### 2. Upstream Traversal (Callers)
- **Responsibility**: Walk CALLS edges in reverse from start node to find all callers, up to max_depth. Annotate each hop with file context via CONTAINS edges.
- **Upstream (receives from)**: Resolved start node
- **Downstream (sends to)**: Response tree assembler
- **External dependencies**: Neo4j session, CALLS and CONTAINS relationships
- **Hands test**: PASS — variable-length reverse CALLS path, similar to trace_imports pattern. Key question: **cycle handling**. Neo4j variable-length paths with a single relationship type don't revisit nodes by default, but we should verify behavior with recursive functions.

### 3. Downstream Traversal (Callees) with Cross-Module Resolution
- **Responsibility**: Walk CALLS edges forward from start node, following cross-module jumps via IMPORTS/DIRECTLY_IMPORTS when a callee is in a different file.
- **Upstream (receives from)**: Resolved start node
- **Downstream (sends to)**: Response tree assembler
- **External dependencies**: Neo4j session, CALLS + IMPORTS + DIRECTLY_IMPORTS + CONTAINS relationships
- **Hands test**: PARTIAL PASS — This is the hardest component. Pure Cypher variable-length paths work on a single relationship type. **Mixing CALLS and IMPORTS in the same traversal is non-trivial without APOC.** Two approaches:
  1. **Multi-hop CALLS only, then resolve modules in application code** — walk `[:CALLS*1..N]` in Cypher, return all nodes with their file_path, then in TypeScript determine which hops crossed module boundaries and annotate accordingly.
  2. **Iterative depth-first traversal** — execute 1-hop CALLS queries iteratively in TypeScript, resolving imports at each boundary. More round trips to Neo4j but full control.

  **Recommendation:** Approach 1. CALLS edges already point to the correct target Function node regardless of which file it's in — the graph linker resolved this during ingestion. Cross-module jumps are a property we can detect by comparing `file_path` between caller and callee, not something we need to "resolve" at query time. The IMPORTS/DIRECTLY_IMPORTS edges are evidence of the connection but the CALLS edge itself already bridges the gap.

### 4. Response Tree Assembler
- **Responsibility**: Transform flat Cypher path results into a structured ChainNode tree. Deduplicate shared nodes, detect entry points/leaves, compute stats.
- **Upstream (receives from)**: Raw path results from upstream/downstream traversals
- **Downstream (sends to)**: MCP tool response (formatted text)
- **External dependencies**: None (pure TypeScript logic)
- **Hands test**: PASS — no external dependencies, just data transformation. Need to handle DAGs (a function called from multiple callers) correctly — this produces a tree with shared subtrees, not a pure tree.

### 5. Scope and Depth Filter
- **Responsibility**: Apply max_depth limit in Cypher and scope (path prefix) filtering. Track truncation and scope exits.
- **Upstream (receives from)**: Tool parameters
- **Downstream (sends to)**: Cypher query construction, stats computation
- **External dependencies**: None
- **Hands test**: PASS — max_depth maps directly to Cypher `*1..N`. Scope is a WHERE clause on file_path.

### 6. Temporal Filter (at_commit)
- **Responsibility**: Add temporal predicates when at_commit is provided.
- **Upstream (receives from)**: Tool parameters, commit SHA → timestamp resolution
- **Downstream (sends to)**: Cypher query WHERE clauses
- **External dependencies**: Commit node lookup (SHA → timestamp), existing temporalFilter() helper
- **Hands test**: PASS — existing pattern is well-established. Commit resolution already done in temporal-tools.ts.

### 7. Tool Registration and Response Formatting
- **Responsibility**: Register the tool with zod schema, format the tree as human-readable text output.
- **Upstream (receives from)**: Assembled ChainNode tree + stats
- **Downstream (sends to)**: Claude Code (via MCP protocol)
- **External dependencies**: MCP server instance, zod
- **Hands test**: PASS — follows exact pattern of all 20 existing tools.

## Rough Dependency Map

```
Tool Parameters
    │
    ├─► Start Node Resolver ──► [error: disambiguation response]
    │         │
    │         ▼
    │   ┌─────┴──────┐
    │   │             │
    │   ▼             ▼
    │  Upstream    Downstream
    │  Traversal  Traversal
    │   │             │
    │   └──────┬──────┘
    │          │
    │          ▼
    ├─► Response Tree Assembler
    │          │
    ├─► Scope/Depth Filter (applied in Cypher + stats)
    │          │
    ├─► Temporal Filter (applied in Cypher WHERE clauses)
    │          │
    │          ▼
    └─► Tool Registration + Response Formatting
               │
               ▼
          Claude Code
```

## Open Questions

1. **APOC dependency**: The PRD specifies APOC for mixed-relationship traversal. Since APOC isn't available, we need pure Cypher. **Proposed answer:** CALLS edges already target the correct Function node across files — no need to follow IMPORTS edges during traversal. Cross-module detection is just comparing file_path between caller and callee. Verify this assumption against the actual graph data.

2. **Cycle handling**: Recursive/mutually recursive functions create cycles in the CALLS graph. Neo4j's variable-length path matching (`*1..N`) uses `RELATIONSHIP_GLOBAL` uniqueness by default (won't traverse the same relationship twice), which prevents infinite loops but may miss valid paths. Need to verify this produces correct results for recursive call chains.

3. **DAG vs Tree**: The call graph is a DAG, not a tree. A utility function called from 10 places will appear in 10 upstream paths. The PRD says "tree" but the response needs to handle shared nodes. Options: (a) full tree with duplicated subtrees, (b) tree with back-references to already-visited nodes, (c) forest with dedup. Recommend (a) for simplicity, capped by the 500-node limit.

4. **Dynamic call sites**: The PRD mentions CALLS edges with null targets. Need to verify: do null-target CALLS edges actually exist in the graph, or is this theoretical? If they exist, what does the edge look like — is there a target node or is it truly dangling?

5. **include_external**: When following CALLS to a PackageExport node — do CALLS edges ever point directly to PackageExport nodes, or do they terminate at wrapper functions? Need to check the graph data.

## Risks and Concerns

1. **Performance on high fan-in functions**: A utility function called from 100+ places will produce enormous upstream trees. The 500-node cap and scope filter mitigate this, but we need to ensure the Cypher query itself doesn't blow up before the cap is applied. Use `LIMIT` in the query.

2. **No APOC means limited traversal control**: Without `apoc.path.expandConfig`, we lose fine-grained uniqueness control and relationship filtering during traversal. Pure Cypher `*1..N` is less flexible. Mitigation: since we only traverse CALLS edges (not mixed types), this is actually fine — single-relationship-type variable-length paths are well-optimized in Neo4j.

3. **Response size**: A bidirectional traversal with depth 10 could produce very large responses. Need aggressive defaults and clear truncation signaling.

4. **File placement**: `index.ts` is already 47KB. Adding another complex tool will make it larger. Consider whether this tool should go in a new file (e.g., `call-chain-tools.ts`) or stay in index.ts. Recommend new file to match the pattern of `runtime-tools.ts` and `temporal-tools.ts`.
