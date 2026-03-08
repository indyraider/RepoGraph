# SCIP TypeFlow Phase 5 Audit — Pipeline Integration & Loader Extensions

**Date:** 2026-03-06
**Phase:** 5 — Pipeline Integration & Loader Extensions
**Files audited:**
- `packages/backend/src/pipeline/scip/index.ts` (NEW)
- `packages/backend/src/pipeline/digest.ts` (MODIFIED)
- `packages/backend/src/pipeline/loader.ts` (MODIFIED)

**Context files read:**
- `packages/backend/src/pipeline/scip/types.ts`
- `packages/backend/src/pipeline/scip/runner.ts`
- `packages/backend/src/pipeline/scip/cache.ts`
- `packages/backend/src/pipeline/scip/parser.ts`
- `packages/backend/src/pipeline/scip/symbol-table.ts`
- `packages/backend/src/pipeline/scip/node-enricher.ts`
- `packages/backend/src/pipeline/scip/calls-extractor.ts`
- `packages/backend/src/pipeline/scip/edge-enricher.ts`
- `packages/backend/src/pipeline/parser.ts` (ParsedSymbol interface)
- `packages/backend/src/pipeline/resolver.ts` (DirectlyImportsEdge interface)
- `packages/backend/src/pipeline/scanner.ts` (ScannedFile interface)
- `packages/backend/src/config.ts` (scip config)

---

## EXECUTION CHAINS

### 1. Does runScipStage() call all Phase 2-4 functions in the correct order?

**PASS.** The call order in `scip/index.ts` is:
1. `isScipAvailable()` (Phase 2 — runner)
2. `checkCache()` (Phase 2 — cache)
3. `runScipTypescript()` (Phase 2 — runner) — only on cache miss
4. `parseScipIndex()` (Phase 2 — parser)
5. `buildSymbolTable()` (Phase 3 — symbol-table)
6. `enrichSymbols()` (Phase 3 — node-enricher)
7. `attachDiagnostics()` (Phase 3 — node-enricher)
8. `extractCallsEdges()` (Phase 4 — calls-extractor)
9. `enrichCallsEdges()` (Phase 4 — edge-enricher)
10. `cacheIndex()` (Phase 2 — cache) — only on fresh run

This matches the plan's Flow 1 (steps 9-19) exactly. `enrichDirectImports` is deliberately excluded from `runScipStage` because it must run after the Resolve stage — correctly deferred to digest.ts.

### 2. Does it handle all failure paths (SCIP unavailable, runner failure, parse failure)?

**PASS with one BUG (see below).** Three failure paths exist:

- **SCIP disabled** (line 49): returns `makeSkippedResult` with status `"skipped"`.
- **No TS files** (line 57): returns `makeSkippedResult` with status `"skipped_no_ts"`.
- **scip-typescript not installed** (line 64): returns `makeSkippedResult` with status `"skipped"`.
- **Runner failure** (line 83-88): returns `makeSkippedResult` with status derived from error string. Also calls `cleanupScipOutput`.
- **Parse failure** (line 98-103): try/catch returns `makeSkippedResult` with status `"failed"`. Also cleans up output if not from cache.

**BUG — Timeout status misclassification:**
- `runner.ts:76` sets `error: "timeout after ${timeoutMs}ms"` (a descriptive string)
- `index.ts:84` checks `runResult.error === "timeout"` (an exact string match)
- These will NEVER match. Timeouts will be reported as `"failed"` instead of `"timeout"`.
- **Fix:** Either change runner.ts to set `error: "timeout"` or change index.ts to use `runResult.error?.startsWith("timeout")`.

### 3. Does it correctly return skipped results with original symbols unchanged?

**PASS.** `makeSkippedResult` (lines 11-34) returns:
- `enrichedSymbols: input.allSymbols` — the original array, unmutated
- `callsEdges: []` — empty array
- `enrichedDirectImports: input.directImports` — passthrough
- `skipped: true`

Since `enrichSymbols` mutates in place and is never called on the skip path, the original symbols remain untouched.

### 4. Does digest.ts call runScipStage at the right point (after Parse, before Resolve)?

**PASS.** In digest.ts:
- Parse stage: lines 240-267 (populates `allSymbols`, `allImports`, `allExports`)
- SCIP stage: lines 269-288 (calls `runScipStage` — between Parse and Resolve)
- Resolve stage: line 293 (calls `resolveImports`)

This matches the plan exactly: "Add SCIP stage call between Parse and Resolve (after line 263)".

### 5. Does digest.ts call enrichDirectImports after resolveImports?

**PASS.** Lines 296-298: `enrichDirectImports(resolveResult.directImports, scipSymbolTable)` is called after `resolveImports()` on line 293, and only when SCIP was not skipped and a symbol table exists. This is correct — directImports are produced by Resolve, then enriched by SCIP.

### 6. Does loadCallsToNeo4j correctly MATCH caller/callee nodes?

**PASS.** The Cypher in `loader.ts:549-560`:
```cypher
MATCH (caller {name: c.caller_name, file_path: c.caller_file, repo_url: $repoUrl})
WHERE caller:Function OR caller:Class
MATCH (callee {name: c.callee_name, file_path: c.callee_file, repo_url: $repoUrl})
WHERE callee:Function OR callee:Class
MERGE (caller)-[r:CALLS]->(callee)
```

This correctly matches by `name + file_path + repo_url` and restricts to Function/Class labels. The plan (Contract 7) specified only `:Function` but the implementation also handles `:Class` (constructors) — this is a correct enhancement since `calls-extractor.ts:40` explicitly includes class targets.

**Note:** Using a label-free MATCH with a WHERE for label is slightly less performant than a label-bound MATCH (e.g., `MATCH (caller:Function {…})`) since Neo4j can't use label-specific indexes. However, since it needs to check both Function and Class, this approach avoids duplicating the query. Acceptable for v1.

### 7. Does purgeCallsEdges delete the right edges?

**PASS.** `purgeCallsEdges` (loader.ts:574-586):
```cypher
MATCH (caller {repo_url: $repoUrl})-[r:CALLS]->()
WHERE caller:Function OR caller:Class
DELETE r
```
This deletes all outgoing CALLS edges from Function/Class nodes belonging to the repo. Correct scope.

### 8. Are the new SET clauses on Function/Class nodes correct?

**PASS.** Function nodes (loader.ts:112-116):
```
SET fn.resolved_signature, fn.param_types, fn.return_type, fn.is_generic, fn.type_params
```
Maps from `ParsedSymbol.resolvedSignature`, `paramTypes`, `returnType`, `isGeneric`, `typeParams` via the batch `.map()` on lines 99-103. Uses `|| null` fallback for undefined values.

Class nodes (loader.ts:146-148):
```
SET c.resolved_signature, c.is_generic, c.type_params
```
Excludes `param_types` and `return_type` (classes don't have these). Correct per plan.

**Minor observation:** `type_errors` is NOT written to Neo4j nodes. The plan (Contract 8) lists `fn.type_errors = s.type_errors` but the implementation omits it. `typeErrors` is populated by `attachDiagnostics` on `ParsedSymbol`, but the loader doesn't write it. This is a **deliberate omission** — storing an array of objects in Neo4j is awkward and the diagnostics are already returned separately. But it does mean `get_type_info` (Phase 6) won't be able to query `sym.type_errors` from Neo4j. Worth noting for Phase 6.

---

## DATA FLOW

### 1. Does ScipStageInput get all required fields from digest.ts?

**PASS.** Digest.ts lines 272-281 passes:
- `repoPath: scanPath` — absolute path to the cloned/local repo
- `repoUrl: req.url` — the repo URL
- `jobId: job.id` — Supabase job ID
- `commitSha` — from clone or local git
- `allFiles` — from scanner
- `allSymbols` — from parser
- `allExports` — from parser
- `directImports: []` — empty, populated after Resolve

All required fields from `ScipStageInput` (types.ts:39-48) are provided. The `directImports: []` is intentional — enrichment happens post-Resolve.

### 2. Do file paths in CallsEdge match the file_path property on Function/Class nodes in Neo4j?

**PASS.** Tracing the chain:
- `ParsedSymbol.filePath` is set from `ScannedFile.path` (which is a relative path within the repo)
- `calls-extractor.ts:60` sets `callerFilePath: caller.filePath` and `calleeFilePath: target.parsed.filePath` — both from ParsedSymbol
- `loadSymbolsToNeo4j` maps `file_path: s.filePath` (same source)
- `loadCallsToNeo4j` maps `caller_file: e.callerFilePath` and `callee_file: e.calleeFilePath`

All use the same relative path from `ParsedSymbol.filePath`. The MATCH will find the right nodes.

### 3. Is the symbolTable correctly passed from runScipStage to enrichDirectImports?

**PASS.** `runScipStage` returns `symbolTable` as an extra field on the result (index.ts:45,166). Digest.ts captures it on line 282: `scipResult.symbolTable`. Line 297 passes it to `enrichDirectImports(resolveResult.directImports, scipSymbolTable)`.

The return type is `ScipStageResult & { symbolTable?: Map<string, SymbolTableEntry> }` — the `symbolTable` is only present on success (undefined when skipped). Digest.ts guards with `if (scipSymbolTable && !scipResult.skipped)` on line 296.

---

## EDGE CASES

### 1. What happens on re-digest (incremental)? Are CALLS edges purged and reloaded?

**PASS.** In the incremental path (digest.ts:325-357):
- Line 353: `await purgeCallsEdges(req.url)` — purges all CALLS edges for the repo
- Line 354: `callsEdgeCount = await loadCallsToNeo4j(req.url, callsEdges)` — reloads from scratch

In the full purge path (digest.ts:359-377):
- Line 361: `await purgeRepoFromNeo4j(req.url)` — DETACH DELETE removes all nodes and edges
- Line 373: `callsEdgeCount = await loadCallsToNeo4j(req.url, callsEdges)` — loads fresh

Both paths correctly handle CALLS edges.

### 2. What happens if SCIP is skipped? Are callsEdges an empty array (not loaded)?

**PASS.** When skipped, `scipResult.callsEdges` is `[]` (from `makeSkippedResult`). Digest.ts line 283: `let callsEdges: CallsEdge[] = scipResult.callsEdges` captures it. `loadCallsToNeo4j` (loader.ts:531) returns 0 immediately for empty arrays: `if (callsEdges.length === 0) return 0`. No edges are written.

### 3. Does the full purge path (purgeRepoFromNeo4j) also delete CALLS edges?

**PASS.** `purgeRepoFromNeo4j` (loader.ts:443-445):
```cypher
MATCH (r:Repository {url: $url})-[*]->(n)
DETACH DELETE n
```
This traverses all paths from Repository: `Repository -> File -> Function/Class`. `DETACH DELETE` removes all relationships from those nodes before deleting them, which includes CALLS edges (Function->Function). The repo node itself is then deleted on line 449-451.

**Note:** The `[*]` traversal is unbounded depth. Since CALLS edges create paths `Repository -> File -> Function -[:CALLS]-> Function`, `n` includes callees that might belong to the same repo. Since `DETACH DELETE` removes all relationships, CALLS edges between Function nodes within the repo are fully covered.

---

## BUGS FOUND

### BUG 1 (Medium): Timeout status misclassification

**File:** `packages/backend/src/pipeline/scip/index.ts:84`
**Issue:** `runResult.error === "timeout"` will never match because `runner.ts:76` sets the error to `"timeout after ${timeoutMs}ms"`.
**Impact:** Timeout failures will be reported with `scipStatus: "failed"` instead of `"timeout"` in stats. The pipeline still handles the failure correctly (returns skipped result), but stats/logging will be inaccurate.
**Fix:** Change `runner.ts:76` to `error: "timeout"`, or change `index.ts:84` to `runResult.error?.startsWith("timeout")`.

### BUG 2 (Low): SCIP stats not merged into digest job stats

**File:** `packages/backend/src/pipeline/digest.ts:387-405`
**Issue:** The `stats` object written to `digest_jobs.stats` in Supabase does not include any SCIP stats (e.g., `scipStatus`, `callsEdgeCount`, `scipDurationMs`). The plan (Phase 5 checklist) says "Merge SCIP stats into digest_jobs.stats".
**Impact:** SCIP stage performance and status data is not persisted anywhere. Only console logs contain this info.
**Fix:** Spread `scipResult.stats` into the stats object: `...scipResult.stats` alongside the existing stats.

### BUG 3 (Low): type_errors not written to Neo4j nodes

**File:** `packages/backend/src/pipeline/loader.ts:90-122`
**Issue:** `ParsedSymbol.typeErrors` is populated by `attachDiagnostics` but is NOT included in the SET clause for Function or Class nodes. The plan (Contract 8) specifies `fn.type_errors = s.type_errors`.
**Impact:** Phase 6 MCP tools (`get_type_info`, `get_symbol`) won't be able to query `sym.type_errors` from Neo4j. The diagnostics exist in the stage result but never reach the graph.
**Note:** This may be intentional — Neo4j doesn't handle arrays of objects well. If so, the plan should be updated. If Phase 6 needs this data, it will need to be serialized (e.g., JSON string) or stored differently.

---

## OBSERVATIONS (non-blocking)

### 1. enrichedDirectImports field on ScipStageResult is dead data

`ScipStageResult.enrichedDirectImports` just passes through `input.directImports` (which is always `[]` when called from digest.ts). The actual enrichment happens separately via `enrichDirectImports()` called directly from digest.ts. The field could be removed from the result type without impact.

### 2. callsEdgeCount included in total edgeCount

Digest.ts line 383: `const edgeCount = fileEdges + symbolEdges + importEdges + depEdges + callsEdgeCount`. CALLS edges are correctly included in the total edge count reported in stats.

### 3. No SCIP stats in DigestResult interface

The `DigestResult.stats` interface (digest.ts:30-49) doesn't include SCIP-related fields. Even after fixing Bug 2, the stats would be in Supabase but not in the TypeScript return type. This may require extending the interface or using a generic `Record<string, unknown>` for extra stats.

### 4. Performance: label-free MATCH in loadCallsToNeo4j

The Cypher uses `MATCH (caller {name: …})` without a label, then filters with `WHERE caller:Function OR caller:Class`. This prevents Neo4j from using label-specific indexes. For large repos with many CALLS edges, this could be slow. Consider running two separate batches (one for Function, one for Class) if performance becomes an issue.

---

## VERDICT

**Phase 5 is structurally sound.** The orchestrator correctly wires all Phase 2-4 components, digest.ts integrates the SCIP stage at the right point in the pipeline, and the loader correctly handles CALLS edges with proper purge-and-reload semantics for both incremental and full digest paths.

**One medium bug (timeout status misclassification) should be fixed before Phase 6.** The two low-priority bugs (stats not persisted, type_errors not in graph) should be addressed but are not blockers for Phase 6 MCP work — Phase 6 can query the existing type properties (resolved_signature, param_types, return_type) and CALLS edges without needing type_errors or persisted SCIP stats.
