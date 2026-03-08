# RepoGraph — Feature Add-On PRD: `trace_call_chain` MCP Tool

**Add-On To:** RepoGraph v1.0 PRD  
**Version:** 1.0  
**Date:** March 7, 2026  
**Status:** Draft  
**Phase:** 2 Extension (ships alongside or immediately after Phase 2)

---

## 1. Overview

`trace_call_chain` is a new MCP tool that walks `CALLS` and `IMPORTS` edges together in a single graph traversal — starting from any function, file, or symbol — and returns the full execution stack in one call. It answers the question: "given that this function runs, what is the complete chain of things that call it and what does it call, all the way down to the leaves?"

This is the one capability that no combination of grep, file reading, or existing RepoGraph tools can replicate without multiple round trips. `get_symbol` tells Claude where a function is defined. `get_dependencies` tells Claude what a file imports. `trace_imports` walks import edges. But none of them walk `CALLS` edges — the edges that represent actual execution flow — and none of them fuse call relationships with import resolution in a single traversal. `trace_call_chain` does both.

The result is a tool that transforms how Claude Code debugs and reasons about code. Instead of assembling an execution picture one lookup at a time, Claude can request the full call chain for any entry point and immediately understand the complete execution path: what calls this, what this calls, what those callees import, and where the chain terminates.

---

## 2. Problem Statement

The Phase 2 structural graph gives Claude Code a rich map of the codebase — file nodes, symbol nodes, `IMPORTS` edges, `EXPORTS` edges, `CALLS` edges, `CONTAINS` edges. The MCP tools expose this map through focused queries. But every existing tool operates on one edge type at a time. There is no way to ask the graph a question that spans both the call graph (`CALLS`) and the import graph (`IMPORTS`) in a single tool invocation.

This creates three pain points that compound each other:

**Multi-hop call chains require serial round trips.** To understand the execution path of a function, Claude must: call `get_symbol` to find the function, call `get_dependencies` to find its imports, call `get_symbol` again for each callee, repeat. Each round trip is a separate MCP tool call. For a chain 5 hops deep with 3 callees per hop, this is 15–40+ tool calls to assemble what a single graph traversal could return. Claude's context fills with lookup boilerplate rather than the actual analysis.

**`CALLS` edges are stranded.** The `CALLS` edge — the most semantically rich relationship in the graph, representing actual runtime invocation — has no dedicated traversal tool. It is only accessible through the `query_graph` escape hatch, which requires Claude to write Cypher. `query_graph` is a fallback, not a workflow. A relationship type this important deserves a first-class tool.

**Import resolution and call resolution are always needed together.** When Claude traces a call chain, it inevitably hits a function that lives in an imported module. At that point it needs to resolve the import — which file contains the callee? — before it can continue the call traversal. Without `trace_call_chain`, this jump between call traversal and import traversal is a manual seam. Claude has to stop, resolve the import, then resume the call walk. This is exactly the kind of context-assembly work that RepoGraph exists to eliminate.

The downstream consequence: debugging a production error that involves a 4-function call stack across 3 files currently requires 10–20 MCP tool calls and leaves Claude with a fragmented picture it has to mentally assemble. `trace_call_chain` reduces this to 1 call and returns a complete, structured chain.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Traverse `CALLS` and `IMPORTS` edges together in a single Neo4j query chain, returning the full execution stack from a given entry point.
2. Support both directions: upstream (what calls this function, all the way to the entry points) and downstream (what this function calls, all the way to the leaves).
3. Support bidirectional traversal in a single call: full upstream callers AND full downstream callees in one response.
4. Cross module boundaries automatically — when a `CALLS` edge points to a function in an imported module, follow the `IMPORTS` edge to resolve it and continue traversal without requiring a second tool call.
5. Return structured output: a tree (not just a flat list) with each node annotated by file path, line number, symbol kind, and the edge type that connected it to its parent.
6. Respect the name resolution improvements from the Name Resolution add-on: if `DIRECTLY_IMPORTS` edges are present, prefer them over generic `IMPORTS` edges for cross-module jumps.
7. Expose configurable depth limits and scope filters (limit traversal to a specific directory or package).
8. Return the result in a format Claude can immediately reason about — no post-processing required.

### 3.2 Non-Goals

- Dynamic call resolution. If a function calls through a variable (`fn()` where `fn` is a parameter), this cannot be statically resolved and will be flagged as a dynamic call site, not traversed.
- Runtime call frequency or profiling data. Call chains here are structural (static analysis), not runtime. For runtime call behavior, the Runtime Context Layer and `trace_error` are the right tools.
- Full program slicing or data flow analysis. This is a graph traversal, not a type-aware semantic analysis. That belongs to the Type Flow feature.
- Cross-repository traversal. Call chains terminate at the boundary of the indexed repo. Calls into `node_modules` resolve to `PackageExport` nodes and stop there.
- Visualization in the web UI. The consumer is Claude Code via MCP.

---

## 4. How `trace_call_chain` Fits the Existing Architecture

No new infrastructure is required. `trace_call_chain` is a new MCP tool that executes multi-hop Cypher queries against the existing Neo4j graph. It depends entirely on data already created by Phase 2 and the Name Resolution add-on.

The tool sits entirely within the MCP server layer:

```
Neo4j Graph (Phase 2 + Name Resolution)
        ↓
  MCP Server (TypeScript)
        ↓
  trace_call_chain tool   ← new
        ↓
  Claude Code
```

It requires no changes to the ingestion pipeline, no new graph schema elements, and no new storage. It is purely a query-time capability.

---

## 5. Technical Specification

### 5.1 Tool Interface

**Tool name:** `trace_call_chain`

**Description:** Walk `CALLS` and `IMPORTS` edges together from a starting function or symbol, returning the full execution chain — callers, callees, and cross-module jumps — in a single structured response. This is the primary tool for understanding how a function fits into the full execution flow of the codebase.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `start` | string | Yes | The name of the starting function or symbol. |
| `repo` | string | Yes | The repository to search within. |
| `file` | string | No | Narrow the starting symbol lookup to a specific file path. Disambiguates when multiple functions share a name. |
| `direction` | enum: `upstream` \| `downstream` \| `both` | No (default: `both`) | `upstream` = walk callers toward entry points. `downstream` = walk callees toward leaves. `both` = full bidirectional chain. |
| `max_depth` | int | No (default: 10) | Maximum number of hops in any direction. Prevents runaway traversal on deeply recursive codebases. |
| `scope` | string | No | Restrict traversal to files within a given path prefix (e.g., `src/api/`). Calls that leave this scope are noted but not followed. |
| `include_external` | bool | No (default: false) | Whether to include calls into `PackageExport` nodes (upstream npm/pip dependencies). Adds depth context but increases response size. |
| `at_commit` | string | No | Query the chain as it existed at a given commit SHA or date. Requires the Temporal Graph add-on. |

**Return shape:**

```typescript
{
  start: {
    name: string,
    kind: "function" | "class" | "method",
    file: string,
    start_line: number,
    end_line: number,
    signature: string
  },
  upstream: ChainNode | null,   // callers tree, null if direction is "downstream"
  downstream: ChainNode | null, // callees tree, null if direction is "upstream"
  stats: {
    total_nodes: number,
    max_depth_reached: number,
    dynamic_call_sites: number,   // CALLS edges that could not be resolved
    cross_module_jumps: number,   // times traversal crossed a file boundary via IMPORTS
    scope_exits: number,          // calls that left the scope filter (not followed)
    truncated: boolean            // true if max_depth was hit before chain terminated
  }
}

type ChainNode = {
  name: string,
  kind: "function" | "class" | "method" | "package_export",
  file: string,
  start_line: number,
  edge_type: "CALLS" | "IMPORTS" | "DIRECTLY_IMPORTS",  // how we got here
  call_site_line: number | null,    // line number of the call expression (from CALLS edge)
  is_entry_point: boolean,          // true if this node has no further callers (upstream only)
  is_leaf: boolean,                 // true if this node has no further callees (downstream only)
  is_dynamic: boolean,              // true if this node was reached via an unresolvable dynamic call
  children: ChainNode[]
}
```

### 5.2 Query Strategy

The tool executes in three phases inside the MCP server:

**Phase 1: Start node resolution.**

Resolve the `start` parameter to a specific `Function` (or `Class`) node in the graph. If `file` is provided, constrain the lookup to that file. If multiple nodes match `name` (same function name in different files), return an error listing the candidates with their file paths and ask Claude to re-invoke with a `file` parameter to disambiguate.

```cypher
MATCH (fn:Function {name: $name})
WHERE fn.file_path STARTS WITH $scope   // if scope is set
RETURN fn
```

**Phase 2: Upstream traversal (callers).**

Walk `CALLS` edges in reverse — find all functions that call the start node, then find all functions that call those, up to `max_depth`. At each hop, resolve the caller's containing file via `CONTAINS` and `IMPORTS` edges to annotate the chain with cross-module boundary crossings.

```cypher
MATCH path = (start:Function {name: $name})<-[:CALLS*1..$max_depth]-(caller:Function)
WITH path, [n IN nodes(path) | {
  name: n.name,
  file: [(f:File)-[:CONTAINS]->(n) | f.path][0],
  start_line: n.start_line
}] AS chain
RETURN chain
```

**Phase 3: Downstream traversal (callees).**

Walk `CALLS` edges forward — find all functions the start node calls, and what those call, up to `max_depth`. When a `CALLS` edge points to a function not contained in the current file, follow `DIRECTLY_IMPORTS` (preferred) or `IMPORTS` edges to resolve the module and continue traversal from that function.

The cross-module resolution is the critical step that distinguishes this tool from a simple `CALLS` traversal:

```cypher
MATCH (start:Function {name: $name})
CALL apoc.path.expandConfig(start, {
  relationshipFilter: 'CALLS>|DIRECTLY_IMPORTS>|IMPORTS>',
  minLevel: 1,
  maxLevel: $max_depth,
  uniqueness: 'NODE_GLOBAL'
}) YIELD path
RETURN path
```

The MCP server processes the raw path results into the structured `ChainNode` tree, classifying each hop as a `CALLS` step, an `IMPORTS` step (cross-module resolution), or a boundary with a `PackageExport` node.

**Dynamic call site handling.** When a `Function` node has a `CALLS` edge with a null target (recorded during Parse when tree-sitter found a call expression but could not resolve the callee), the chain node is included with `is_dynamic: true` and no children. The `stats.dynamic_call_sites` counter is incremented. This is not an error — it is accurate information. Claude knows a call exists but cannot be statically resolved.

### 5.3 Cross-Module Resolution Logic

When downstream traversal reaches a `CALLS` edge whose target function is in a different file, the MCP server must resolve the module boundary before continuing:

1. Look for a `DIRECTLY_IMPORTS` edge from the current file to the target function node. If found (name resolution is active), this is the highest-confidence path — follow it directly.
2. If no `DIRECTLY_IMPORTS` edge exists, look for an `IMPORTS` edge from the current file to the file containing the target function. If found, the cross-module jump is recorded and traversal continues.
3. If neither edge exists, the target function is reachable via a call but has no import relationship in the graph. This indicates either a dynamic require, a missing file, or a gap in name resolution. Record as `is_dynamic: true` and do not traverse further.

### 5.4 Entry Point Detection

A function is an **entry point** (in the upstream direction) if it has no incoming `CALLS` edges within the repository. Entry points are typically: route handlers, event listeners, exported API functions, scheduled job runners, or test functions. The tool marks these with `is_entry_point: true` so Claude can immediately identify where execution originates.

Similarly, a function is a **leaf** (in the downstream direction) if it has no outgoing `CALLS` edges within the scope. Leaves are typically: utility functions, library wrappers, or external package calls.

### 5.5 Disambiguation Behavior

When `start` matches multiple nodes (same function name in different files), the tool does not guess. It returns an error of the form:

```json
{
  "error": "ambiguous_start",
  "message": "Found 3 functions named 'formatDate'. Specify 'file' to disambiguate.",
  "candidates": [
    { "name": "formatDate", "file": "src/utils/date.ts", "start_line": 14 },
    { "name": "formatDate", "file": "src/components/Invoice/utils.ts", "start_line": 8 },
    { "name": "formatDate", "file": "src/lib/format.ts", "start_line": 31 }
  ]
}
```

Claude re-invokes with the `file` parameter. This is a single extra round trip and better than silently returning the wrong chain.

### 5.6 Depth and Scope Limits

**`max_depth`:** Applied independently to upstream and downstream traversal. A `max_depth` of 10 means the chain extends at most 10 hops in each direction from the start node. When the limit is reached, the deepest nodes are still included in the response with `is_leaf: true` (or `is_entry_point: true`) and `stats.truncated: true` to signal the chain continues beyond what was returned.

**`scope`:** A path prefix string. Any `CALLS` edge that would traverse to a function in a file outside the prefix is recorded as a scope exit (`stats.scope_exits` incremented) but not followed. The out-of-scope function name and file are still included in the response as a `ChainNode` with `is_leaf: true` (downstream) or `is_entry_point: true` (upstream), so Claude knows the chain continues outside the scope but has clear signal not to reason about it without widening the scope.

---

## 6. Impact on Existing MCP Tools

`trace_call_chain` does not replace any existing tool. It composes with them to make existing workflows dramatically faster.

**`get_symbol`** — remains the right tool when Claude needs the definition and signature of a single function without execution context. `trace_call_chain` is the right tool when Claude needs the function in context of how it is used and what it uses.

**`get_dependencies`** — remains the right tool for file-level import analysis. `trace_call_chain` operates at the function level and crosses module boundaries as a side effect of following call edges, not as its primary purpose. The two tools answer different questions and are often used together: `get_dependencies` to understand module coupling, `trace_call_chain` to understand execution flow.

**`trace_imports`** — remains the right tool for walking import chains without regard to call relationships. `trace_call_chain` uses import edges as connective tissue between call hops, not as its primary traversal target. For pure "what does this module depend on" questions, `trace_imports` is more appropriate. For "how does execution flow through this module" questions, `trace_call_chain` is more appropriate.

**`query_graph`** — previously the only way to traverse `CALLS` edges. After `trace_call_chain` ships, the `query_graph` escape hatch is no longer needed for call graph analysis. It remains useful for novel ad-hoc queries that don't fit any first-class tool.

**`trace_error`** — the most natural pairing. The `trace_error` tool identifies the function involved in a production error and retrieves its code and imports. `trace_call_chain` then takes that function as a starting point and returns the full upstream call chain — identifying all the callers that could have triggered the execution path that led to the error. Together, they cover the full debugging loop: runtime → code → execution context.

---

## 7. Example Outputs

### 7.1 Downstream Chain: `processPayment`

```
trace_call_chain(start="processPayment", repo="qwikr", direction="downstream", max_depth=5)

start: processPayment (src/api/payments.ts:128)

downstream:
  processPayment
  ├─[CALLS:142]─ validateOrder (src/models/order.ts:55)
  │              ├─[CALLS:62]─ checkInventory (src/db/inventory.ts:18)   [leaf]
  │              └─[CALLS:70]─ applyDiscounts (src/lib/pricing.ts:34)    [leaf]
  ├─[CALLS:158]─ chargeCard (src/services/stripe.ts:22)
  │              └─[CALLS:30]─ stripe.charges.create (node_modules/stripe) [external leaf]
  └─[CALLS:163]─ sendReceipt (src/notifications/email.ts:88)
                 └─[CALLS:95]─ renderTemplate (src/lib/templates.ts:14)  [leaf]

stats: { total_nodes: 9, max_depth_reached: 3, dynamic_call_sites: 0,
         cross_module_jumps: 5, scope_exits: 0, truncated: false }
```

### 7.2 Upstream Chain: `checkInventory`

```
trace_call_chain(start="checkInventory", repo="qwikr", direction="upstream")

start: checkInventory (src/db/inventory.ts:18)

upstream:
  checkInventory
  └─[CALLS:62]─ validateOrder (src/models/order.ts:55)
                ├─[CALLS:142]─ processPayment (src/api/payments.ts:128)
                │              └─[CALLS:?]─ handleCheckout (src/api/routes.ts:44)  [entry point]
                └─[CALLS:88]─ previewOrder (src/api/orders.ts:71)
                               └─[CALLS:?]─ handleOrderPreview (src/api/routes.ts:102)  [entry point]

stats: { total_nodes: 6, max_depth_reached: 3, dynamic_call_sites: 0,
         cross_module_jumps: 3, scope_exits: 0, truncated: false }
```

Claude can immediately read this and understand: `checkInventory` is called from `validateOrder`, which is called from two different route handlers — `handleCheckout` and `handleOrderPreview`. Any bug in `checkInventory` affects both routes.

---

## 8. Composite Workflow: Full Debug Loop

The intended primary workflow, combining `trace_error` with `trace_call_chain`:

**Step 1:** `get_deploy_errors(source="vercel", last_n_deploys=1)`
→ Returns: `TypeError: Cannot read property 'amount' of undefined at processPayment (src/api/payments.ts:142)`

**Step 2:** `trace_error(stack_trace="...", repo="qwikr")`
→ Returns: the `processPayment` function source, its imports, and immediate callers.

**Step 3:** `trace_call_chain(start="processPayment", file="src/api/payments.ts", repo="qwikr", direction="both")`
→ Returns: the full call chain in both directions — every possible path that could trigger `processPayment`, and every function that `processPayment` invokes before the crash.

**Step 4:** Claude identifies that `processPayment` is called from `handleCheckout`, which receives an `order` object from `parseRequestBody`. The `amount` property is missing because `parseRequestBody` does not validate the request schema before passing it downstream. The fix is in `src/api/routes.ts`, not in `payments.ts`. Claude surfaces this conclusion without the developer having read a single file or run a single grep.

Previously: 10–20 MCP tool calls, significant manual assembly of context. After `trace_call_chain`: 3 tool calls, conclusion available in one response.

---

## 9. Implementation Plan

`trace_call_chain` is a Phase 2 extension — it ships immediately after or alongside the Phase 2 structural graph. It has no dependencies beyond Phase 2 graph data and is improved (but not blocked) by name resolution.

### 9.1 Subtasks

**1. Cypher query development** (~3 hours with Claude Code)

Write and test the three core Cypher queries: start node resolution, upstream traversal, downstream traversal with cross-module resolution. Test against the Phase 2 graph with known call chains. Edge cases: recursive functions (cycles), functions with no callers, functions with no callees, dynamic call sites with null targets.

**2. Cross-module resolution logic** (~2 hours with Claude Code)

Implement the MCP server logic that detects when a `CALLS` hop crosses a module boundary and resolves the import edge. Prefer `DIRECTLY_IMPORTS` when available. Handle the three resolution outcomes: direct edge found, file-level IMPORTS found, unresolvable (flag as dynamic).

**3. Response tree assembly** (~2 hours with Claude Code)

Transform raw Cypher path results into the structured `ChainNode` tree. Deduplicate nodes that appear in multiple paths (a function called from multiple callers appears once in the tree, with multiple parents). Annotate entry points and leaves. Compute stats.

**4. Disambiguation handler** (~1 hour with Claude Code)

Implement the multi-match detection and structured error response. Test with same-named functions across files.

**5. Scope and depth filtering** (~1 hour with Claude Code)

Apply `max_depth` counter during traversal. Detect scope exits and record them without following. Ensure `truncated` flag is set correctly.

**6. `at_commit` parameter** (~2 hours, only if Temporal Graph add-on is active)

Add temporal filtering to all three Cypher queries when `at_commit` is provided. Filter nodes and edges by `valid_from_ts` and `valid_to_ts`. This subtask is conditional on the Temporal Graph add-on shipping first.

**7. Validation against real repo** (~4–6 hours, developer-led)

Run `trace_call_chain` against the target codebase. Spot-check 10+ known call chains manually. Verify cross-module jumps match expected behavior. Check performance on a deeply nested chain (5+ hops, 3+ callees per hop). Fix edge cases.

### 9.2 Total Estimated Effort

| Subtask | Implementation | Validation |
|---|---|---|
| Cypher query development | 3 hours | 2 hours |
| Cross-module resolution | 2 hours | 1 hour |
| Response tree assembly | 2 hours | 1 hour |
| Disambiguation handler | 1 hour | 30 minutes |
| Scope and depth filtering | 1 hour | 30 minutes |
| `at_commit` (conditional) | 2 hours | 1 hour |
| Real repo validation | — | 4–6 hours |
| **Total (without temporal)** | **~9 hours** | **~9 hours** |

Approximately **2–3 focused days** end-to-end. The majority of developer time is validation — the implementation is graph query logic with no new infrastructure.

---

## 10. Testing Strategy

### 10.1 Unit Tests

The tree assembly and cross-module resolution logic are unit-testable with mock graph data. Claude Code generates tests alongside implementation.

- **Start node resolution:** exact match, multiple matches (disambiguation error), no match.
- **Upstream traversal:** single caller, multiple callers, no callers (entry point), recursive function (cycle — verify it terminates).
- **Downstream traversal:** single callee, multiple callees, no callees (leaf), cross-module jump (callee in different file), call into external package (PackageExport node).
- **Scope filtering:** call within scope (followed), call leaving scope (recorded but not followed).
- **Depth limiting:** chain exactly at `max_depth` (no truncation), chain one hop beyond `max_depth` (truncated flag set).
- **Dynamic call sites:** `CALLS` edge with null target — flagged as dynamic, no children, counter incremented.

### 10.2 Integration Test Scenarios

Using the Phase 2 integration test repos plus two new fixtures:

**Fixture G — linear chain.** A → B → C → D → E, all in separate files, all connected by both `CALLS` and `IMPORTS` edges. Validates that downstream traversal returns the full 5-node chain with 4 cross-module jumps. Validates that upstream from E returns the full chain with correct entry point detection at A.

**Fixture H — branching chain.** A calls B and C. B calls D. C calls D and E. D calls F. Tests that the tree correctly represents shared callees (D appears as a child of both B and C) and that leaf detection works at F and E.

**Fixture I — cycle.** A calls B, B calls C, C calls A (recursive cycle). Validates that traversal terminates (does not loop), that the cycle is represented correctly (the return edge to A is recorded as a back-edge with a flag rather than causing infinite recursion), and that `stats.truncated` reflects cycle termination.

### 10.3 Acceptance Criteria

- Downstream `trace_call_chain` on `processPayment` in the target codebase returns the correct full chain in one call, matching the manually-assembled chain from multiple `get_symbol` calls.
- Upstream `trace_call_chain` on a known entry-path function correctly identifies all route handlers that can trigger it.
- Cross-module jumps are correctly resolved: the tool never returns a `CALLS` hop that terminates at a file boundary when an `IMPORTS` edge connects the files.
- Dynamic call sites are correctly flagged with `is_dynamic: true` and never followed.
- Response time for a 5-hop, 3-callee-per-hop chain is under 500ms (Neo4j indexed traversal).
- Recursive cycles do not cause the tool to hang or return a stack overflow error.
- All disambiguation cases return structured errors, never wrong results.

---

## 11. Performance Considerations

The dominant cost of `trace_call_chain` is the multi-hop Cypher traversal. In an unoptimized graph this could be slow on large codebases with high fan-out functions (utility functions called from hundreds of places). Mitigations:

- **Neo4j relationship indexes.** Ensure `CALLS` and `IMPORTS` relationships are indexed in Neo4j. Without these, hop-by-hop traversal degrades to full scans.
- **`max_depth` as a hard Neo4j limit.** Pass `max_depth` directly into the Cypher traversal depth limit (`[:CALLS*1..$max_depth]`) rather than filtering in application code. This prevents Neo4j from materializing paths beyond the limit.
- **`scope` as a predicate, not a filter.** Apply the scope path prefix as a `WHERE` clause inside the traversal rather than post-filtering. Stops traversal from expanding into out-of-scope subgraphs.
- **Deduplication in the query, not the application.** Use `DISTINCT` in Cypher to deduplicate paths that share nodes. The upstream traversal in particular can produce exponential path counts if not deduplicated at the query level.
- **Response size cap.** If `stats.total_nodes` exceeds a configurable limit (default: 500 nodes), truncate the response and set `truncated: true`. Return the deepest-first paths so the most relevant context is preserved. Log a warning.

**Performance targets:**

| Scenario | Target |
|---|---|
| Simple chain (5 hops, 1 callee per hop) | < 200ms |
| Moderate chain (5 hops, 3 callees per hop) | < 500ms |
| Large chain (8 hops, 5 callees per hop) | < 1.5 seconds |
| High fan-in function (100 direct callers, upstream only) | < 1 second |
| Response approaching 500-node cap | < 2 seconds |

---

## 12. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Highly connected utility functions generate enormous upstream chains | High | `scope` parameter to limit traversal. `max_depth` hard ceiling. 500-node response cap with `truncated` flag. Claude prompts user to narrow scope before retrying. |
| Recursive / mutually recursive functions cause infinite traversal | High | `NODE_GLOBAL` uniqueness in APOC path expansion prevents re-visiting nodes. Cycle is recorded as a back-edge annotation, not traversed again. |
| `CALLS` edge coverage is incomplete (tree-sitter missed some call expressions) | Medium | Flag in `stats.dynamic_call_sites`. Chain is accurate for what was parsed; gaps are surfaced, not silently dropped. Improve parser coverage in parallel. |
| Cross-module resolution fails without name resolution (Phase 2 only, no Name Resolution add-on) | Medium | Fall back to file-level `IMPORTS` edges when `DIRECTLY_IMPORTS` edges are absent. Chain is less precise but not broken. Degrade gracefully and note in `stats`. |
| Response JSON is too large for Claude's context | Low | 500-node cap. Response schema is compact (no full source code, only names, lines, and edges). Full source is fetched separately via `get_file` or `get_symbol` if Claude needs it. |
| Ambiguous start node is common (many utility functions share names) | Medium | Structured disambiguation error with candidates. Claude re-invokes with `file`. One extra round trip is a minor cost against returning the wrong chain. |

---

## 13. Success Criteria

`trace_call_chain` is complete when:

1. A developer can ask Claude Code "what calls `processPayment` and what does it call?" and receive a complete, correct, structured answer in a single MCP tool call.
2. The full debug loop — from `get_deploy_errors` to root cause identification — requires 3 or fewer MCP tool calls on a real production error in the target codebase.
3. Upstream traversal correctly identifies all entry points (route handlers, event listeners) for a given function, verified manually against the codebase.
4. Cross-module traversal never terminates at a file boundary when an import relationship connects the files — verified across 10+ spot checks on the target repo.
5. The tool handles recursive call cycles without hanging or erroring.
6. Claude Code uses `trace_call_chain` instead of `query_graph` for all call graph analysis tasks — `query_graph` is no longer needed as a workaround for call traversal.
7. A developer who was previously running 10–20 sequential MCP tool calls to assemble a call chain confirms that `trace_call_chain` returns equivalent or better context in a single call.
