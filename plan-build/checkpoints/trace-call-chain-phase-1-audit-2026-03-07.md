# Phase 1 Dependency Audit
**Phase:** Core Query Layer
**Date:** 2026-03-07
**Status:** ISSUES FOUND

## Verified Connections

- [x] **Create file with registerCallChainTools export function** -- File exists at `packages/mcp-server/src/call-chain-tools.ts`. Function signature `registerCallChainTools(server, getSession, _getSupabase, scopedRepo)` matches the existing pattern in `runtime-tools.ts` and `temporal-tools.ts` exactly: `(server: McpServer, getSession: GetSessionFn, getSupabase: GetSupabaseFn, scopedRepo: string | null)`. The types `GetSessionFn` and `GetSupabaseFn` are redeclared locally (matching temporal-tools.ts pattern). The `Session` import is from `neo4j-driver` (not `neo4j-driver` default export like index.ts uses `neo4j.Session`) -- this is fine because `Session` is a named export from the package.

- [x] **Duplicate temporalFilter helper** -- Lines 20-25. Exact character-for-character match with index.ts lines 94-99. Both produce the same Cypher fragments: temporal mode returns `valid_from_ts`/`valid_to_ts` range check with `$commitTs` parameter; current mode returns `valid_to IS NULL`.

- [x] **Duplicate resolveCommitTs helper** -- Lines 27-42. Functionally identical to index.ts lines 102-115. Minor formatting difference (multi-line return vs single-line) but same logic: matches Repository, resolves Commit by SHA prefix, returns timestamp or null. Cypher query is identical. Parameter names match (`repo`, `sha`).

- [x] **Implement start node resolution query** -- Lines 79-132. Cypher correctly: (1) resolves repo via `Repository` node name/url match, (2) matches `(sym:Function OR sym:Class)` with `sym.name = $name AND sym.repo_url = repoUrl`, (3) conditionally adds file filter, (4) applies temporal filter. Via RepoGraph: confirmed that Function nodes DO have `repo_url` as a direct property (verified with `query_graph`), so `sym.repo_url = repoUrl` is valid. Returns correct fields: `name`, `file_path`, `start_line`, `end_line`, `signature`, `kind` (via `labels(sym)[0]`).

- [x] **Implement disambiguation error response** -- Lines 107-117. When >1 result and no `file` param, returns `{ ok: false, error: "...", candidates: [...] }`. Candidates include `name`, `file`, `start_line`. The tool handler (lines 550-560) correctly formats this into a user-facing error message listing candidates.

- [x] **Implement upstream traversal query** -- Lines 134-172. Cypher pattern `(start)<-[rels:CALLS*1..${maxDepth}]-(caller)` correctly walks CALLS edges in reverse direction. `maxDepth` is interpolated as an integer (clamped at lines 503 to 1-15 range). Uses `tail(nodes(path))` to avoid double-filtering the start node in the temporal WHERE clause -- correct optimization. Returns `chain` (node properties) and `edges` (call_site_line) arrays. LIMIT 200 applied.

- [x] **Implement downstream traversal query** -- Lines 174-212. Mirror of upstream with forward direction `(start)-[rels:CALLS*1..${maxDepth}]->(callee)`. Same structure, same parameter passing, same LIMIT. Correct.

- [x] **Implement scope filtering** -- Lines 143-145 and 183-185. `AND ALL(n IN nodes(path) WHERE n.file_path STARTS WITH $scope)` applied when scope is provided. `$scope` is passed as a Neo4j parameter. See Issue 1 below for a design concern.

- [x] **Implement depth limiting** -- Line 503: `Math.min(Math.max(Math.round(max_depth || 10), 1), 15)` clamps depth to [1, 15]. Interpolated into Cypher as `*1..${maxDepth}`. Since `maxDepth` is guaranteed to be a positive integer, string interpolation into Cypher is safe (no injection risk).

- [x] **Implement temporal filtering** -- Lines 508-521: `at_commit` resolved via `resolveCommitTs`. If commit not found, returns error. `commitTs` passed as `$commitTs` parameter to all Cypher queries. Temporal filter applied to start node, path nodes (via `tail()`), and relationships. Via RepoGraph: confirmed CALLS edges only have `call_site_line` property (no temporal props), but the `IS NULL OR` pattern in `temporalFilter` handles this gracefully -- NULL temporal props evaluate to true, so CALLS edges pass through unfiltered.

## Stubs & Placeholders Found

None. No TODO, FIXME, or placeholder code detected.

## Broken Chains

### Issue 1: Scope filter on start node prevents valid traces
- **The chain:** User calls `trace_call_chain(start="validate", scope="src/api/")` but `validate` lives in `src/lib/validators.ts`. Expect: trace shows calls into src/api/ scope.
- **Breaks at:** Upstream/downstream Cypher scope clause (lines 143-145, 183-185): `AND ALL(n IN nodes(path) WHERE n.file_path STARTS WITH $scope)` -- this includes the start node in the ALL() check.
- **Evidence:** `nodes(path)` returns all nodes including the start node. If start node file_path does not start with `$scope`, the entire path is excluded.
- **Impact:** When start function is outside the specified scope, zero results are returned silently. The plan's Flow 3 implies out-of-scope nodes should be "noted as scope_exits" not excluded.
- **Fix:** Change to `ALL(n IN tail(nodes(path)) WHERE n.file_path STARTS WITH $scope)` to exclude the start node from scope filtering, OR document that scope must include the start node's directory. This is arguably a Phase 2 concern since `scope_exits` tracking is a Phase 2 tree assembly feature, but the Cypher foundation is laid here.

### Issue 2: scope_exits counter in buildTree is dead code (given current Cypher)
- **The chain:** Scope filtering in Cypher excludes all out-of-scope nodes. `buildTree` (line 271) counts `scopeExits` for nodes where `!childRaw.file_path.startsWith(scope)`.
- **Breaks at:** The counter can never increment because the Cypher query already filtered out all paths containing out-of-scope nodes.
- **Evidence:** Cypher: `ALL(n IN nodes(path) WHERE n.file_path STARTS WITH $scope)` ensures every node in every returned path is in-scope. buildTree line 271: `if (scope && !childRaw.file_path.startsWith(scope)) scopeExits++` -- this condition is impossible to satisfy.
- **Impact:** `scope_exits` in stats will always be 0. The feature described in the plan (Flow 3: "out-of-scope callers noted as scope_exits") does not work.
- **Fix:** To properly implement scope_exits, remove the scope clause from Cypher entirely and instead handle scope in the tree assembler (Phase 2). Alternatively, change the Cypher to only scope-filter non-leaf nodes so leaf exits are visible. This is primarily a Phase 2 concern but is noted here since the Cypher foundation determines what's possible.

### Issue 3: cross_module_jumps double-counting across paths
- **The chain:** Multiple Cypher paths can share the same edge (e.g., A->B->C and A->B->D both contain the A->B edge).
- **Breaks at:** `buildTree` line 266: `crossModuleJumps++` increments for every parent-child pair in every path, even if that pair was already counted in a previous path.
- **Evidence:** The `nodeMap` deduplicates nodes (line 281) and prevents duplicate children (line 301), but `crossModuleJumps` is incremented before the dedup check. If paths share common prefixes, the same cross-module jump is counted multiple times.
- **Impact:** `cross_module_jumps` stat will be inflated. Not a correctness issue for the tree structure itself.
- **Fix:** Move the cross-module increment inside the `if (!childNode)` block (after line 282), or track counted pairs in a Set. This is a Phase 2 stats concern.

## Missing Configuration

- None. All imports (`McpServer`, `z`, `Session`, `SupabaseClient`) resolve to packages already in `package.json`. The `tsconfig.json` includes the `src` directory. No new environment variables needed.

## Summary

Phase 1 Core Query Layer is functionally complete with all 10 checklist items implemented. The file compiles against existing dependencies, the registration function signature matches the established pattern, both `temporalFilter` and `resolveCommitTs` are faithful duplicates, and the Cypher queries use correct node labels, property names, and relationship types (verified against the live Neo4j graph). Three issues found, all in the scope/stats area: (1) scope filtering applies to the start node which can silently zero-out results, (2) the `scope_exits` counter is dead code because Cypher pre-filters scope, and (3) `cross_module_jumps` double-counts shared path segments. Issues 2 and 3 are Phase 2 stats concerns. Issue 1 affects the Cypher foundation and should be addressed before Phase 2 -- the simplest fix is changing `nodes(path)` to `tail(nodes(path))` in the scope clause, mirroring the pattern already used for temporal filtering. No stubs, no missing imports, no broken execution chains in the core query logic.
