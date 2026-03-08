# Build Plan: `trace_call_chain` MCP Tool
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/trace-call-chain-brainstorm-2026-03-07.md
**PRD:** Feature Add/repograph-trace-call-chain-prd.md
**Status:** Draft

## Overview

Add a `trace_call_chain` MCP tool to the RepoGraph MCP server that walks `CALLS` edges (with cross-module boundary detection via `CONTAINS` edges) in a single Neo4j traversal, returning the full upstream/downstream execution chain as a structured tree. The tool lives in a new file `packages/mcp-server/src/call-chain-tools.ts` and is registered alongside runtime and temporal tools.

## Component Inventory

| Component | Inputs | Outputs | Dependencies |
|---|---|---|---|
| **Tool Registration** | MCP server instance | Registered `trace_call_chain` tool | zod, McpServer |
| **Start Node Resolver** | start, file, repo params | Resolved Function/Class node (or disambiguation error) | Neo4j session, function_name index |
| **Upstream Traversal** | Start node, max_depth, scope, commitTs | Raw path records (caller chains) | Neo4j session, CALLS relationships |
| **Downstream Traversal** | Start node, max_depth, scope, commitTs | Raw path records (callee chains) | Neo4j session, CALLS relationships |
| **Cross-Module Detector** | Raw path nodes with file_path | Annotated nodes with cross_module flag | CONTAINS edge data (embedded in node file_path) |
| **Tree Assembler** | Raw upstream + downstream paths | ChainNode tree + stats | Pure TypeScript logic |
| **Response Formatter** | ChainNode tree + stats | Human-readable markdown text | None |
| **Temporal Filter** | at_commit param | Cypher WHERE clause fragments | resolveCommitTs (from index.ts), Commit nodes |

## Integration Contracts

### Contract 1: index.ts → call-chain-tools.ts (registration)
```
Source: packages/mcp-server/src/index.ts (line ~1209)
Target: packages/mcp-server/src/call-chain-tools.ts

What flows:    Function call: registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO)
How it flows:  Direct function import and invocation at module load
Auth/Config:   None — same as registerRuntimeTools / registerTemporalTools
Error path:    If registration throws, server startup fails (same as existing tools)
```

**Wiring required:**
1. Add `import { registerCallChainTools } from "./call-chain-tools.js"` to index.ts
2. Add `registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO)` after temporal tools registration
3. Export `temporalFilter` and `resolveCommitTs` from index.ts (currently unexported) — OR duplicate them in the new file (matching the pattern of temporal-tools.ts which inlines its own temporal logic)

**Decision:** Duplicate `temporalFilter` in call-chain-tools.ts. Matches existing pattern, avoids refactoring index.ts exports. `resolveCommitTs` will also be duplicated (it's 8 lines).

### Contract 2: Neo4j → Start Node Resolution
```
Source: Tool parameters (start, file, repo)
Target: Neo4j Function/Class nodes

Query:
  MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo
  WITH r.url AS repoUrl
  MATCH (sym) WHERE (sym:Function OR sym:Class) AND sym.name = $name AND sym.repo_url = repoUrl
  [AND sym.file_path = $file]  // if file param provided
  AND sym.valid_to IS NULL     // current state (or temporal filter)
  OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)
  RETURN sym.name, sym.file_path, sym.start_line, sym.end_line, sym.signature, labels(sym)[0] AS kind

Disambiguation: If >1 result and no `file` param, return error with candidate list.
```

### Contract 3: Neo4j → Upstream Traversal
```
Source: Resolved start node (name + file_path + repo_url)
Target: Neo4j CALLS paths

Query:
  MATCH (start) WHERE (start:Function OR start:Class)
    AND start.name = $name AND start.file_path = $filePath AND start.repo_url = $repoUrl
    AND <temporalFilter(start)>
  MATCH path = (start)<-[r:CALLS*1..$maxDepth]-(caller)
  WHERE ALL(rel IN relationships(path) WHERE <temporalFilter(rel)>)
    AND ALL(n IN nodes(path) WHERE <temporalFilter(n)>)
    [AND ALL(n IN nodes(path) WHERE n.file_path STARTS WITH $scope)]  // if scope set
  WITH path, nodes(path) AS ns, relationships(path) AS rs
  UNWIND range(0, size(ns)-1) AS i
  RETURN
    [n IN ns | {name: n.name, file_path: n.file_path, start_line: n.start_line,
                end_line: n.end_line, kind: labels(n)[0]}] AS chain,
    [r IN rs | {call_site_line: r.call_site_line}] AS edges
  LIMIT 200

Returns: Array of paths, each as an ordered list of nodes + edges.
```

### Contract 4: Neo4j → Downstream Traversal
```
Source: Resolved start node
Target: Neo4j CALLS paths

Query: Same pattern as upstream but with forward direction:
  MATCH path = (start)-[r:CALLS*1..$maxDepth]->(callee)
  ...same filters...

Returns: Array of paths, each as an ordered list of nodes + edges.
```

### Contract 5: Tree Assembler → Response Formatter
```
Source: ChainNode tree (TypeScript object)
Target: Formatted markdown string

Format (matching PRD example):
  start: processPayment (src/api/payments.ts:128)

  downstream:
    processPayment
    ├─[CALLS:142]─ validateOrder (src/models/order.ts:55)
    │              ├─[CALLS:62]─ checkInventory (src/db/inventory.ts:18)   [leaf]
    │              └─[CALLS:70]─ applyDiscounts (src/lib/pricing.ts:34)    [leaf]
    ...

  stats: { total_nodes: 9, max_depth_reached: 3, ... }
```

## End-to-End Flows

### Flow 1: Simple downstream trace (happy path)
```
1. Claude calls trace_call_chain(start="processPayment", repo="myrepo", direction="downstream")
2. Tool resolves repo → repoUrl via Repository node
3. Tool resolves start → Function node (name="processPayment", repo_url=repoUrl)
4. Single match found → proceed
5. Downstream Cypher query: MATCH path = (start)-[:CALLS*1..10]->(callee)
6. Neo4j returns N paths
7. Tree assembler merges paths into tree, detects cross-module jumps (file_path changes), marks leaves
8. Response formatter renders tree as markdown
9. Return { content: [{ type: "text", text: formatted }] }
```

### Flow 2: Disambiguation required
```
1. Claude calls trace_call_chain(start="formatDate", repo="myrepo")
2. Start node resolver finds 3 Function nodes named "formatDate"
3. Return error: { error: "ambiguous_start", candidates: [...] }
4. Claude re-invokes with file="src/utils/date.ts"
5. → proceeds as Flow 1
```

### Flow 3: Bidirectional with scope
```
1. Claude calls trace_call_chain(start="validate", repo="myrepo", direction="both", scope="src/api/")
2. Start node resolved
3. Upstream query runs: callers within src/api/ returned, out-of-scope callers noted as scope_exits
4. Downstream query runs: callees within src/api/ returned, out-of-scope callees noted
5. Both trees assembled and merged into response
6. Stats include scope_exits count
```

### Flow 4: at_commit temporal query
```
1. Claude calls trace_call_chain(start="processPayment", repo="myrepo", at_commit="abc1234")
2. resolveCommitTs("abc1234") → timestamp
3. All Cypher queries use temporal filter with commitTs
4. Tree shows call chain as it existed at that commit
```

### Error Flows
```
E1. No repo found → "Error: repository 'X' not found"
E2. No matching function → "Error: no function named 'X' found in repo 'Y'"
E3. No CALLS edges from start → return tree with start node only, is_leaf/is_entry_point=true, total_nodes=1
E4. max_depth hit → truncated=true in stats, deepest nodes still included
E5. at_commit SHA not found → "Error: commit 'X' not found in repo 'Y'"
```

## Issues Found

### Issue 1: `temporalFilter` and `resolveCommitTs` are not exported from index.ts
**Severity:** Low
**Fix:** Duplicate in call-chain-tools.ts (matches temporal-tools.ts pattern of inlining temporal logic)

### Issue 2: No APOC — PRD's traversal strategy won't work
**Severity:** High (design change)
**Fix:** Use pure Cypher `[:CALLS*1..N]` variable-length paths. This works because CALLS edges already point to the correct target Function node regardless of file. Cross-module detection is done in application code by comparing file_path between consecutive nodes. No need to mix CALLS + IMPORTS in the same traversal.

### Issue 3: Cycle handling with variable-length paths
**Severity:** Medium
**Fix:** Neo4j's default variable-length path matching uses RELATIONSHIP_GLOBAL uniqueness — it won't traverse the same edge twice but can visit a node multiple times via different edges. For recursive functions (A→A), the self-referencing CALLS edge is traversed once. For mutual recursion (A→B→A), both CALLS edges are traversed once each, which is correct. Add documentation in stats: if a path contains the same node twice, flag it.

### Issue 4: Dynamic call sites (null targets)
**Severity:** Low
**Fix:** CALLS edges in the graph always have both source and target nodes (MERGE requires both). A "dynamic" call is one where the parser couldn't resolve the callee name, so no CALLS edge was created at all. These calls are invisible to graph traversal — they're not broken edges but absent edges. The `dynamic_call_sites` counter from the PRD would require additional data (e.g., a `has_unresolved_calls` property on Function nodes). **For v1, omit dynamic_call_sites from stats** — it requires ingestion changes. Document this as a future enhancement.

### Issue 5: include_external (PackageExport nodes)
**Severity:** Low
**Fix:** CALLS edges may point to Function nodes that were extracted from external packages. These will have file_path values like `node_modules/...` or be linked to PackageExport nodes via PROVIDES. For v1: if a callee has no incoming CONTAINS edge from a repo file, or its file_path starts with `node_modules`, mark it as external. The `include_external` flag controls whether these nodes appear in the tree or are filtered out.

### Issue 6: Response size for high fan-in functions
**Severity:** Medium
**Fix:** Apply LIMIT in the Cypher query (200 paths) and a node cap (500) in the tree assembler. Set `truncated: true` when either cap is hit.

## Wiring Checklist

### Infrastructure (no new infra needed)
- [ ] No new Neo4j indexes required — CALLS edges use existing function_name index for lookups
- [ ] No new Supabase tables
- [ ] No new environment variables

### New File: `packages/mcp-server/src/call-chain-tools.ts`
- [ ] Create file with `registerCallChainTools` export function
- [ ] Duplicate `temporalFilter` helper (8 lines)
- [ ] Duplicate `resolveCommitTs` helper (12 lines)
- [ ] Implement start node resolution query
- [ ] Implement disambiguation error response
- [ ] Implement upstream traversal query (reverse CALLS variable-length path)
- [ ] Implement downstream traversal query (forward CALLS variable-length path)
- [ ] Implement scope filtering (WHERE clause on file_path prefix)
- [ ] Implement depth limiting (Cypher *1..N parameter)
- [ ] Implement temporal filtering (at_commit → commitTs → WHERE clauses)
- [ ] Implement cross-module detection (compare file_path between consecutive nodes)
- [ ] Implement tree assembler (merge paths into ChainNode tree)
- [ ] Implement entry point detection (no incoming CALLS in upstream tree)
- [ ] Implement leaf detection (no outgoing CALLS in downstream tree)
- [ ] Implement external node detection (PackageExport / node_modules paths)
- [ ] Implement stats computation (total_nodes, max_depth_reached, cross_module_jumps, scope_exits, truncated)
- [ ] Implement response formatter (ASCII tree with file paths, line numbers, edge annotations)
- [ ] Register tool with zod schema matching PRD parameters
- [ ] Apply LIMIT 200 to Cypher queries and 500-node cap in tree assembler

### Wiring: index.ts Registration
- [ ] Add `import { registerCallChainTools } from "./call-chain-tools.js"` to index.ts line 10
- [ ] Add `registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO)` after line 1209

### TypeScript Build
- [ ] Verify the new file compiles with existing tsconfig.json
- [ ] No new dependencies needed (uses same neo4j-driver, zod, @supabase/supabase-js)

## Build Order

### Phase 1: Core Query Layer
Create the new file with the registration function, start node resolver, and both traversal queries. Get raw Cypher results working.

**Checklist items:** Create file, registerCallChainTools, temporalFilter, resolveCommitTs, start node resolution, disambiguation, upstream traversal query, downstream traversal query, depth limiting, scope filtering, temporal filtering.

**Verify:** Tool is registered, start node resolution returns correct results, raw Cypher paths are returned for known functions.

### Phase 2: Tree Assembly and Formatting
Transform raw paths into the structured ChainNode tree. Add cross-module detection, entry point/leaf detection, external node detection, stats. Format as readable output.

**Checklist items:** Cross-module detection, tree assembler, entry point detection, leaf detection, external node detection, stats computation, response formatter, node cap (500), query LIMIT (200).

**Verify:** Full end-to-end call: `trace_call_chain(start="someFunction", repo="RepoGraph")` returns correctly formatted tree output.

### Phase 3: Wiring and Integration
Wire into index.ts, verify TypeScript builds, test the complete tool.

**Checklist items:** Import in index.ts, registration call in index.ts, TypeScript build verification.

**Verify:** `npm run build` in packages/mcp-server succeeds. Tool appears in MCP tool list.
