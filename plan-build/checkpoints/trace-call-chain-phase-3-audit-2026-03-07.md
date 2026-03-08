# Phase 3 Final Audit
**Phase:** Wiring and Integration (Final)
**Date:** 2026-03-07
**Status:** PASS

## Verified Connections

- [x] **Import in index.ts (line 11)** — `import { registerCallChainTools } from "./call-chain-tools.js"` uses correct `.js` ESM extension, matches the pattern of runtime-tools.js (line 9) and temporal-tools.js (line 10).
- [x] **Registration call in index.ts (line 1213)** — `registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO)` passes the same four arguments as `registerRuntimeTools` (line 1207) and `registerTemporalTools` (line 1210). Argument order and types match the `registerCallChainTools` signature `(server: McpServer, getSession: GetSessionFn, _getSupabase: GetSupabaseFn, scopedRepo: string | null)`.
- [x] **Export/import alignment** — `call-chain-tools.ts` exports `registerCallChainTools` as a named export (line 437). `index.ts` imports it as a named import (line 11). No default export mismatch.
- [x] **TypeScript compiles** — `npx tsc --noEmit` passes with zero errors.
- [x] **Start node resolution (lines 79-132)** — Resolves by name + repo, optional file disambiguation. Returns structured error with candidate list when ambiguous (>1 match, no file param). Returns "not found" error when zero matches.
- [x] **Repo not found error (lines 540-549)** — Separate repo URL resolution query returns error if no Repository node matches.
- [x] **at_commit not found error (lines 520-531)** — `resolveCommitTs` returns null when commit SHA not found, handler returns descriptive error message.
- [x] **Upstream traversal (lines 134-167)** — Cypher uses `(start)<-[rels:CALLS*1..${maxDepth}]-(caller)` with temporal filters on relationships and nodes. LIMIT 200 applied.
- [x] **Downstream traversal (lines 169-202)** — Mirror of upstream with `(start)-[rels:CALLS*1..${maxDepth}]->(callee)`. LIMIT 200 applied.
- [x] **scope parameter flow** — `scope` is accepted as a tool parameter (line 472), destructured in handler (line 498), passed to `traverseUpstream`/`traverseDownstream` (lines 587, 600), and passed to `buildTree` (lines 590, 603). Scope filtering is applied in `buildTree` at line 257 (`childRaw.file_path.startsWith(scope)`), which stops traversal beyond the scope boundary and increments `scope_exits`. This is correct application-level filtering.
- [x] **include_external parameter** — Accepted as tool parameter (line 479), checked at lines 607-609. When false (default), `filterExternal` (lines 621-627) recursively removes nodes where `is_external === true`. External detection at lines 287-289 checks for `node_modules` in file_path or `PackageExport` kind.
- [x] **Tree assembly (lines 206-346)** — Merges paths into a ChainNode tree with deduplication via `nodeKey` (file::name). NODE_CAP of 500 enforced. Cross-module jumps counted when consecutive nodes differ in file_path. Entry points and leaves correctly marked based on direction.
- [x] **Response formatting (lines 350-424)** — ASCII tree with connectors, call site line annotations, [entry point]/[leaf]/[external] tags. Stats section includes total_nodes, max_depth_reached, cross_module_jumps, scope_exits, truncated.
- [x] **Session cleanup** — `session.close()` called in `finally` block (lines 614-616), ensuring cleanup on both success and error paths.
- [x] **max_depth clamping (line 514)** — Clamped to range [1, 15] with `Math.min(Math.max(...), 15)`.
- [x] **No unused imports** — All four imports (McpServer, z, Session, SupabaseClient) are used. `SupabaseClient` is used in the `GetSupabaseFn` type alias.
- [x] **_getSupabase underscore convention** — The Supabase parameter is prefixed with `_` (line 439) since this tool only uses Neo4j, not Supabase. This is correct TypeScript convention for intentionally unused parameters.

## Minor Observations (not blocking)

1. **Unused Cypher parameters**: `scope` is passed in the Cypher parameter objects at lines 160 and 195 (`{ name: startName, filePath: startFilePath, repoUrl, scope, commitTs }`) but `$scope` is never referenced in the Cypher query strings. Neo4j silently ignores unused parameters, so this is harmless but slightly untidy. Not a bug.

2. **Duplicated helpers**: `temporalFilter` (lines 20-25) and `resolveCommitTs` (lines 27-42) are duplicated from index.ts, matching the established pattern in temporal-tools.ts. This is a deliberate design decision documented in the build plan (Issue 1).

## Broken Chains

None found.

## Summary

The `trace_call_chain` tool is fully wired end-to-end. The import chain from `index.ts` to `call-chain-tools.ts` is correct with proper ESM `.js` extensions. The registration call passes the same four arguments used by the two existing tool registration functions. The tool handles all specified error paths (repo not found, function not found, disambiguation, at_commit not found). The `scope` parameter correctly flows from tool registration through the handler to `buildTree` where it performs application-level path-prefix filtering. The `include_external` flag correctly gates the `filterExternal` post-processing step. TypeScript compiles cleanly with zero errors. The feature is complete and ready to ship.
