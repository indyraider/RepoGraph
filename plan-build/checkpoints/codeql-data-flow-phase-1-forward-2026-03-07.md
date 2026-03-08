# Forward Checkpoint: CodeQL Data Flow — Phase 1
**Date:** 2026-03-07
**Phase completed:** Phase 1 — Types + Config + Runner
**Remaining phases:** 2 (SARIF Parser + Node Matcher), 3 (Loader + Orchestrator), 4 (Digest Wiring), 5 (MCP Tools), 6 (Existing Tool Enrichment)

---

## 1. Interface Extraction — What Was Actually Built

### 1.1 `packages/backend/src/pipeline/codeql/types.ts`

| Export | Kind | Signature / Shape |
|---|---|---|
| `CodeQLLanguageConfig` | interface | `{ language: string; querySuite: string; extensions: string[]; label: string }` |
| `CodeQLStageInput` | interface | `{ repoPath: string; repoUrl: string; jobId: string; commitSha: string; detectedLanguages: string[] }` |
| `CodeQLStageResult` | interface | `{ stats: CodeQLStats; skipped: boolean }` |
| `CodeQLStats` | interface | `{ codeqlStatus: "success" \| "partial" \| "failed" \| "skipped" \| "timeout"; codeqlDurationMs: number; findingCount: number; flowEdgeCount: number; unmatchedLocations: number; queriesRun: string[]; reason?: string; error?: string }` |
| `CodeQLLocation` | interface | `{ file: string; line: number; column: number }` |
| `CodeQLPathStep` | interface | `{ location: CodeQLLocation; message: string }` |
| `CodeQLFinding` | interface | `{ queryId: string; severity: "error" \| "warning" \| "note"; message: string; source: CodeQLLocation; sink: CodeQLLocation; pathSteps: CodeQLPathStep[] }` |
| `MatchedFinding` | interface | `extends CodeQLFinding { sourceNodeId: string \| null; sinkNodeId: string \| null; pathComplete: boolean }` |
| `CodeQLRunResult` | interface | `{ success: boolean; durationMs: number; error?: string }` |

### 1.2 `packages/backend/src/pipeline/codeql/runner.ts`

| Export | Kind | Signature |
|---|---|---|
| `getCodeQLConfigsForLanguages` | function | `(languages: string[]) => CodeQLLanguageConfig[]` |
| `isCodeQLAvailable` | function | `() => Promise<boolean>` |
| `createCodeQLDatabase` | function | `(repoPath: string, dbOutputDir: string, language: string, timeoutMs?: number) => Promise<CodeQLRunResult>` |
| `runCodeQLAnalysis` | function | `(dbPath: string, sarifOutputPath: string, querySuite: string, timeoutMs?: number) => Promise<CodeQLRunResult>` |
| `cleanupCodeQLDatabase` | function | `(dbPath: string) => Promise<void>` |
| `getCodeQLDbPath` | function | `(jobId: string, language: string) => string` |
| `getSarifOutputPath` | function | `(jobId: string, language: string) => string` |

**Non-exported internals:**
- `configRegistry` — `Map<string, CodeQLLanguageConfig>` (private, maps `"typescript"`, `"tsx"`, `"javascript"` to the JS config)

### 1.3 `packages/backend/src/config.ts` (codeql section)

```typescript
codeql: {
  enabled: process.env.CODEQL_ENABLED === "true",  // opt-in
  timeoutMs: parseInt(process.env.CODEQL_TIMEOUT_MS || "900000", 10),  // 15 min
  maxDiskMb: parseInt(process.env.CODEQL_MAX_DISK_MB || "2048", 10),
}
```

**Env vars consumed:**
| Env Var | Default | Usage |
|---|---|---|
| `CODEQL_ENABLED` | `false` (opt-in via `=== "true"`) | Gates entire CodeQL pipeline |
| `CODEQL_TIMEOUT_MS` | `900000` (15 min) | Timeout for runner subprocesses |
| `CODEQL_MAX_DISK_MB` | `2048` | Declared in config but **not yet referenced by any runner code** |

---

## 2. Mismatch Detection — Plan vs. Actual

### 2.1 `CodeQLStats` Field Names — MISMATCH

**Plan (Contract 7 / Wiring Checklist) expects:**
```
{ status, durationMs, findingCount, flowEdgeCount, unmatchedLocations, queriesRun, error? }
```

**Actual `CodeQLStats` uses:**
```
{ codeqlStatus, codeqlDurationMs, findingCount, flowEdgeCount, unmatchedLocations, queriesRun, reason?, error? }
```

| Plan field | Actual field | Status |
|---|---|---|
| `status` | `codeqlStatus` | **RENAMED** — consumers in Phases 3-6 must use `codeqlStatus` |
| `durationMs` | `codeqlDurationMs` | **RENAMED** — consumers must use `codeqlDurationMs` |
| `error` | `error` | Match |
| (not in plan) | `reason` | **ADDED** — extra optional field, no downstream issue |

**Impact:** Phase 3 (Orchestrator) builds the stats object. Phase 4 (Digest Wiring) writes it to `digest_jobs.stats.codeql`. Phase 5 (MCP Tools, Issue 4) reads `status` to display "CodeQL last ran." All these phases must use `codeqlStatus` / `codeqlDurationMs` instead of `status` / `durationMs`.

**Severity: MEDIUM.** The plan's prose and Contract 7 reference `status` and `durationMs` — builders of Phases 3-6 will write the wrong field names if they follow the plan text literally. Either:
- (A) Rename the fields back to `status` / `durationMs` to match the plan (since the `CodeQLStats` type is already nested under a `codeql` key in the stats JSON, the `codeql` prefix is redundant), or
- (B) Update the plan text for Phases 3-6 to use the actual field names.

**Recommendation: Option A** — rename to `status` / `durationMs`. The type is already scoped by its name `CodeQLStats` and by the `codeql` key in the digest stats JSON (`stats.codeql.status`). Prefixing fields with `codeql` inside a `CodeQLStats` type is redundant and diverges from the plan.

### 2.2 `CodeQLStats.status` — Extra Value `"partial"`

**Plan expects:** `"success" | "failed" | "skipped" | "timeout"`
**Actual:** `"success" | "partial" | "failed" | "skipped" | "timeout"`

`"partial"` is not in the plan. This is an addition, not a removal, so it won't break anything but downstream consumers (Phase 5 MCP tools, Phase 4 stats display) should be aware this value can appear.

**Severity: LOW.** No breakage, but Phase 5 should handle displaying `"partial"` status.

### 2.3 SARIF File Path — MISMATCH

**Plan (Contract 3) expects:**
```
/tmp/repograph-jobs/{jobId}/results.sarif
```

**Actual `getSarifOutputPath()` produces:**
```
{config.tempDir}/codeql-jobs/{jobId}/{language}-results.sarif
```
Which resolves to: `/tmp/repograph/codeql-jobs/{jobId}/javascript-results.sarif`

This is a **better** path (language-specific, proper temp dir), but the plan text in Contract 3 is stale. Phase 2 (SARIF Parser) should use `getSarifOutputPath()` from runner.ts rather than hardcoding the plan's path.

**Severity: LOW.** Phase 2 just needs to import `getSarifOutputPath` — the function is exported and ready.

### 2.4 `CodeQLLanguageConfig.label` — ADDITION

**Plan expects:** `{ language, querySuite, extensions }`
**Actual:** `{ language, querySuite, extensions, label }` (added `label: string`)

This is an addition. No downstream breakage. Phase 2 and beyond can ignore or use the `label` field.

**Severity: NONE.**

### 2.5 `MatchedFinding` — Missing `sourceFile`, `sourceLine`, `sinkFile`, `sinkLine`

**Plan (Contract 5) expects `MatchedFinding` to have:**
```
{ queryId, severity, message,
  sourceNodeId, sinkNodeId,
  sourceFile, sourceLine, sinkFile, sinkLine,
  pathSteps, pathComplete }
```

**Actual `MatchedFinding`:**
```
extends CodeQLFinding { sourceNodeId, sinkNodeId, pathComplete }
```

The `sourceFile`, `sourceLine`, `sinkFile`, `sinkLine` fields are NOT explicit on `MatchedFinding`. However, they are **implicitly available** via `source.file`, `source.line`, `sink.file`, `sink.line` inherited from `CodeQLFinding`.

**Severity: LOW.** Phase 2 (Node Matcher) and Phase 3 (Loader) need to access source/sink locations. They exist via `finding.source.file` and `finding.sink.line` etc., not `finding.sourceFile`. The plan's flat field names are just a shorthand — the data is all there. Builders should use the nested path.

### 2.6 `config.codeql.maxDiskMb` — Unused

The plan says the runner should respect `maxDiskMb` (config flows to runner per Contract 1). The config field exists, but **no code in runner.ts references it**. The CodeQL CLI does not have a built-in disk limit flag; enforcing this would require pre-checking disk space or monitoring during execution.

**Severity: LOW.** This is a "nice to have" guard. Could be deferred. Phase 3 (Orchestrator) could check available disk before invoking the runner, or it could remain unimplemented for the initial build.

### 2.7 Env Vars — All Match

| Plan Env Var | Actual Config | Status |
|---|---|---|
| `CODEQL_ENABLED` | `process.env.CODEQL_ENABLED === "true"` | Match (opt-in) |
| `CODEQL_TIMEOUT_MS` | `process.env.CODEQL_TIMEOUT_MS \|\| "900000"` | Match |
| `CODEQL_MAX_DISK_MB` | `process.env.CODEQL_MAX_DISK_MB \|\| "2048"` | Match (but unused in runner) |

---

## 3. Dependency Readiness — What Phase 2 Needs

### Phase 2: SARIF Parser + Node Matcher

**Files to create:** `codeql/sarif-parser.ts`, `codeql/node-matcher.ts`

#### 3.1 Types Phase 2 needs from `types.ts`

| Type | Needed by | Available? |
|---|---|---|
| `CodeQLFinding` | sarif-parser.ts (return type) | YES |
| `CodeQLLocation` | sarif-parser.ts (building findings) | YES |
| `CodeQLPathStep` | sarif-parser.ts (building path steps) | YES |
| `MatchedFinding` | node-matcher.ts (return type) | YES |

All required types are exported and correctly shaped.

#### 3.2 Functions Phase 2 needs from `runner.ts`

| Function | Needed by | Available? |
|---|---|---|
| `getSarifOutputPath` | sarif-parser.ts (to know where to read SARIF from) | YES — but the parser likely receives the path as an argument rather than computing it |

Phase 2 doesn't directly depend on runner functions. The SARIF parser takes a file path argument (`parseSarif(filePath)`), and the orchestrator (Phase 3) will compute the path using `getSarifOutputPath()` and pass it in.

#### 3.3 Missing Types or Interfaces

None. All types needed for Phase 2 are present.

#### 3.4 Node Matcher Neo4j Dependency

The node matcher needs a Neo4j session to query Function nodes. The plan specifies:
```typescript
matchFindings(findings: CodeQLFinding[], repoUrl: string, session: Session): Promise<MatchedFinding[]>
```

This signature doesn't need any additional types from Phase 1. The `Session` type comes from `neo4j-driver`.

---

## 4. Summary of Action Items

### Must Fix Before Phase 2
*None.* Phase 2 can proceed with the types and runner as built.

### Should Fix Before Phase 3
1. **`CodeQLStats` field naming** — Rename `codeqlStatus` → `status` and `codeqlDurationMs` → `durationMs` in `types.ts` to match the plan and eliminate redundant prefixing. Phase 3 (Orchestrator) is the first consumer that builds this stats object. If not renamed, update the plan text for Phases 3-6 to use the actual names.

### Should Fix Before Phase 4
2. **`maxDiskMb` enforcement** — Decide whether the orchestrator should check disk space before running CodeQL, or defer this as a future enhancement.

### Non-Blocking Observations
3. `"partial"` status value is an addition — Phase 5 MCP tools should display it.
4. SARIF path differs from plan Contract 3 text — builders should use `getSarifOutputPath()`, not hardcode.
5. `MatchedFinding` uses nested `source.file` / `sink.line` instead of flat `sourceFile` / `sinkLine` — builders should use the actual nested paths.
6. `CodeQLLanguageConfig.label` is an addition (not in plan) — harmless, useful for logging.

---

## 5. Phase 2 Kickoff Checklist

Phase 2 (SARIF Parser + Node Matcher) can begin immediately. Here is exactly what it needs:

**Imports from Phase 1:**
```typescript
// sarif-parser.ts
import { CodeQLFinding, CodeQLLocation, CodeQLPathStep } from './types.js';

// node-matcher.ts
import { CodeQLFinding, MatchedFinding } from './types.js';
```

**Function signatures to implement:**
```typescript
// sarif-parser.ts
export function parseSarif(filePath: string): Promise<CodeQLFinding[]>

// node-matcher.ts
export async function matchFindings(
  findings: CodeQLFinding[],
  repoUrl: string,
  session: Session  // from neo4j-driver
): Promise<MatchedFinding[]>
```

**No blockers. Phase 2 is ready to build.**
