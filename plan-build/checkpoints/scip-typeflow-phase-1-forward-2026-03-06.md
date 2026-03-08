# SCIP Type Flow -- Phase 1 Forward Check

**Date:** 2026-03-06
**Phase completed:** Phase 1 -- Foundation (types, config, interfaces)
**Remaining phases:** 2 (SCIP Runner & Parser), 3 (Symbol Table & Node Enrichment), 4 (CALLS Edges & Edge Enrichment), 5 (Pipeline Integration & Loader), 6 (MCP Tool Updates), 7 (Testing)

---

## 1. Interface Extraction -- What Was Actually Built

### 1A. `scip/types.ts` (NEW)
**Path:** `packages/backend/src/pipeline/scip/types.ts`

Imports from:
- `ParsedSymbol`, `ParsedExport` from `../parser.js`
- `DirectlyImportsEdge` from `../resolver.js`
- `ScannedFile` from `../scanner.js`

**`DiagnosticInfo`** (exported interface)
| Field | Type |
|---|---|
| `severity` | `"error" \| "warning" \| "info"` |
| `code` | `string` |
| `message` | `string` |
| `filePath` | `string` |
| `line` | `number` |

**`CallsEdge`** (exported interface)
| Field | Type |
|---|---|
| `callerFilePath` | `string` |
| `callerName` | `string` |
| `calleeFilePath` | `string` |
| `calleeName` | `string` |
| `callSiteLine` | `number` |
| `argTypes?` | `string[]` |
| `hasTypeMismatch?` | `boolean` |
| `typeMismatchDetail?` | `string` |

**`ScipStats`** (exported interface)
| Field | Type |
|---|---|
| `scipStatus` | `"success" \| "skipped" \| "failed" \| "timeout" \| "cache_hit" \| "skipped_no_ts"` |
| `scipDurationMs` | `number` |
| `scipSymbolCount` | `number` |
| `scipOccurrenceCount` | `number` |
| `scipDiagnosticCount` | `number` |
| `unmatchedScipSymbols` | `number` |
| `callsEdgeCount` | `number` |
| `reason?` | `string` |

**`ScipStageInput`** (exported interface)
| Field | Type |
|---|---|
| `repoPath` | `string` |
| `repoUrl` | `string` |
| `jobId` | `string` |
| `commitSha` | `string` |
| `allFiles` | `ScannedFile[]` |
| `allSymbols` | `ParsedSymbol[]` |
| `allExports` | `ParsedExport[]` |
| `directImports` | `DirectlyImportsEdge[]` |

**`ScipStageResult`** (exported interface)
| Field | Type |
|---|---|
| `enrichedSymbols` | `ParsedSymbol[]` |
| `callsEdges` | `CallsEdge[]` |
| `enrichedDirectImports` | `DirectlyImportsEdge[]` |
| `diagnostics` | `DiagnosticInfo[]` |
| `stats` | `ScipStats` |
| `skipped` | `boolean` |

### 1B. `parser.ts` (MODIFIED)
**Path:** `packages/backend/src/pipeline/parser.ts`

**`ParsedSymbol`** -- added optional SCIP fields:
| New Field | Type |
|---|---|
| `resolvedSignature?` | `string` |
| `paramTypes?` | `string[]` |
| `returnType?` | `string` |
| `typeErrors?` | `Array<{ severity: string; code: string; message: string; line: number }>` |
| `isGeneric?` | `boolean` |
| `typeParams?` | `string[]` |

### 1C. `resolver.ts` (MODIFIED)
**Path:** `packages/backend/src/pipeline/resolver.ts`

**`DirectlyImportsEdge`** -- added optional field:
| New Field | Type |
|---|---|
| `resolvedType?` | `string` |

### 1D. `config.ts` (MODIFIED)
**Path:** `packages/backend/src/config.ts`

**`config.scip`** -- new section:
| Key | Type | Default | Env Var |
|---|---|---|---|
| `enabled` | `boolean` | `true` (unless `SCIP_ENABLED=false`) | `SCIP_ENABLED` |
| `timeoutMs` | `number` | `300000` | `SCIP_TIMEOUT_MS` |
| `maxMemoryMb` | `number` | `4096` | `SCIP_MAX_MEMORY_MB` |

---

## 2. Mismatch Detection -- Plan vs. Actual

### Contract 1: ScipStageInput / ScipStageResult

**Plan says IN:**
```
{ repoPath, jobId, commitSha, allFiles, allSymbols, allExports }
```

**Actual ScipStageInput has:**
```
{ repoPath, repoUrl, jobId, commitSha, allFiles, allSymbols, allExports, directImports }
```

| Finding | Severity | Detail |
|---|---|---|
| ADDITION: `repoUrl` | Info (good) | Needed by loader for Neo4j node matching. Plan omitted but implementation correctly added it. |
| ADDITION: `directImports` | Info (good) | Needed by edge enricher (Contract 9, enriching DIRECTLY_IMPORTS edges). Plan omitted from Contract 1 IN, but Contract 9 requires it. Implementation correctly threads it through. |

**Plan says OUT:**
```
{ enrichedSymbols, callsEdges, diagnostics, stats, skipped }
```

**Actual ScipStageResult has:**
```
{ enrichedSymbols, callsEdges, enrichedDirectImports, diagnostics, stats, skipped }
```

| Finding | Severity | Detail |
|---|---|---|
| ADDITION: `enrichedDirectImports` | Info (good) | Plan Contract 9 requires enriched DI edges with `resolved_type`. Implementation correctly returns them from the stage so the loader can use them. Plan omitted from Contract 1 OUT but the data must flow somewhere. |

**Verdict: No blocking mismatches.** The additions are correct forward-looking decisions that close gaps the plan left implicit.

### Contract 5: Node Enricher -> ParsedSymbol Mutation

**Plan says ParsedSymbol gains:**
```
resolved_signature?, param_types?, return_type?, type_errors?: DiagnosticInfo[], is_generic?, type_params?
```

**Actual ParsedSymbol has:**
```
resolvedSignature?, paramTypes?, returnType?, typeErrors?: Array<{ severity: string; code: string; message: string; line: number }>, isGeneric?, typeParams?
```

| Finding | Severity | Detail |
|---|---|---|
| Naming convention: camelCase vs. snake_case | WATCH | Plan uses `snake_case` names (e.g. `resolved_signature`), implementation uses `camelCase` (e.g. `resolvedSignature`). This is correct for TypeScript conventions. The loader (Phase 5) must translate camelCase to snake_case Neo4j property names in the SET clause. Phase 5 builder must be aware of this. |
| `typeErrors` shape differs from `DiagnosticInfo` | MISMATCH | Plan says `type_errors?: DiagnosticInfo[]` where `DiagnosticInfo` has `{ severity, code, message, filePath, line }`. Actual `typeErrors` on ParsedSymbol is `Array<{ severity: string; code: string; message: string; line: number }>` -- it omits `filePath` and uses `string` for severity instead of the union type. This is a reasonable simplification (filePath is redundant on a symbol that already has filePath), but the node-enricher (Phase 3) must populate this inline shape, NOT the `DiagnosticInfo` interface. |

**Verdict: One watch item on naming, one minor shape mismatch on typeErrors.** Neither is blocking, but Phase 3 (node-enricher) must use the inline type, not `DiagnosticInfo`.

### Contract 6: CALLS Edge Extractor -> CallsEdge

**Plan says CallsEdge:**
```
{ callerFilePath, callerName, calleeFilePath, calleeName, callSiteLine, argTypes? }
```

**Actual CallsEdge has:**
```
{ callerFilePath, callerName, calleeFilePath, calleeName, callSiteLine, argTypes?, hasTypeMismatch?, typeMismatchDetail? }
```

| Finding | Severity | Detail |
|---|---|---|
| ADDITION: `hasTypeMismatch?`, `typeMismatchDetail?` | Info (good) | Plan Contract 10 says the edge enricher populates these before the loader. Implementation puts them directly on CallsEdge rather than as a separate enrichment layer. This simplifies the pipeline -- the edge enricher (Phase 4) can set them in place rather than needing a separate data structure. |

**Verdict: No blocking mismatches.** The additions align with Contract 10 requirements and simplify wiring.

### Contract 9: DirectlyImportsEdge resolved_type

**Plan says:** `DirectlyImportsEdge gains optional resolved_type field.`

**Actual:** `DirectlyImportsEdge` now has `resolvedType?: string`

| Finding | Severity | Detail |
|---|---|---|
| Naming: `resolvedType` (camelCase) vs `resolved_type` (snake_case) | WATCH | Same convention issue. Loader must map `resolvedType` -> `resolved_type` in Cypher SET. |

**Verdict: No blocking mismatch.**

### Config Values

**Plan says:** `scip.timeout`, `scip.maxMemoryMb`, `scip.enabled`

**Actual:** `scip.timeoutMs`, `scip.maxMemoryMb`, `scip.enabled`

| Finding | Severity | Detail |
|---|---|---|
| Config key: `timeoutMs` vs `timeout` | WATCH | Plan says `scip.timeout`, implementation uses `scip.timeoutMs`. The `Ms` suffix is clearer. Phase 2 (runner.ts) must import `config.scip.timeoutMs`, not `config.scip.timeout`. |

**Verdict: No blocking mismatch.** The `Ms` suffix is an improvement.

### "scip" Stage in updateJobStage

**Plan Phase 1 says:** `Add "scip" to the stage enum in updateJobStage()`

**Actual:** `updateJobStage()` takes a plain `string` parameter (line 58 of digest.ts: `stage: string`). There is no enum to extend.

| Finding | Severity | Detail |
|---|---|---|
| No enum exists | NOT NEEDED | `updateJobStage` accepts any string. Phase 5 can simply call `updateJobStage(job.id, "scip")` with no interface changes needed. This checklist item is effectively already satisfied by the existing loose typing. |

---

## 3. Dependency Readiness -- What Phase 2 Needs

Phase 2 creates: `scip/runner.ts`, `scip/parser.ts`, `scip/cache.ts`

### runner.ts will need:

| What | Import Path | Fields Used |
|---|---|---|
| `config.scip.timeoutMs` | `../../config.js` | `config.scip.timeoutMs` (number, default 300000) |
| `config.scip.maxMemoryMb` | `../../config.js` | `config.scip.maxMemoryMb` (number, default 4096) |
| `config.scip.enabled` | `../../config.js` | `config.scip.enabled` (boolean, default true) |
| `config.tempDir` | `../../config.js` | `config.tempDir` (string, default "/tmp/repograph") |

runner.ts does NOT need any types from `scip/types.ts`. It returns its own result shape (success, indexPath, durationMs, error). Plan Contract 2 defines this; the orchestrator (Phase 5) will adapt it.

### parser.ts (scip/parser.ts) will need:

| What | Import Path | Notes |
|---|---|---|
| `@sourcegraph/scip` | External package | Must be installed (`npm install @sourcegraph/scip`). Plan checklist item. |

parser.ts returns raw SCIP data (ScipSymbol[], ScipOccurrence[], ScipDiagnostic[]) per Contract 3. These are SCIP library types, not from `scip/types.ts`. The mapping to `DiagnosticInfo` happens later (Phase 4, diagnostics.ts).

### cache.ts will need:

| What | Import Path | Fields Used |
|---|---|---|
| `config.tempDir` | `../../config.js` | For cache directory: `{tempDir}/scip-cache/{hash}/{sha}.scip` |

### Package dependencies for Phase 2:

| Package | Status | Action Required |
|---|---|---|
| `@sourcegraph/scip` | NOT INSTALLED | `npm install @sourcegraph/scip` in packages/backend |
| `scip-typescript` (CLI) | NOT INSTALLED | `npm install -g @sourcegraph/scip-typescript` or document as prerequisite |

---

## 4. Dependency Readiness -- What Phases 3-7 Need from Phase 1

### Phase 3 (Symbol Table & Node Enrichment) needs:

| Interface | Import Path | Key Fields |
|---|---|---|
| `ParsedSymbol` (with new fields) | `../parser.js` | All SCIP fields: `resolvedSignature`, `paramTypes`, `returnType`, `typeErrors`, `isGeneric`, `typeParams` |
| `DiagnosticInfo` | `./types.js` | `severity`, `code`, `message`, `filePath`, `line` |

Note: `typeErrors` on `ParsedSymbol` uses an inline type `Array<{ severity: string; code: string; message: string; line: number }>`, NOT `DiagnosticInfo`. Phase 3's node-enricher must populate the inline shape.

### Phase 4 (CALLS Edges & Edge Enrichment) needs:

| Interface | Import Path | Key Fields |
|---|---|---|
| `CallsEdge` | `./types.js` | All fields including `hasTypeMismatch`, `typeMismatchDetail` |
| `DiagnosticInfo` | `./types.js` | For diagnostics collector |
| `DirectlyImportsEdge` | `../resolver.js` | Including `resolvedType` for edge enrichment |
| `ParsedSymbol` | `../parser.js` | `startLine`, `endLine`, `filePath`, `name` for containing-function lookup |

### Phase 5 (Pipeline Integration & Loader) needs:

| Interface | Import Path | Key Fields |
|---|---|---|
| `ScipStageInput` | `./scip/types.js` | Full interface to construct input |
| `ScipStageResult` | `./scip/types.js` | Full interface to destructure output |
| `CallsEdge` | `./scip/types.js` | For `loadCallsToNeo4j()` |
| `config.scip.enabled` | `../../config.js` | Gate the SCIP stage |

**Loader naming translation needed:**
- `resolvedSignature` -> `resolved_signature`
- `paramTypes` -> `param_types`
- `returnType` -> `return_type`
- `typeErrors` -> `type_errors`
- `isGeneric` -> `is_generic`
- `typeParams` -> `type_params`
- `resolvedType` -> `resolved_type` (on DI edges)
- `callerFilePath` -> `caller_file` (on CALLS edges, per Contract 7 Cypher)
- `callerName` -> `caller_name`
- `calleeFilePath` -> `callee_file`
- `calleeName` -> `callee_name`
- `callSiteLine` -> `call_site_line`
- `argTypes` -> `arg_types`
- `hasTypeMismatch` -> `has_type_mismatch`
- `typeMismatchDetail` -> `type_mismatch_detail`

### Phase 6 (MCP Tool Updates) needs:

No direct imports from Phase 1 types. MCP tools read from Neo4j using snake_case property names. The translation happens in the loader (Phase 5).

---

## 5. Summary of Findings

### Blocking Issues: NONE

### Watch Items (must be handled correctly in later phases):

| # | Item | Affected Phase | Detail |
|---|---|---|---|
| W1 | camelCase -> snake_case translation | Phase 5 (Loader) | All new ParsedSymbol fields and CallsEdge fields use camelCase in TS but must be written as snake_case Neo4j properties. |
| W2 | `typeErrors` inline type vs. `DiagnosticInfo` | Phase 3 (Node Enricher) | ParsedSymbol.typeErrors uses `Array<{ severity: string; code: string; message: string; line: number }>`, not `DiagnosticInfo`. The enricher must build this shape. |
| W3 | Config key `timeoutMs` not `timeout` | Phase 2 (Runner) | Plan references `scip.timeout` but actual config key is `scip.timeoutMs`. |
| W4 | `@sourcegraph/scip` not yet installed | Phase 2 (Parser) | Must run `npm install @sourcegraph/scip` before Phase 2 can begin. |
| W5 | `scip-typescript` CLI not yet installed | Phase 2 (Runner) | Must install globally or document as prerequisite. Runner must handle not-installed case gracefully. |

### Positive Deviations (implementation improved on plan):

| # | Item | Detail |
|---|---|---|
| P1 | `repoUrl` on ScipStageInput | Correctly added; needed for Neo4j matching in loader. |
| P2 | `directImports` on ScipStageInput | Correctly threaded through; needed for Contract 9 edge enrichment. |
| P3 | `enrichedDirectImports` on ScipStageResult | Correctly returns enriched DI edges; plan left the return path implicit. |
| P4 | `hasTypeMismatch` / `typeMismatchDetail` on CallsEdge | Consolidated into CallsEdge directly instead of a separate enrichment struct, simplifying pipeline wiring. |
| P5 | `timeoutMs` config name | Clearer than `timeout` since the value is in milliseconds. |

---

## 6. Phase 2 Quick-Start Checklist

Before writing any Phase 2 code:
- [ ] `cd packages/backend && npm install @sourcegraph/scip`
- [ ] Verify `scip-typescript` is available: `npx scip-typescript --version` or `scip-typescript --version`

Phase 2 files to create:
1. `packages/backend/src/pipeline/scip/runner.ts` -- imports `config` from `../../config.js`
2. `packages/backend/src/pipeline/scip/parser.ts` -- imports `@sourcegraph/scip`
3. `packages/backend/src/pipeline/scip/cache.ts` -- imports `config` from `../../config.js`

No Phase 1 interfaces are consumed by Phase 2 modules directly (runner/parser/cache are self-contained). The Phase 1 types become critical starting in Phase 3.
