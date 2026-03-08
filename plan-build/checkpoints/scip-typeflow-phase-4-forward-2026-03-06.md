# Phase 4 Forward Plan Review
**Phase completed:** CALLS Edge Extraction & Edge Enrichment
**Date:** 2026-03-06
**Plan updates needed:** YES

## Actual Interfaces Built

### calls-extractor.ts (NEW)

**Imports:**
- `ParsedSymbol` from `../parser.js`
- `ScipDocument`, `SymbolRole` from `./parser.js`
- `SymbolTableEntry`, `buildContainingFunctionIndex`, `findContainingFunction` from `./symbol-table.js`
- `CallsEdge` from `./types.js`

**Exports:**
```ts
export function extractCallsEdges(
  scipDocuments: ScipDocument[],
  symbolTable: Map<string, SymbolTableEntry>,
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): CallsEdge[]
```

### edge-enricher.ts (NEW)

**Imports:**
- `SymbolTableEntry` from `./symbol-table.js`
- `CallsEdge` from `./types.js`
- `DirectlyImportsEdge` from `../resolver.js`

**Exports:**
```ts
export function enrichCallsEdges(
  callsEdges: CallsEdge[],
  symbolTable: Map<string, SymbolTableEntry>
): void   // mutates in place

export function enrichDirectImports(
  directImports: DirectlyImportsEdge[],
  symbolTable: Map<string, SymbolTableEntry>,
  repoPath: string
): void   // mutates in place
```

### node-enricher.ts (Phase 3, but contains diagnostic logic planned for Phase 4)

The plan called for a separate `scip/diagnostics.ts` with `collectDiagnostics()`. Instead, diagnostic collection was folded into `node-enricher.ts`:

```ts
export function enrichSymbols(
  table: Map<string, SymbolTableEntry>
): void   // mutates ParsedSymbol in place

export function attachDiagnostics(
  scipDocuments: ScipDocument[],
  table: Map<string, SymbolTableEntry>,
  repoPath: string
): DiagnosticInfo[]   // also mutates ParsedSymbol.typeErrors in place
```

---

## Mismatches with Plan

### 1. extractCallsEdges signature differs from plan

**Plan (Contract 6):**
```
extractCallsEdges(occurrences: ScipOccurrence[], symbolTable: Map, parsedSymbols: ParsedSymbol[])
```

**Actual:**
```ts
extractCallsEdges(scipDocuments: ScipDocument[], symbolTable: Map<string, SymbolTableEntry>, parsedSymbols: ParsedSymbol[], repoPath: string)
```

- First arg is `ScipDocument[]` not `ScipOccurrence[]`. This is consistent with how `parser.ts` returns data -- occurrences are nested per-document, and the function iterates `doc.occurrences` internally. The orchestrator should pass `scipIndexData.documents` directly.
- Extra `repoPath: string` parameter is required for converting absolute file paths to relative.

**Impact on Phase 5:** The orchestrator must pass `scipIndexData.documents` and `repoPath` rather than a flattened occurrence array.

### 2. No separate diagnostics.ts file

**Plan (Phase 4 checklist):** Create `scip/diagnostics.ts` with `collectDiagnostics(scipDiagnostics, symbolTable) -> DiagnosticInfo[]`.

**Actual:** Diagnostic collection lives in `node-enricher.ts` as `attachDiagnostics(scipDocuments, table, repoPath) -> DiagnosticInfo[]`. The signature takes `ScipDocument[]` (not flattened diagnostics) and `repoPath`.

**Impact on Phase 5:** The orchestrator should import `attachDiagnostics` from `./node-enricher.js`, not from a `./diagnostics.js` module.

### 3. enrichCallsEdges does arity-only mismatch detection

**Plan (Contract 10):** "Use SCIP diagnostics at the call site as the authoritative mismatch signal."

**Actual:** `enrichCallsEdges` only checks arity mismatch (`argTypes.length !== paramTypes.length`). It does not correlate SCIP diagnostics to call sites. This is acceptable for v1 since `argTypes` is currently never populated by `extractCallsEdges` (no SCIP arg-type extraction logic exists), so the mismatch check effectively only fires if some future code populates `argTypes`.

**Impact:** Low for v1. The mismatch path is structurally wired but mostly dormant until arg-type extraction is added.

### 4. enrichCallsEdges looks up callees by relative path but extractCallsEdges already outputs relative paths

`extractCallsEdges` converts file paths to relative (stripping `repoPath` prefix). `enrichCallsEdges` builds its lookup key from `entry.parsed.filePath` which is **absolute** (ParsedSymbol.filePath is absolute per parser.ts convention). So the lookup key `${relPath}::${entry.parsed.name}` in `enrichCallsEdges` uses the **absolute** filePath from `entry.parsed`, but the edge's `calleeFilePath` is **relative**.

**This is a bug.** The `entryByName` map is keyed by absolute paths, but `edge.calleeFilePath` is relative. The lookup `entryByName.get(calleeKey)` will never match.

**Fix required before Phase 5:** Either:
- (a) `enrichCallsEdges` must strip `repoPath` from `entry.parsed.filePath` (needs `repoPath` param added), or
- (b) `extractCallsEdges` should store absolute paths (but this conflicts with what the loader expects).

Option (a) is correct -- add `repoPath: string` as a third parameter to `enrichCallsEdges`.

### 5. enrichDirectImports repoPath handling

`enrichDirectImports` correctly strips `repoPath` from symbol table entries' absolute paths when building the `signatureByName` map. It then looks up `edge.targetFilePath` which comes from `resolver.ts` -- this is also a relative path (relative to repoPath per the resolver). So this lookup **should work correctly** as long as the relative paths are consistent.

### 6. ScipStageResult includes enrichedDirectImports but plan Contract 1 does not

**Plan (Contract 1) output:**
```
{ enrichedSymbols, callsEdges, diagnostics, stats, skipped }
```

**Actual ScipStageResult (types.ts):**
```ts
{ enrichedSymbols, callsEdges, enrichedDirectImports, diagnostics, stats, skipped }
```

The actual type adds `enrichedDirectImports: DirectlyImportsEdge[]`. This is correct and needed -- `enrichDirectImports()` mutates them with `resolvedType`, and the orchestrator needs to pass them back to digest.ts so the loader can write `resolved_type` on DIRECTLY_IMPORTS edges.

**Impact on Phase 5:** The orchestrator must include `enrichedDirectImports` in the result. `digest.ts` must use the enriched direct imports when calling `loadImportsToNeo4j`.

---

## Hook Points for Next Phase

### Phase 5 must create: `packages/backend/src/pipeline/scip/index.ts`

The orchestrator `runScipStage()` needs to call the following functions in order:

#### 1. Cache check
```ts
import { checkCache, cacheIndex, getScipOutputPath, cleanupScipOutput } from "./cache.js";
// checkCache(repoUrl: string, commitSha: string): string | null
// getScipOutputPath(jobId: string): string
// cacheIndex(repoUrl: string, commitSha: string, indexPath: string): void
// cleanupScipOutput(outputPath: string): void
```

#### 2. Runner
```ts
import { isScipAvailable, runScipTypescript } from "./runner.js";
// isScipAvailable(): Promise<boolean>
// runScipTypescript(repoPath: string, outputPath: string, timeoutMs?: number): Promise<ScipRunResult>
// ScipRunResult = { success: boolean, indexPath: string, durationMs: number, error?: string }
```

#### 3. Parser
```ts
import { parseScipIndex } from "./parser.js";
// parseScipIndex(indexPath: string): ScipIndexData
// ScipIndexData = { documents: ScipDocument[], externalSymbols: ScipSymbolInfo[] }
```

#### 4. Symbol table
```ts
import { buildSymbolTable } from "./symbol-table.js";
// buildSymbolTable(scipDocuments: ScipDocument[], parsedSymbols: ParsedSymbol[], repoPath: string):
//   { table: Map<string, SymbolTableEntry>, unmatchedCount: number }
```

#### 5. Node enrichment
```ts
import { enrichSymbols, attachDiagnostics } from "./node-enricher.js";
// enrichSymbols(table: Map<string, SymbolTableEntry>): void  (mutates ParsedSymbol in place)
// attachDiagnostics(scipDocuments: ScipDocument[], table: Map<string, SymbolTableEntry>, repoPath: string): DiagnosticInfo[]
```

#### 6. CALLS extraction
```ts
import { extractCallsEdges } from "./calls-extractor.js";
// extractCallsEdges(scipDocuments: ScipDocument[], symbolTable: Map<string, SymbolTableEntry>,
//   parsedSymbols: ParsedSymbol[], repoPath: string): CallsEdge[]
```

#### 7. Edge enrichment
```ts
import { enrichCallsEdges, enrichDirectImports } from "./edge-enricher.js";
// enrichCallsEdges(callsEdges: CallsEdge[], symbolTable: Map<string, SymbolTableEntry>): void
//   ^^^ BUG: needs repoPath param added to fix absolute/relative path mismatch
// enrichDirectImports(directImports: DirectlyImportsEdge[], symbolTable: Map<string, SymbolTableEntry>, repoPath: string): void
```

#### 8. Types
```ts
import { ScipStageInput, ScipStageResult, ScipStats, CallsEdge, DiagnosticInfo } from "./types.js";
```

### Phase 5: Orchestrator call sequence

```ts
export async function runScipStage(input: ScipStageInput): Promise<ScipStageResult> {
  // 1. Check if any .ts/.tsx files exist in input.allFiles
  // 2. Check scip-typescript availability: isScipAvailable()
  // 3. Cache check: checkCache(input.repoUrl, input.commitSha)
  // 4. If miss: runScipTypescript(input.repoPath, getScipOutputPath(input.jobId))
  // 5. parseScipIndex(indexPath)
  // 6. buildSymbolTable(indexData.documents, input.allSymbols, input.repoPath)
  // 7. enrichSymbols(table)
  // 8. extractCallsEdges(indexData.documents, table, input.allSymbols, input.repoPath)
  // 9. enrichCallsEdges(callsEdges, table)  // needs fix: add repoPath
  // 10. enrichDirectImports(input.directImports, table, input.repoPath)
  // 11. attachDiagnostics(indexData.documents, table, input.repoPath)
  // 12. cacheIndex(input.repoUrl, input.commitSha, indexPath) if not cached
  // 13. cleanupScipOutput(outputPath)
  // 14. Return ScipStageResult
}
```

### Phase 5: digest.ts wiring

Current pipeline stages in `runDigest()`:
1. Clone (line 158-175)
2. Scan (line 208-233)
3. Parse (line 236-263)
4. Resolve (line 265-268) -- **SCIP must be inserted BEFORE this**
5. Deps (line 271-274)
6. Load (line 277-339)

The SCIP stage call should go between Parse (after line 263) and Resolve (line 265):

```ts
// After Parse, before Resolve:
await updateJobStage(job.id, "scip");
const scipResult = await runScipStage({
  repoPath: scanPath,
  repoUrl: req.url,
  jobId: job.id,
  commitSha,
  allFiles,
  allSymbols,
  allExports,
  directImports: [], // DI edges don't exist yet -- Resolve creates them
});
// allSymbols are already mutated in place by enrichSymbols
```

**Critical issue:** `ScipStageInput.directImports` needs `DirectlyImportsEdge[]` but these are created by `resolveImports()` which runs AFTER the SCIP stage. The plan says SCIP runs between Parse and Resolve.

**Resolution options:**
- (a) Run `enrichDirectImports` as a post-Resolve step (after resolve, before load), not inside `runScipStage`. This means `ScipStageResult.enrichedDirectImports` is not populated by the stage itself.
- (b) Move SCIP stage to after Resolve. This contradicts the plan but is simpler.
- (c) Split SCIP into two passes: main SCIP processing before Resolve, then edge enrichment after Resolve.

**Recommendation:** Option (c) is cleanest. The orchestrator should export two functions:
- `runScipStage()` -- runs Phases 2-4 minus `enrichDirectImports`
- Or just call `enrichDirectImports` directly in `digest.ts` after Resolve completes.

### Phase 5: loader.ts additions needed

1. **New function `loadCallsToNeo4j(repoUrl, callsEdges)`:** Batch MERGE CALLS edges. CallsEdge fields map to Neo4j properties:
   - `callerFilePath` -> match Function by `file_path` + `name`
   - `callerName` -> match Function by `name`
   - `calleeFilePath`, `calleeName` -> same pattern for callee
   - `callSiteLine` -> `r.call_site_line`
   - `argTypes` -> `r.arg_types`
   - `hasTypeMismatch` -> `r.has_type_mismatch`
   - `typeMismatchDetail` -> `r.type_mismatch_detail`

   Note: CallsEdge file paths are **relative** (stripped of repoPath prefix by calls-extractor). The loader's existing Cypher matches on `file_path` which stores paths as returned by scanner.ts. Must verify these are the same format (both relative to repo root).

2. **Modify `loadSymbolsToNeo4j`:** Add SET clauses for `resolved_signature`, `param_types`, `return_type`, `type_errors`, `is_generic`, `type_params` on Function and Class nodes. The ParsedSymbol objects are already mutated in place, so the batch mapping just needs new fields.

3. **Modify `loadImportsToNeo4j`:** Add `resolved_type` to the DIRECTLY_IMPORTS SET clause. The `DirectlyImportsEdge.resolvedType` field already exists on the interface (resolver.ts line 32).

4. **New function `purgeCallsEdges(repoUrl)` or modify `purgeImportEdges`:** Delete CALLS edges on re-digest. Per plan issue "Missing Source: CALLS Edge Purge on Re-Digest".

---

## Recommended Plan Updates

### 1. FIX REQUIRED: enrichCallsEdges absolute/relative path mismatch (Bug)

`enrichCallsEdges` builds lookup keys using `entry.parsed.filePath` (absolute), but `CallsEdge.calleeFilePath` is relative. The function needs a `repoPath` parameter to strip the prefix. Without this fix, type mismatch detection on CALLS edges will silently never match.

**Suggested fix:** Change signature to:
```ts
export function enrichCallsEdges(
  callsEdges: CallsEdge[],
  symbolTable: Map<string, SymbolTableEntry>,
  repoPath: string   // <-- add this
): void
```
And strip `repoPrefix` from `entry.parsed.filePath` when building `entryByName`.

### 2. UPDATE PLAN: No separate diagnostics.ts

Remove `scip/diagnostics.ts` from the Phase 4 checklist. Diagnostic collection is handled by `attachDiagnostics()` in `node-enricher.ts`. Phase 5 orchestrator should import from `./node-enricher.js`.

### 3. UPDATE PLAN: extractCallsEdges takes ScipDocument[] not ScipOccurrence[]

Contract 6 should be updated to reflect the actual signature. The orchestrator passes `scipIndexData.documents` not a flattened occurrence array.

### 4. RESOLVE: directImports timing issue

`ScipStageInput` includes `directImports: DirectlyImportsEdge[]`, but Resolve (which creates these) runs after SCIP. Phase 5 must either:
- Pass empty `directImports` to `runScipStage` and call `enrichDirectImports` separately after Resolve, OR
- Move SCIP stage to after Resolve

The recommended approach is to call `enrichDirectImports` as a standalone step in `digest.ts` after `resolveImports()` completes, passing the symbol table from the SCIP result. This means `runScipStage` should also return the `symbolTable` (or `enrichDirectImports` should be callable from `digest.ts` directly).

### 5. VERIFY: File path format consistency

`extractCallsEdges` produces relative paths by stripping `repoPath` prefix. The loader matches `Function` nodes by `file_path`. Need to verify that `ParsedSymbol.filePath` (which gets written to Neo4j as `file_path`) uses the same relative format, or that the loader handles the conversion. Currently `ParsedSymbol.filePath` is **absolute** and `loadSymbolsToNeo4j` writes it as-is to `fn.file_path`. So CallsEdge relative paths will NOT match Neo4j `file_path` values.

**This is a second path-format bug.** Either:
- `extractCallsEdges` should use absolute paths (matching what's in Neo4j), OR
- The loader's `loadCallsToNeo4j` must convert relative to absolute before matching.

**Recommendation:** Have `extractCallsEdges` store absolute paths (remove the repoPrefix stripping), matching the convention used everywhere else in the pipeline.
