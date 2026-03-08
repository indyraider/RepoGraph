# SCIP TypeFlow Phase 1 Audit — Foundation

**Date:** 2026-03-06
**Phase:** Phase 1 — Foundation (types, config, interfaces)
**Verdict:** PASS with issues (2 blockers, 1 warning)

---

## Files Audited

| File | Status | Notes |
|------|--------|-------|
| `packages/backend/src/pipeline/scip/types.ts` | NEW | All required interfaces present |
| `packages/backend/src/pipeline/parser.ts` | MODIFIED | ParsedSymbol extended correctly |
| `packages/backend/src/pipeline/resolver.ts` | MODIFIED | DirectlyImportsEdge has `resolvedType?` |
| `packages/backend/src/config.ts` | MODIFIED | scip config block added |
| `packages/backend/package.json` | MODIFIED | `@sourcegraph/scip-typescript` added |

---

## Checklist Item Results

### 1. Install `@sourcegraph/scip` package — ISSUE (Wrong Package)

**Plan says:** Install `@sourcegraph/scip` (the protobuf parser for .scip index files).
**Actual:** `@sourcegraph/scip-typescript` (the CLI tool) is in `package.json` dependencies instead.

These are two different packages:
- `@sourcegraph/scip-typescript` is the CLI that **generates** .scip index files. It should be a global install or devDependency, not a runtime dependency. Phase 2's runner.ts spawns it as a child process.
- `@sourcegraph/scip` is the npm package that **parses** .scip protobuf files. Phase 2's parser.ts needs `scip.Index.decode()` from this package.

**Impact:** Phase 2 will fail — `parseScipIndex()` needs `@sourcegraph/scip` to decode protobuf, and it is not installed. Additionally, `scip-typescript` as a runtime dep is wasteful (it's a CLI tool invoked via spawn).

**Additionally:** `node_modules/@sourcegraph/` does not exist — the dependency was added to `package.json` but `npm install` was apparently not run.

**Fix:**
1. Add `@sourcegraph/scip` to `dependencies` (needed at runtime for protobuf decoding).
2. Move `@sourcegraph/scip-typescript` to `devDependencies` or remove it (it's used as a CLI via child_process.spawn, not imported).
3. Run `npm install`.

### 2. Install scip-typescript globally — NOT DONE

**Plan says:** Install `scip-typescript` globally or document as prerequisite.
**Actual:** `scip-typescript` is not on PATH (`which scip-typescript` returns not found). No documentation of this prerequisite was found.

**Impact:** Non-blocking for Phase 1 code, but the SCIP runner in Phase 2 will fail to spawn the process. Should be documented or installed before Phase 2.

### 3. Add SCIP config to config.ts — PASS

**Plan says:** `scip.timeout`, `scip.maxMemoryMb`, `scip.enabled`
**Actual (config.ts lines 29-33):**
```typescript
scip: {
  enabled: process.env.SCIP_ENABLED !== "false",   // defaults to true
  timeoutMs: parseInt(process.env.SCIP_TIMEOUT_MS || "300000", 10),  // 5 min
  maxMemoryMb: parseInt(process.env.SCIP_MAX_MEMORY_MB || "4096", 10),
},
```

- All three config values present with correct types.
- `enabled` defaults to `true` (opt-out via `SCIP_ENABLED=false`). Sensible.
- `timeoutMs` defaults to 300000 (5 minutes). Matches plan's "5-min hard timeout".
- `maxMemoryMb` defaults to 4096. Matches plan's default.
- Environment variable override works correctly for all three.
- **Note:** Plan uses name `scip.timeout` but implementation uses `scip.timeoutMs`. The `Ms` suffix is better (self-documenting units). Acceptable deviation.

### 4. Extend ParsedSymbol interface with optional type fields — PASS

**Plan says:** Add `resolved_signature?`, `param_types?`, `return_type?`, `type_errors?`, `is_generic?`, `type_params?`
**Actual (parser.ts lines 17-23):**
```typescript
// SCIP type enrichment (populated by scip stage, undefined otherwise)
resolvedSignature?: string;
paramTypes?: string[];
returnType?: string;
typeErrors?: Array<{ severity: string; code: string; message: string; line: number }>;
isGeneric?: boolean;
typeParams?: string[];
```

All six fields present. Naming uses camelCase (plan used snake_case) which is correct TypeScript convention — the loader will need to map to snake_case for Neo4j properties but that is a Phase 5 concern.

### 5. Define CallsEdge interface — PASS

**Plan says (Contract 6):** `{ callerFilePath, callerName, calleeFilePath, calleeName, callSiteLine, argTypes? }`
**Actual (scip/types.ts lines 15-24):**
```typescript
export interface CallsEdge {
  callerFilePath: string;
  callerName: string;
  calleeFilePath: string;
  calleeName: string;
  callSiteLine: number;
  argTypes?: string[];
  hasTypeMismatch?: boolean;
  typeMismatchDetail?: string;
}
```

All plan-specified fields present. Two additional fields (`hasTypeMismatch`, `typeMismatchDetail`) added proactively from Contract 10. This is good — they would be needed in Phase 4 anyway and avoids a later interface change.

### 6. Define ScipStats, DiagnosticInfo interfaces — PASS

**DiagnosticInfo (scip/types.ts lines 6-12):**
```typescript
export interface DiagnosticInfo {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  filePath: string;
  line: number;
}
```

**ScipStats (scip/types.ts lines 27-36):**
```typescript
export interface ScipStats {
  scipStatus: "success" | "skipped" | "failed" | "timeout" | "cache_hit" | "skipped_no_ts";
  scipDurationMs: number;
  scipSymbolCount: number;
  scipOccurrenceCount: number;
  scipDiagnosticCount: number;
  unmatchedScipSymbols: number;
  callsEdgeCount: number;
  reason?: string;
}
```

Both interfaces well-defined. `ScipStats.scipStatus` covers all flows from the plan (Flow 1-6). `DiagnosticInfo.severity` uses a union type instead of a raw number, which is cleaner than the SCIP protobuf's numeric severity — the parser will need to map `0|1|2|3` to `"error"|"warning"|"info"` in Phase 2.

### 7. Add "scip" to the stage enum in updateJobStage() — NOT APPLICABLE (no enum exists)

**Plan says:** Add "scip" to the stage enum.
**Actual:** `updateJobStage()` accepts `stage: string` with no validation. It simply passes the string to Supabase:
```typescript
async function updateJobStage(jobId: string, stage: string, extra?: Record<string, unknown>)
```

There is **no stage enum or validation** — any string is accepted. This means "scip" will work without any code change. The plan's checklist item assumed there was a constrained set of valid stages, but there isn't one.

**Verdict:** No action needed. When Phase 5 adds `updateJobStage(job.id, "scip")`, it will work. However, this is a missed opportunity — a union type like `type DigestStage = "cloning" | "scanning" | "parsing" | "scip" | "resolving" | "deps" | "loading"` would prevent typos.

---

## Data Flow Consistency Check

### ParsedSymbol.typeErrors vs DiagnosticInfo

**ParsedSymbol.typeErrors** (parser.ts line 21):
```typescript
typeErrors?: Array<{ severity: string; code: string; message: string; line: number }>;
```

**DiagnosticInfo** (scip/types.ts lines 6-12):
```typescript
{ severity: "error" | "warning" | "info"; code: string; message: string; filePath: string; line: number; }
```

**Issue (WARNING):** The shapes are similar but not identical:
1. `typeErrors[].severity` is `string`, but `DiagnosticInfo.severity` is `"error" | "warning" | "info"`. The node enricher in Phase 3 will populate `typeErrors` from `DiagnosticInfo[]` — the union type will narrow to `string`, so this is safe at runtime but loses type safety. Consider making `ParsedSymbol.typeErrors` use `DiagnosticInfo[]` directly or at least use the same severity union.
2. `DiagnosticInfo` has `filePath` but `typeErrors` elements do not (they are already scoped to the symbol's file). This is an intentional difference — `typeErrors` are attached per-symbol so filePath is redundant. Acceptable.

### DirectlyImportsEdge.resolvedType

Already present on the interface (resolver.ts line 32): `resolvedType?: string;`. The edge enricher in Phase 4 will populate this. Consistent with Contract 9.

### ScipStageInput / ScipStageResult

Bonus interfaces defined in scip/types.ts (lines 39-58). These were not explicitly in the Phase 1 checklist but match Contract 1 exactly:
- `ScipStageInput` matches Contract 1's IN shape.
- `ScipStageResult` matches Contract 1's OUT shape.
- `ScipStageResult` includes `enrichedDirectImports` which goes beyond the plan's Contract 1 OUT (which only listed `enrichedSymbols, callsEdges, diagnostics, stats, skipped`). This addition is consistent with Contract 9 (type properties on DIRECTLY_IMPORTS edges).

---

## Stubs and Placeholders

- No TODO/FIXME/HACK/XXX comments found in any Phase 1 file.
- No empty function bodies.
- No hardcoded values (config defaults are sourced from env vars with fallbacks).

---

## Blocker Summary

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **BLOCKER** | Wrong package: `@sourcegraph/scip-typescript` in deps instead of `@sourcegraph/scip` | Add `@sourcegraph/scip` to dependencies; move `scip-typescript` to devDependencies or remove |
| 2 | **BLOCKER** | `npm install` not run — `node_modules/@sourcegraph/` does not exist | Run `npm install` after fixing package.json |
| 3 | **WARNING** | `ParsedSymbol.typeErrors[].severity` is `string` but `DiagnosticInfo.severity` is a union type — type safety mismatch | Change `typeErrors` severity to `"error" \| "warning" \| "info"` or use `DiagnosticInfo[]` directly |

---

## Ready for Phase 2?

**No — fix blockers 1 and 2 first.** Phase 2 creates `scip/parser.ts` which imports from `@sourcegraph/scip` to decode protobuf. That package must be installed. The `scip-typescript` CLI (blocker 2 note about global install) is needed for Phase 2's runner but is a softer dependency since the stage is designed to fail-open.
