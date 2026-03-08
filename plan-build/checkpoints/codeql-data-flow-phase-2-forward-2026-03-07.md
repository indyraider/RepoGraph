# Forward Check: CodeQL Data Flow — Phase 2 (SARIF Parser + Node Matcher)
**Date:** 2026-03-07
**Phase completed:** Phase 2
**Remaining phases:** 3 (Loader + Orchestrator), 4 (Digest Wiring), 5 (MCP Tools), 6 (Existing Tool Enrichment)

---

## 1. Extracted Interfaces (Actual Code)

### `parseSarif()` — sarif-parser.ts:153

```typescript
export async function parseSarif(filePath: string): Promise<CodeQLFinding[]>
```

- **Input:** `filePath: string` (path to SARIF JSON file on disk)
- **Output:** `Promise<CodeQLFinding[]>`
- **Throws:** On unreadable file or invalid JSON
- **Side effects:** Logs finding count to console
- **Deduplication:** Built-in by `queryId:source.file:source.line:sink.file:sink.line`

### `matchFindings()` — node-matcher.ts:75

```typescript
export async function matchFindings(
  findings: CodeQLFinding[],
  repoUrl: string,
  session: Session
): Promise<{ matched: MatchedFinding[]; unmatchedCount: number }>
```

- **Input:** `findings: CodeQLFinding[]`, `repoUrl: string`, `session: Session` (neo4j-driver)
- **Output:** `Promise<{ matched: MatchedFinding[]; unmatchedCount: number }>`
- **Does NOT throw on partial matches** — drops findings where both source and sink are unmatched; keeps partial matches
- **Side effects:** Logs match stats and warnings to console

### `MatchedFinding` type — types.ts:65

```typescript
export interface MatchedFinding extends CodeQLFinding {
  sourceNodeId: string | null;
  sinkNodeId: string | null;
  pathComplete: boolean;
}
```

### Runner exports available from Phase 1:

- `getCodeQLConfigsForLanguages(languages: string[]): CodeQLLanguageConfig[]`
- `isCodeQLAvailable(): Promise<boolean>`
- `createCodeQLDatabase(repoPath, dbOutputDir, language, timeoutMs?): Promise<CodeQLRunResult>`
- `runCodeQLAnalysis(dbPath, sarifOutputPath, querySuite, timeoutMs?): Promise<CodeQLRunResult>`
- `cleanupCodeQLDatabase(dbPath: string): Promise<void>`
- `getCodeQLDbPath(jobId, language): string`
- `getSarifOutputPath(jobId, language): string`

---

## 2. Mismatch Detection Against Plan

### 2.1 `parseSarif()` signature — MATCH

Plan (line 344): `parseSarif(filePath): CodeQLFinding[]`
Actual: `parseSarif(filePath: string): Promise<CodeQLFinding[]>`

The plan omits the `Promise` wrapper but that is notational shorthand. The function reads from disk with `readFile`, so async is correct and expected. The orchestrator in Phase 3 will need to `await` this call. **No action needed.**

### 2.2 `matchFindings()` signature — MISMATCH (return shape)

Plan (line 351): `matchFindings(findings, repoUrl, session): MatchedFinding[]`
Actual: `matchFindings(findings, repoUrl, session): Promise<{ matched: MatchedFinding[]; unmatchedCount: number }>`

**Two differences:**

1. **Return is a wrapper object, not a bare array.** The actual function returns `{ matched: MatchedFinding[]; unmatchedCount: number }` instead of `MatchedFinding[]`. The orchestrator must destructure: `const { matched, unmatchedCount } = await matchFindings(...)`.

2. **The `unmatchedCount` is returned alongside the array.** This is better than the plan's design because the orchestrator needs `unmatchedCount` for `CodeQLStats.unmatchedLocations` (plan line 35 of types.ts). The plan expected the orchestrator to compute this separately, but Phase 2 already provides it.

**Impact on Phase 3:** The orchestrator must use `{ matched, unmatchedCount }` destructuring. The loader receives `matched` (which is `MatchedFinding[]`), consistent with what it expects. **Low risk, simple adjustment.**

### 2.3 `MatchedFinding` shape — MATCH

Plan Contract 5 (line 109-116):
```
sourceNodeId: string | null, sinkNodeId: string | null,
sourceFile, sourceLine, sinkFile, sinkLine,
pathSteps, pathComplete: boolean
```

Actual: `MatchedFinding extends CodeQLFinding` which inherits `source: CodeQLLocation` (has `.file`, `.line`, `.column`) and `sink: CodeQLLocation`. The plan's `sourceFile/sourceLine/sinkFile/sinkLine` are accessible via `source.file`, `source.line`, `sink.file`, `sink.line`.

**Impact on Phase 3 Loader:** The loader must access `finding.source.file` and `finding.sink.file` rather than `finding.sourceFile`. This is a nested-vs-flat difference. The plan's Contract 6 Cypher template uses `source_path` and `sink_path` as Neo4j properties. The loader must map: `source_path = finding.source.file`, `sink_path = finding.sink.file`. **The loader builder just needs to know the shape is nested, not flat.**

### 2.4 Function names — MATCH

- `parseSarif` matches plan reference at line 344 and Contract 4
- `matchFindings` matches plan reference at line 351 and Contract 5
- All type names (`CodeQLFinding`, `MatchedFinding`, `CodeQLLocation`, `CodeQLPathStep`) match plan exactly

### 2.5 `CodeQLStats.status` values — MINOR DEVIATION

Plan (line 31 of contract 7): `'success' | 'failed' | 'skipped' | 'timeout'`
Actual types.ts (line 31): `'success' | 'partial' | 'failed' | 'skipped' | 'timeout'`

Phase 2 added a `'partial'` status not in the plan. This is additive and beneficial (covers the case where some languages succeed and some fail, or some findings are partially matched). **No conflict, but Phase 3 orchestrator should use it.**

### 2.6 `CodeQLStats` — MINOR DEVIATION

Plan (Contract 7): has `error?: string`
Actual types.ts: has both `reason?: string` and `error?: string`

The `reason` field is extra. Likely intended for non-error explanations (e.g., "skipped: codeql not installed"). **Additive, no conflict.**

### 2.7 Neo4j session management — OBSERVATION

`matchFindings()` takes a `Session` (from `neo4j-driver`) as a parameter. It does NOT create or close the session. The Phase 3 orchestrator is responsible for:
1. Opening a Neo4j session
2. Passing it to `matchFindings()`
3. Passing the same (or a new) session to the loader
4. Closing the session in a `finally` block

The node-matcher runs individual `session.run()` calls per unique location (not batched into a single Cypher query). For repos with many findings this could be slow, but it is functionally correct. **No interface mismatch.**

---

## 3. Dependency Readiness for Phase 3

### 3.1 Orchestrator imports needed

```typescript
// From Phase 1
import { config } from "../../config.js";
import {
  getCodeQLConfigsForLanguages,
  isCodeQLAvailable,
  createCodeQLDatabase,
  runCodeQLAnalysis,
  cleanupCodeQLDatabase,
  getCodeQLDbPath,
  getSarifOutputPath,
} from "./runner.js";
import {
  CodeQLStageInput,
  CodeQLStageResult,
  CodeQLStats,
  MatchedFinding,
} from "./types.js";

// From Phase 2
import { parseSarif } from "./sarif-parser.js";
import { matchFindings } from "./node-matcher.js";
```

All exports exist and are correctly accessible. **Ready.**

### 3.2 Loader inputs (Phase 3 — loader.ts)

The loader expects `MatchedFinding[]` per plan Contract 6. From the actual code:

- `finding.sourceNodeId` and `finding.sinkNodeId` are Neo4j element IDs (from `elementId(f)` in the Cypher query, line 20-21 of node-matcher.ts). The loader must use these with `MATCH (n) WHERE elementId(n) = $id` — NOT `MATCH (n) WHERE id(n) = $id` (deprecated in Neo4j 5).
- `finding.pathSteps` is `CodeQLPathStep[]` — the loader should `JSON.stringify()` this for the `path_steps` edge property per Contract 6.
- The loader also needs `repoUrl`, `jobId` (for DataFlowFinding nodes), and a Neo4j `Session`.

### 3.3 Missing utilities for the loader

The plan specifies (Contract 6):
- Purge old `FLOWS_TO` edges and `DataFlowFinding` nodes for the repo
- Batch create new ones
- All in a single transaction

The node-matcher uses `elementId()` to identify nodes. The loader will need to use `elementId()` for matching too:
```cypher
MATCH (src) WHERE elementId(src) = $sourceNodeId
MATCH (snk) WHERE elementId(snk) = $sinkNodeId
CREATE (src)-[:FLOWS_TO {query_id: $queryId, ...}]->(snk)
```

No additional utility imports are needed beyond `neo4j-driver` (Session/Transaction).

### 3.4 Orchestrator flow (Phase 3 — index.ts)

Based on actual interfaces, the orchestrator pseudocode is:

```typescript
export async function runCodeQLStage(input: CodeQLStageInput): Promise<CodeQLStageResult> {
  // 1. Check config.codeql.enabled
  // 2. await isCodeQLAvailable()
  // 3. getCodeQLConfigsForLanguages(input.detectedLanguages)
  // 4. For each config:
  //    a. createCodeQLDatabase(input.repoPath, getCodeQLDbPath(...), config.language)
  //    b. runCodeQLAnalysis(dbPath, getSarifOutputPath(...), config.querySuite)
  //    c. await parseSarif(sarifPath)  // returns CodeQLFinding[]
  // 5. Merge all findings from all languages
  // 6. Open Neo4j session
  // 7. const { matched, unmatchedCount } = await matchFindings(allFindings, input.repoUrl, session)
  //    ^^^ NOTE: destructure the wrapper object, not bare array
  // 8. await loadCodeQLFindings(input.repoUrl, matched, input.jobId, session)
  // 9. Build CodeQLStats, update Supabase digest_jobs
  // 10. cleanupCodeQLDatabase for each language
}
```

### 3.5 Supabase session for stats update

The orchestrator needs a Supabase client to update `digest_jobs.stats`. The plan says this uses "same Supabase service client." The orchestrator signature `runCodeQLStage(input: CodeQLStageInput)` does not include a Supabase client — either the orchestrator imports it directly, or `CodeQLStageInput` needs to be extended. Check how other pipeline stages access Supabase.

---

## 4. Risk Summary

| Item | Severity | Description |
|------|----------|-------------|
| `matchFindings` return shape | LOW | Returns `{ matched, unmatchedCount }` not bare `MatchedFinding[]`. Orchestrator must destructure. |
| Nested location shape | LOW | `source.file` not `sourceFile`. Loader must use nested access for Neo4j properties. |
| `elementId()` usage | LOW | node-matcher returns `elementId(f)` strings. Loader must use `elementId()` matching, not deprecated `id()`. |
| `partial` status value | NONE | Additive. Orchestrator can use it for multi-language partial success. |
| Supabase client access | INFO | Not part of `CodeQLStageInput`. Orchestrator needs to import or receive it. |
| Per-location Neo4j queries | INFO | node-matcher queries Neo4j once per unique location. Could be slow with many findings but is functionally correct. Can optimize later with batch Cypher. |

---

## 5. Verdict

**Phase 2 is ready for Phase 3 consumption.** The two interface deviations from the plan (wrapper return type on `matchFindings`, nested location objects) are minor and improve the design. The Phase 3 builder needs to be aware of:

1. Destructure `matchFindings()` result as `{ matched, unmatchedCount }`
2. Access locations as `finding.source.file` / `finding.sink.file` (not flat properties)
3. Use `elementId()` in loader Cypher to match the node IDs from the matcher
4. Determine how the orchestrator accesses the Supabase client for stats updates
